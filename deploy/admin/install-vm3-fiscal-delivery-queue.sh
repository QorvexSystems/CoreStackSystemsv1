#!/usr/bin/env bash
# Installs the reviewed durable delivery queue in PAUSED state with separate
# NOLOGIN identities. It does not configure secrets, sign XML or contact DGII.
set -euo pipefail
umask 077

readonly source_sql='/home/luismel/004_delivery_queue.sql'
readonly expected_hash='7f0f30e3612364b03c8ac45490c5149d6d84c12823ac2472dfcc75705627278c'
readonly stage='/var/lib/corestack-pki/fiscal-delivery-install-20261006'
readonly hba='/etc/postgresql/17/main/pg_hba.conf'
readonly scope="cmt397emm0002nm0ogb50l2q6|40220429126|precertification"
readonly signer='rivnu_fe_pre_signer'
readonly sender='rivnu_fe_pre_delivery'
fail() { printf '%s\n' "$1" >&2; exit 1; }
pg() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d rivnu_fiscal_pre -v ON_ERROR_STOP=1 "$@"; }
hash() { sha256sum "$1" | cut -d' ' -f1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'RUN_WITH_SUDO_ON_VM3'
[[ -f "$source_sql" && ! -L "$source_sql" && "$(hash "$source_sql")" == "$expected_hash" ]] || fail 'DELIVERY_MIGRATION_SOURCE_INVALID'
[[ -f "$hba" && ! -L "$hba" && "$(pg -Atqc 'SHOW hba_file')" == "$hba" ]] || fail 'POSTGRESQL_HBA_INVALID'
[[ ! -e "$stage" && ! -L "$stage" ]] || fail 'DELIVERY_INSTALL_ALREADY_ATTEMPTED_REVIEW_STAGE'
[[ "$(pg -Atqc "SELECT tenant_id||'|'||issuer_rnc||'|'||environment FROM fiscal_meta.issuer_scope")" == "$scope" ]] || fail 'FISCAL_SCOPE_MISMATCH'
[[ "$(pg -Atqc "SELECT count(*) FROM corestack_fiscal.schema_migration WHERE name='004_delivery_queue.sql'")" == '0' ]] || fail 'DELIVERY_MIGRATION_ALREADY_INSTALLED'
[[ "$(pg -Atqc "SELECT count(*) FROM pg_roles WHERE rolname IN ('$signer','$sender')")" == '0' ]] || fail 'DELIVERY_ROLES_ALREADY_EXIST'
[[ "$(pg -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema='corestack_fiscal' AND table_name IN ('delivery_control','outbound_artifact','delivery_job','delivery_event')")" == '0' ]] || fail 'DELIVERY_SCHEMA_ALREADY_PRESENT'
[[ "$(pg -Atqc "SELECT (SELECT count(*) FROM corestack_fiscal.sequence_range)+(SELECT count(*) FROM corestack_fiscal.sequence_reservation)+(SELECT count(*) FROM corestack_fiscal.request_snapshot)+(SELECT count(*) FROM corestack_fiscal.document)+(SELECT count(*) FROM corestack_fiscal.preparation_job)+(SELECT count(*) FROM corestack_fiscal.document_artifact)")" == '0' ]] || fail 'FISCAL_DATABASE_NOT_EMPTY'

install -d -o root -g root -m 0700 "$stage"
sudo -u postgres pg_dump -h /var/run/postgresql -p 5432 -d rivnu_fiscal_pre --format=custom >"$stage/before.dump"
pg_restore --list "$stage/before.dump" >"$stage/before.inventory"
install -o root -g root -m 0400 "$source_sql" "$stage/004_delivery_queue.sql"
cp --preserve=mode,ownership,timestamps -- "$hba" "$stage/pg_hba.conf.before"
hash "$hba" >"$stage/pg_hba.before.sha256"

hba_next=$(mktemp /etc/postgresql/17/main/.fiscal-delivery-hba.XXXXXX)
python3 - "$hba" "$hba_next" <<'PY'
import pathlib, sys
source, target = map(pathlib.Path, sys.argv[1:])
text = source.read_text(encoding='utf-8')
anchors = {
    'local all rivnu_fe_pre_runtime reject': '''local all rivnu_fe_pre_runtime reject
local all rivnu_fe_pre_signer reject
local all rivnu_fe_pre_delivery reject''',
    'hostssl rivnu_fiscal_pre rivnu_fe_pre_runtime 10.0.0.1/32 scram-sha-256': '''hostssl rivnu_fiscal_pre rivnu_fe_pre_runtime 10.0.0.1/32 scram-sha-256
hostssl rivnu_fiscal_pre rivnu_fe_pre_signer 10.0.0.1/32 scram-sha-256
hostssl rivnu_fiscal_pre rivnu_fe_pre_delivery 10.0.0.1/32 scram-sha-256''',
    'host all rivnu_fe_pre_runtime ::/0 reject': '''host all rivnu_fe_pre_runtime ::/0 reject
host all rivnu_fe_pre_signer 0.0.0.0/0 reject
host all rivnu_fe_pre_signer ::/0 reject
host all rivnu_fe_pre_delivery 0.0.0.0/0 reject
host all rivnu_fe_pre_delivery ::/0 reject''',
}
for old, new in anchors.items():
    if text.count(old) != 1:
        raise SystemExit('HBA_SCOPE_ANCHOR_INVALID')
    text = text.replace(old, new)
target.write_text(text, encoding='utf-8')
PY
chmod --reference="$hba" "$hba_next"
chown --reference="$hba" "$hba_next"
hash "$hba_next" >"$stage/pg_hba.activated.sha256"

changed_hba=false
database_committed=false
cleanup() {
  code=$?
  trap - EXIT
  if (( code != 0 )) && [[ "$changed_hba" == true && "$database_committed" == false ]]; then
    if [[ "$(hash "$hba")" == "$(<"$stage/pg_hba.activated.sha256")" ]]; then
      restore=$(mktemp /etc/postgresql/17/main/.fiscal-delivery-hba-restore.XXXXXX)
      cp --preserve=mode,ownership,timestamps -- "$stage/pg_hba.conf.before" "$restore"
      mv -T "$restore" "$hba"
      pg -Atqc 'SELECT pg_reload_conf()' >/dev/null || true
      echo 'HBA_ROLLED_BACK_DATABASE_UNCHANGED' >&2
    else
      echo 'HBA_CHANGED_CONCURRENTLY_MANUAL_REVIEW_REQUIRED' >&2
    fi
  fi
  [[ -e "$hba_next" ]] && rm -f -- "$hba_next"
  exit "$code"
}
trap cleanup EXIT

[[ "$(hash "$hba")" == "$(<"$stage/pg_hba.before.sha256")" ]] || fail 'HBA_CHANGED_DURING_STAGING'
mv -T "$hba_next" "$hba"
changed_hba=true
[[ "$(pg -Atqc "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL")" == '0' ]] || fail 'HBA_PARSE_FAILED'
[[ "$(pg -Atqc 'SELECT pg_reload_conf()')" == 't' ]] || fail 'HBA_RELOAD_FAILED'

{
  printf '%s\n' \
    'BEGIN;' \
    "CREATE ROLE $signer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;" \
    "CREATE ROLE $sender NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;" \
    "GRANT CONNECT ON DATABASE rivnu_fiscal_pre TO $signer,$sender;" \
    "ALTER ROLE $signer IN DATABASE rivnu_fiscal_pre SET search_path=pg_catalog;" \
    "ALTER ROLE $sender IN DATABASE rivnu_fiscal_pre SET search_path=pg_catalog;" \
    "ALTER ROLE $signer IN DATABASE rivnu_fiscal_pre SET statement_timeout='30s';" \
    "ALTER ROLE $sender IN DATABASE rivnu_fiscal_pre SET statement_timeout='30s';" \
    "ALTER ROLE $signer IN DATABASE rivnu_fiscal_pre SET idle_in_transaction_session_timeout='30s';" \
    "ALTER ROLE $sender IN DATABASE rivnu_fiscal_pre SET idle_in_transaction_session_timeout='30s';" \
    "SET LOCAL ROLE rivnu_fe_pre_owner;"
  sed '/^BEGIN;$/d; /^COMMIT;$/d' "$stage/004_delivery_queue.sql"
  printf '%s\n' \
    "INSERT INTO corestack_fiscal.runtime_scope SELECT '$signer',tenant_id,issuer_rnc,environment FROM fiscal_meta.issuer_scope;" \
    "INSERT INTO corestack_fiscal.runtime_scope SELECT '$sender',tenant_id,issuer_rnc,environment FROM fiscal_meta.issuer_scope;" \
    "INSERT INTO corestack_fiscal.delivery_control(tenant_id,issuer_rnc,environment,paused) SELECT tenant_id,issuer_rnc,environment,true FROM fiscal_meta.issuer_scope;" \
    "GRANT USAGE ON SCHEMA fiscal_meta,corestack_fiscal TO $signer,$sender;" \
    "GRANT SELECT ON fiscal_meta.issuer_scope TO $signer,$sender;" \
    "GRANT EXECUTE ON FUNCTION corestack_fiscal.read_preparation(bigint),corestack_fiscal.enqueue_delivery(bigint,text,text,text,text,text,text) TO $signer;" \
    "GRANT EXECUTE ON FUNCTION corestack_fiscal.claim_delivery(),corestack_fiscal.complete_delivery(bigint,uuid,text,text,jsonb),corestack_fiscal.delivery_health() TO $sender;" \
    "INSERT INTO corestack_fiscal.schema_migration(name,sha256) VALUES('004_delivery_queue.sql','$expected_hash');" \
    'COMMIT;'
} | pg
database_committed=true

[[ "$(pg -Atqc "SELECT sha256 FROM corestack_fiscal.schema_migration WHERE name='004_delivery_queue.sql'")" == "$expected_hash" ]] || fail 'DELIVERY_MIGRATION_RECORD_INVALID'
[[ "$(pg -Atqc "SELECT paused FROM corestack_fiscal.delivery_control WHERE tenant_id='cmt397emm0002nm0ogb50l2q6' AND issuer_rnc='40220429126' AND environment='precertification'")" == 't' ]] || fail 'DELIVERY_SCOPE_NOT_PAUSED'
[[ "$(pg -Atqc "SELECT string_agg(login_role::text,',' ORDER BY login_role::text) FROM corestack_fiscal.runtime_scope WHERE login_role IN ('$signer','$sender')")" == 'rivnu_fe_pre_delivery,rivnu_fe_pre_signer' ]] || fail 'DELIVERY_SCOPE_BINDING_INVALID'
echo 'FISCAL_DELIVERY_QUEUE_INSTALLED_PAUSED_IDENTITIES_NOLOGIN'
echo "Backup: $stage/before.dump"
echo 'No passwords created, no XML signed, no delivery enabled and no DGII request made.'
