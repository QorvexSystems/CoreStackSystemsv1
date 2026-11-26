#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly database='rivnu_fiscal_prod'
readonly owner='rivnu_fe_prod_owner'
readonly range_role='rivnu_fe_prod_range'
readonly runtime='rivnu_fe_prod_runtime'
readonly tenant='cmqn0r66a0002lit0vxbzq5l4'
readonly rnc='40220429126'
readonly hba='/etc/postgresql/17/main/pg_hba.conf'

fail() { printf '%s\n' "$1" >&2; exit 1; }
pg_root() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d postgres -v ON_ERROR_STOP=1 "$@"; }
pg_fiscal() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d "$database" -v ON_ERROR_STOP=1 "$@"; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'RUN_WITH_SUDO_ON_VM3'
[[ -d /var/lib/corestack-pki && ! -L /var/lib/corestack-pki && "$(stat -c '%u:%g:%a' /var/lib/corestack-pki)" == '0:0:700' ]] || fail 'PKI_STAGING_PARENT_INVALID'
[[ -f "$hba" && ! -L "$hba" && "$(pg_root -Atqc 'SHOW hba_file')" == "$hba" ]] || fail 'HBA_FILE_INVALID'

server_state=$(pg_root -Atqc "SELECT current_setting('server_version_num')||'|'||current_setting('ssl')||'|'||(SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL)")
[[ "$server_state" == 17*'|on|0' ]] || fail "POSTGRESQL_SECURITY_STATE_INVALID state=$server_state"

database_state=$(pg_root -Atqc "SELECT datname||'|'||pg_get_userbyid(datdba) FROM pg_database WHERE datname='$database'")
[[ "$database_state" == "$database|$owner" ]] || fail "FISCAL_DATABASE_STATE_INVALID state=$database_state"

role_state=$(pg_root -Atqc "SELECT string_agg(rolname||':'||rolcanlogin||':'||rolsuper||':'||rolinherit||':'||rolconnlimit,',' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('$owner','$range_role','$runtime')")
expected_role_state="$owner:false:false:true:-1,$range_role:true:false:false:4,$runtime:false:false:false:4"
[[ "$role_state" == "$expected_role_state" ]] || fail "RUNTIME_ROLE_STATE_INVALID state=$role_state"

scope_state=$(pg_fiscal -Atqc "SELECT tenant_id||'|'||issuer_rnc||'|'||environment FROM fiscal_meta.issuer_scope")
[[ "$scope_state" == "$tenant|$rnc|production" ]] || fail "FISCAL_SCOPE_INVALID state=$scope_state"

pipeline_objects=$(pg_fiscal -Atqc "SELECT count(*) FROM (VALUES
 ('corestack_fiscal.sequence_reservation'),('corestack_fiscal.runtime_scope'),
 ('corestack_fiscal.request_snapshot'),('corestack_fiscal.document'),
 ('corestack_fiscal.preparation_job'),('corestack_fiscal.signing_job'),
 ('corestack_fiscal.delivery_job')) object(name)
 WHERE to_regclass(object.name) IS NOT NULL")
[[ "$pipeline_objects" == 0 ]] || fail "PIPELINE_PARTIAL_OR_PRESENT objects=$pipeline_objects"

pipeline_migrations=$(pg_fiscal -Atqc "SELECT count(*) FROM fiscal_meta.schema_migration WHERE name IN
 ('007_production_issuance_base.sql','002_request_persistence.sql','003_preparation_worker.sql',
  '004_delivery_queue.sql','005_signing_queue.sql','008_production_pipeline_activation.sql')")
[[ "$pipeline_migrations" == 0 ]] || fail "PIPELINE_MIGRATION_ROWS_PRESENT rows=$pipeline_migrations"

runtime_hba=$(pg_root -Atqc "SELECT count(*) FROM pg_hba_file_rules WHERE '$runtime'=ANY(user_name)")
[[ "$runtime_hba" == 0 ]] || fail "RUNTIME_HBA_ALREADY_PRESENT rows=$runtime_hba"

range_state=$(pg_fiscal -Atqc "SELECT count(*)||'|'||coalesce(sum(last_number-first_number+1),0)||'|'||coalesce(sum(CASE WHEN next_number IS NULL THEN 0 ELSE last_number-next_number+1 END),0) FROM corestack_fiscal.sequence_range")

printf '%s\n' '=== FAILED STAGES RETAINED ==='
find /var/lib/corestack-pki -maxdepth 1 -mindepth 1 -type d \
  -name 'rivnu-fiscal-production-pipeline-20261102*' \
  -printf '%m|%u:%g|%f\n' | sort
printf 'POSTGRES=%s\nDATABASE=%s\nROLES=%s\nSCOPE=%s\nRANGES=count|total|remaining=%s\n' \
  "$server_state" "$database_state" "$role_state" "$scope_state" "$range_state"
printf '%s\n' 'RIVNU_VM3_FISCAL_PIPELINE_RECOVERY_AUDIT_PASSED_READ_ONLY'
printf '%s\n' 'No database, role, HBA rule, range, sequence, invoice or DGII endpoint was changed.'
