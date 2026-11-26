#!/usr/bin/env bash
# Initial migration only, run personally with sudo on VM3. No ranges or invoices.
set +x
set -euo pipefail
umask 077
readonly stage=/var/lib/corestack-pki/fiscal-persistence-install-20260921
readonly names=(001_sequence_registry.sql 002_request_persistence.sql 003_preparation_worker.sql)
readonly hashes=(0d4120eb0c557c3aae966b70881291ba90930b588d8cee757ff5ff1d24be9228 8a16593ceeff096f551500cfcdc93f9ff8000b7be506c6c6f8f595aade8f7f01 add559bcbf2b420dcd59117e17dfe38adcdab8e7f88b8944580912dd381ba638)
fail() { printf '%s\n' "$*" >&2; exit 1; }
pg() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d rivnu_fiscal_pre -v ON_ERROR_STOP=1 "$@"; }
[[ "$EUID" -eq 0 && "$(hostname)" == VM3-SQLDB ]] || fail 'Run with sudo on VM3-SQLDB.'
[[ ! -L /var/lib/corestack-pki && "$(stat -c '%u:%g:%a' /var/lib/corestack-pki)" == 0:0:700 ]] || fail 'Unsafe staging parent.'
[[ ! -e "$stage" && ! -L "$stage" ]] || fail 'Migration already attempted. Review retained state; no overwrite.'
[[ "$(pg -Atqc "SELECT count(*) FROM pg_namespace WHERE nspname='corestack_fiscal'")" == 0 ]] || fail 'Fiscal schema already exists; migration review required.'
[[ "$(pg -Atqc "SELECT tenant_id||'|'||issuer_rnc||'|'||environment FROM fiscal_meta.issuer_scope")" == 'cmt397emm0002nm0ogb50l2q6|40220429126|precertification' ]] || fail 'Wrong scope.'
[[ "$(pg -Atqc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()")" == rivnu_fe_pre_owner ]] || fail 'Wrong database owner.'
mkdir -m 0700 "$stage"
sudo -u postgres pg_dump -h /var/run/postgresql -p 5432 -d rivnu_fiscal_pre --format=custom > "$stage/pre-migration.dump"
pg_restore --list "$stage/pre-migration.dump" > "$stage/pre-migration.inventory"
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
for index in 0 1 2; do
 cp -- "$source_dir/fiscal-persistence-20260921/${names[$index]}" "$stage/${names[$index]}"
 [[ "$(sha256sum "$stage/${names[$index]}" | cut -d ' ' -f 1)" == "${hashes[$index]}" ]] || fail 'Migration checksum mismatch; database unchanged.'
done
{
 printf "BEGIN;\nSET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\nSET LOCAL ROLE rivnu_fe_pre_owner;\n"
 for file in "${names[@]}"; do
  # Fold reviewed migration files into one transaction, not nested BEGIN/COMMIT.
  sed '/^BEGIN;$/d; /^COMMIT;$/d' "$stage/$file"
 done
 printf '%s\n' \
  "INSERT INTO corestack_fiscal.runtime_scope SELECT 'rivnu_fe_pre_runtime',tenant_id,issuer_rnc,environment FROM fiscal_meta.issuer_scope;" \
  'GRANT USAGE ON SCHEMA corestack_fiscal TO rivnu_fe_pre_runtime;' \
  'GRANT EXECUTE ON FUNCTION corestack_fiscal.register_request(text,text),corestack_fiscal.claim_preparation(),corestack_fiscal.complete_preparation(bigint,uuid,text,text,text,text),corestack_fiscal.fail_preparation(bigint,uuid,text),corestack_fiscal.read_preparation(bigint) TO rivnu_fe_pre_runtime;' \
  'CREATE TABLE corestack_fiscal.schema_migration(name text PRIMARY KEY,sha256 text NOT NULL,installed_at timestamptz NOT NULL DEFAULT now());'
 for index in 0 1 2; do
  printf "INSERT INTO corestack_fiscal.schema_migration(name,sha256) VALUES('%s','%s');\n" "${names[$index]}" "${hashes[$index]}"
 done
 printf 'COMMIT;\n'
} > "$stage/install.sql"
pg < "$stage/install.sql"
pg -P pager=off -c 'SELECT name,sha256 FROM corestack_fiscal.schema_migration ORDER BY name;'
printf '\nFISCAL_PERSISTENCE_INSTALLED_NO_RANGES\nNo ERP schema changes, no e-NCF allocated, no worker started.\n'
