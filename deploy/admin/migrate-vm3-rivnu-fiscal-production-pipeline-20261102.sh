#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly database='rivnu_fiscal_prod'
readonly owner='rivnu_fe_prod_owner'
readonly runtime='rivnu_fe_prod_runtime'
readonly range_role='rivnu_fe_prod_range'
readonly tenant='cmqn0r66a0002lit0vxbzq5l4'
readonly rnc='40220429126'
readonly stage='/var/lib/corestack-pki/rivnu-fiscal-production-pipeline-20261102'
readonly hba='/etc/postgresql/17/main/pg_hba.conf'
declare -Ar source_hashes=(
  [007_production_issuance_base.sql]='e6c9a6b8714908b066bfa630cf75caa9878cae95bb919c6d03d0a937351cce46'
  [002_request_persistence.sql]='1b4bbb2dc6dcaaedb5cf5429d1ef8a961c200830bc82a950e9945365135c5e01'
  [003_preparation_worker.sql]='add559bcbf2b420dcd59117e17dfe38adcdab8e7f88b8944580912dd381ba638'
  [004_delivery_queue.sql]='2734fe13ced546309172c80e440fb6aef8fbb2100ad03a5818d56c5db2879719'
  [005_signing_queue.sql]='38956e55dab334a7b7594efd5e8e5c93ce3fc7c000774dcd57ec3596e99b9c84'
  [008_production_pipeline_activation.sql]='9ab239642c9ab771b1cc133a1038980b2279ea08e65e9378689184c6745ef2eb'
)

fail() { printf '%s\n' "$1" >&2; exit 1; }
hash_file() { sha256sum "$1" | cut -d' ' -f1; }
pg_root() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d postgres -v ON_ERROR_STOP=1 "$@"; }
pg_fiscal() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d "$database" -v ON_ERROR_STOP=1 "$@"; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'RUN_WITH_SUDO_ON_VM3'
[[ -d /var/lib/corestack-pki && ! -L /var/lib/corestack-pki && "$(stat -c '%u:%g:%a' /var/lib/corestack-pki)" == '0:0:700' ]] || fail 'PKI_STAGING_PARENT_INVALID'
[[ -f "$hba" && ! -L "$hba" && "$(pg_root -Atqc 'SHOW hba_file')" == "$hba" ]] || fail 'HBA_FILE_INVALID'
[[ "$(pg_root -Atqc 'SHOW server_version_num')" == 17* && "$(pg_root -Atqc 'SHOW ssl')" == on ]] || fail 'POSTGRESQL_17_TLS_REQUIRED'
[[ "$(pg_root -Atqc 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" == 0 ]] || fail 'EXISTING_HBA_ERRORS'
source_root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
for name in 007_production_issuance_base.sql 002_request_persistence.sql 003_preparation_worker.sql 004_delivery_queue.sql 005_signing_queue.sql 008_production_pipeline_activation.sql; do
  source_file="$source_root/packages/fiscal/sql/$name"
  [[ -f "$source_file" && ! -L "$source_file" && "$(hash_file "$source_file")" == "${source_hashes[$name]}" ]] || fail "SOURCE_INVALID_$name"
done
[[ "$(pg_root -Atqc "SELECT count(*) FROM pg_database WHERE datname='$database'")" == 1 ]] || fail 'FISCAL_DATABASE_MISSING'
[[ "$(pg_fiscal -Atqc "SELECT tenant_id||'|'||issuer_rnc||'|'||environment FROM fiscal_meta.issuer_scope")" == "$tenant|$rnc|production" ]] || fail 'FISCAL_SCOPE_MISMATCH'
[[ "$(pg_fiscal -Atqc "SELECT count(*) FROM (VALUES
 ('corestack_fiscal.sequence_reservation'),('corestack_fiscal.runtime_scope'),
 ('corestack_fiscal.request_snapshot'),('corestack_fiscal.document'),
 ('corestack_fiscal.preparation_job'),('corestack_fiscal.signing_job'),
 ('corestack_fiscal.delivery_job')) object(name)
 WHERE to_regclass(object.name) IS NOT NULL")" == 0 ]] || fail 'PIPELINE_PARTIAL_OR_PRESENT_REVIEW_REQUIRED'
[[ ! -e "$stage" && ! -L "$stage" ]] || fail 'MIGRATION_STAGE_EXISTS_REVIEW_REQUIRED'

mkdir -m 0700 "$stage"
for name in 007_production_issuance_base.sql 002_request_persistence.sql 003_preparation_worker.sql 004_delivery_queue.sql 005_signing_queue.sql 008_production_pipeline_activation.sql; do
  install -o root -g root -m 0400 "$source_root/packages/fiscal/sql/$name" "$stage/$name"
done
sudo -u postgres pg_dump -h /var/run/postgresql -p 5432 -d "$database" \
  --schema-only --no-owner --no-privileges >"$stage/before-schema.sql"
cp --preserve=mode,ownership,timestamps "$hba" "$stage/pg_hba.conf.before"

pg_root <<SQL
DO \$\$
BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='$runtime') THEN
  CREATE ROLE $runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
 END IF;
END \$\$;
GRANT CONNECT ON DATABASE $database TO $runtime;
ALTER ROLE $runtime IN DATABASE $database SET search_path=pg_catalog;
ALTER ROLE $runtime IN DATABASE $database SET statement_timeout='30s';
ALTER ROLE $runtime IN DATABASE $database SET idle_in_transaction_session_timeout='15s';
SQL
[[ "$(pg_root -Atqc "SELECT count(*) FROM pg_roles WHERE rolname='$runtime' AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit=4")" == 1 ]] || fail 'RUNTIME_ROLE_INVALID'

hba_activated=false
temporary=''
rollback_hba() {
  local result=$?
  if [[ -n "$temporary" && -f "$temporary" && ! -L "$temporary" ]]; then
    unlink -- "$temporary" || true
  fi
  if [[ "$hba_activated" == true ]]; then
    cp --preserve=mode,ownership,timestamps "$stage/pg_hba.conf.before" "$hba" || true
    pg_root -Atqc 'SELECT pg_reload_conf()' >/dev/null 2>&1 || true
  fi
  printf 'RIVNU_FISCAL_PIPELINE_INSTALL_FAILED_HBA_ROLLED_BACK status=%s stage=%s\n' "$result" "$stage" >&2
  exit "$result"
}
abort_install() { printf '%s\n' "$1" >&2; return 1; }
trap rollback_hba ERR

temporary=$(mktemp /etc/postgresql/17/main/.rivnu-fiscal-runtime-hba.XXXXXX)
{
  printf '%s\n' \
    '# CoreStack RIVNU production fiscal runtime: VM4 only.' \
    "hostssl $database $runtime 10.0.0.1/32 scram-sha-256" \
    "host all $runtime 0.0.0.0/0 reject" \
    "host all $runtime ::/0 reject" \
    '# End RIVNU production fiscal runtime block.'
  cat "$hba"
} >"$temporary"
chmod --reference="$hba" "$temporary"
chown --reference="$hba" "$temporary"
if [[ "$(hash_file "$hba")" != "$(hash_file "$stage/pg_hba.conf.before")" ]]; then
  abort_install 'HBA_CHANGED_CONCURRENTLY'
fi
mv -T "$temporary" "$hba"
hba_activated=true
if [[ "$(pg_root -Atqc 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" != 0 ]]; then
  abort_install 'HBA_INVALID'
fi
if [[ "$(pg_root -Atqc 'SELECT pg_reload_conf()')" != t ]]; then
  abort_install 'HBA_RELOAD_FAILED'
fi

install_sql="$stage/install.sql"
{
  printf 'BEGIN;\nSET LOCAL ROLE %s;\n' "$owner"
  for name in 007_production_issuance_base.sql 002_request_persistence.sql 003_preparation_worker.sql 004_delivery_queue.sql 005_signing_queue.sql 008_production_pipeline_activation.sql; do
    sed '/^BEGIN;$/d; /^COMMIT;$/d' "$stage/$name"
    printf '\n'
  done
  cat <<SQL
INSERT INTO corestack_fiscal.runtime_scope(login_role,tenant_id,issuer_rnc,environment)
VALUES('$range_role','$tenant','$rnc','production'),('$runtime','$tenant','$rnc','production');
GRANT USAGE ON SCHEMA fiscal_meta,corestack_fiscal TO $range_role,$runtime;
GRANT SELECT ON fiscal_meta.issuer_scope TO $range_role,$runtime;
GRANT EXECUTE ON FUNCTION corestack_fiscal.register_request(text,text),
 corestack_fiscal.read_authorized_ranges(),corestack_fiscal.read_document_status(bigint)
 TO $range_role;
GRANT EXECUTE ON FUNCTION corestack_fiscal.claim_preparation(),
 corestack_fiscal.complete_preparation(bigint,uuid,text,text,text,text),
 corestack_fiscal.fail_preparation(bigint,uuid,text),corestack_fiscal.read_preparation(bigint),
 corestack_fiscal.claim_signing(),corestack_fiscal.complete_signing(bigint,uuid),
 corestack_fiscal.fail_signing(bigint,uuid,text),
 corestack_fiscal.enqueue_delivery(bigint,text,text,text,text,text,text),
 corestack_fiscal.claim_delivery(),corestack_fiscal.complete_delivery(bigint,uuid,text,text,jsonb),
 corestack_fiscal.delivery_health(),corestack_fiscal.read_document_status(bigint)
 TO $runtime;
INSERT INTO fiscal_meta.schema_migration(name,sha256)
SELECT name,sha FROM (VALUES
 ('007_production_issuance_base.sql','$(sha256sum "$stage/007_production_issuance_base.sql" | cut -d' ' -f1)'),
 ('002_request_persistence.sql','$(sha256sum "$stage/002_request_persistence.sql" | cut -d' ' -f1)'),
 ('003_preparation_worker.sql','$(sha256sum "$stage/003_preparation_worker.sql" | cut -d' ' -f1)'),
 ('004_delivery_queue.sql','$(sha256sum "$stage/004_delivery_queue.sql" | cut -d' ' -f1)'),
 ('005_signing_queue.sql','$(sha256sum "$stage/005_signing_queue.sql" | cut -d' ' -f1)'),
 ('008_production_pipeline_activation.sql','$(sha256sum "$stage/008_production_pipeline_activation.sql" | cut -d' ' -f1)')
) migration(name,sha);
DO \$\$
BEGIN
  IF NOT has_function_privilege('$runtime','corestack_fiscal.claim_delivery()','EXECUTE')
     OR has_table_privilege('$runtime','corestack_fiscal.sequence_range','SELECT,INSERT,UPDATE,DELETE')
  THEN
    RAISE EXCEPTION 'runtime minimum privilege verification failed';
  END IF;
  IF (SELECT count(*) FROM corestack_fiscal.sequence_reservation)<>0
     OR (SELECT count(*) FROM corestack_fiscal.document)<>0
  THEN
    RAISE EXCEPTION 'pipeline installation changed fiscal numbering or documents';
  END IF;
END \$\$;
COMMIT;
SQL
} >"$install_sql"
chmod 0400 "$install_sql"
pg_fiscal <"$install_sql"
hba_activated=false
trap - ERR

[[ "$(pg_root -Atqc "SELECT rolcanlogin FROM pg_roles WHERE rolname='$runtime'")" == f ]] || fail 'RUNTIME_ROLE_MUST_REMAIN_NOLOGIN'
[[ "$(pg_fiscal -Atqc "SELECT has_function_privilege('$runtime','corestack_fiscal.claim_delivery()','EXECUTE') AND NOT has_table_privilege('$runtime','corestack_fiscal.sequence_range','SELECT,INSERT,UPDATE,DELETE')")" == t ]] || fail 'RUNTIME_MINIMUM_PRIVILEGE_INVALID'
[[ "$(pg_fiscal -Atqc "SELECT
 (SELECT count(*) FROM fiscal_meta.schema_migration WHERE name IN
  ('007_production_issuance_base.sql','002_request_persistence.sql','003_preparation_worker.sql',
   '004_delivery_queue.sql','005_signing_queue.sql','008_production_pipeline_activation.sql'))||'|'||
 (SELECT count(*) FROM corestack_fiscal.runtime_scope)||'|'||
 (SELECT count(*) FROM corestack_fiscal.sequence_reservation)||'|'||
 (SELECT count(*) FROM corestack_fiscal.document)")" == '6|2|0|0' ]] || fail 'PIPELINE_FINAL_STATE_INVALID'
printf 'RIVNU_FISCAL_PRODUCTION_PIPELINE_MIGRATED_RUNTIME_NOLOGIN\n'
printf 'Backup=%s\n' "$stage"
printf 'No e-NCF was reserved and no DGII request was made.\n'
