#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly database='rivnu_production'
readonly migrator='rivnu_migrator'
readonly runtime='rivnu_runtime'
readonly failed_name='20260920120000_capture_sales_fiscal_evidence'
readonly dispatch_name='20260921180000_add_fiscal_dispatch_outbox'
readonly range_name='20261031110000_electronic_fiscal_range_registration'
readonly activation_name='20261102023000_enable_production_fiscal_dispatch'
readonly failed_hash='045d70c7fbd9ffc1daf32474bf052fb039cea765e641bba03cdb3b840ca93862'
readonly dispatch_hash='1a49c477c1038120f003e764863920116a12a8ddb21121903844d8df2c771cb1'
readonly range_hash='e7050ada5046c9f51af84b75bce97f62a65c6b885850a87f91337435c6fe46dc'
readonly activation_hash='75abe2c682370eafeffd8e733b34cddb0063270a89474cb1e9a9b694dde0ad61'
readonly source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly migration_root="$source_root/packages/database/prisma/migrations"
readonly failed_sql="$migration_root/$failed_name/migration.sql"
readonly dispatch_sql="$migration_root/$dispatch_name/migration.sql"
readonly activation_sql="$migration_root/$activation_name/migration.sql"
readonly stage='/var/lib/corestack-pki/rivnu-erp-migration-recovery-20261102'

fail() { printf '%s\n' "$1" >&2; exit 1; }
hash_file() { sha256sum "$1" | cut -d' ' -f1; }
pg() {
  sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 \
    -d "$database" -v ON_ERROR_STOP=1 -P pager=off "$@"
}
emit_body() {
  awk '$0 == "BEGIN;" || $0 == "COMMIT;" { next } { print }' "$1"
}

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'RUN_WITH_SUDO_ON_VM3'
[[ -d /var/lib/corestack-pki && ! -L /var/lib/corestack-pki ]] || fail 'PKI_STAGING_PARENT_INVALID'
[[ "$(stat -c '%u:%g:%a' /var/lib/corestack-pki)" == '0:0:700' ]] || fail 'PKI_STAGING_PARENT_PERMISSIONS_INVALID'
[[ "$(pg -Atqc 'SHOW server_version_num')" == 17* ]] || fail 'POSTGRESQL_17_REQUIRED'
[[ "$(pg -Atqc 'SHOW ssl')" == on ]] || fail 'POSTGRESQL_TLS_REQUIRED'
[[ "$(pg -Atqc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()")" == "$migrator" ]] || fail 'DATABASE_OWNER_INVALID'
[[ "$(pg -Atqc "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'")" == "$migrator" ]] || fail 'PUBLIC_SCHEMA_OWNER_INVALID'
[[ "$(pg -Atqc "SELECT has_schema_privilege('$migrator','public','CREATE') AND NOT has_schema_privilege('$runtime','public','CREATE')")" == t ]] || fail 'ERP_ROLE_BOUNDARY_INVALID'
[[ "$(pg -Atqc "SELECT count(*) FROM pg_roles WHERE rolname IN ('$migrator','$runtime') AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls")" == 2 ]] || fail 'ERP_ROLES_NOT_LEAST_PRIVILEGE'

declare -A expected=(
  ["$failed_sql"]="$failed_hash"
  ["$dispatch_sql"]="$dispatch_hash"
  ["$activation_sql"]="$activation_hash"
)
for file in "${!expected[@]}"; do
  [[ -f "$file" && ! -L "$file" && "$(hash_file "$file")" == "${expected[$file]}" ]] || fail "MIGRATION_SOURCE_INVALID_$file"
done

[[ "$(pg -Atqc "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$failed_name' AND checksum='$failed_hash' AND finished_at IS NULL AND rolled_back_at IS NULL AND applied_steps_count=0 AND logs LIKE '%permission denied for schema public%'")" == 1 ]] || fail 'EXPECTED_FAILED_MIGRATION_NOT_FOUND'
[[ "$(pg -Atqc "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL AND rolled_back_at IS NULL")" == 1 ]] || fail 'UNEXPECTED_UNFINISHED_MIGRATION_STATE'
[[ "$(pg -Atqc "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$range_name' AND checksum='$range_hash' AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1")" == 1 ]] || fail 'RANGE_MIGRATION_LEDGER_INVALID'
[[ "$(pg -Atqc "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name IN ('$dispatch_name','$activation_name')")" == 0 ]] || fail 'LATER_MIGRATION_ALREADY_RECORDED_REVIEW_REQUIRED'
[[ "$(pg -Atqc "SELECT (to_regtype('public.\"FiscalItemKind\"') IS NULL) AND (to_regclass('corestack_erp_fiscal.dispatch') IS NULL)")" == t ]] || fail 'PARTIAL_MIGRATION_OBJECTS_PRESENT'
[[ "$(pg -Atqc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND ((table_name='Product' AND column_name='fiscalItemKind') OR (table_name IN ('SalesOrderItem','InvoiceItem') AND column_name IN ('originalUnitPrice','fiscalItemKind')))")" == 0 ]] || fail 'PARTIAL_FISCAL_EVIDENCE_COLUMNS_PRESENT'

readonly protected_counts="$(pg -Atqc 'SELECT (SELECT count(*) FROM "Invoice")::text||'\''|'\''||(SELECT count(*) FROM "SalesOrder")::text||'\''|'\''||(SELECT count(*) FROM "ElectronicFiscalRange")::text')"

[[ ! -L "$stage" ]] || fail 'RECOVERY_STAGE_SYMLINK_REJECTED'
if [[ -e "$stage" ]]; then
  fail 'RECOVERY_STAGE_ALREADY_EXISTS_REVIEW_REQUIRED'
fi
install -d -o root -g root -m 0700 "$stage"
install -o root -g root -m 0400 "$failed_sql" "$stage/$failed_name.sql"
install -o root -g root -m 0400 "$dispatch_sql" "$stage/$dispatch_name.sql"
install -o root -g root -m 0400 "$activation_sql" "$stage/$activation_name.sql"
sudo -u postgres pg_dump -h /var/run/postgresql -p 5432 -d "$database" --format=custom >"$stage/before.dump"
pg_restore --list "$stage/before.dump" >"$stage/before.inventory"
pg -Atqc "SELECT id,migration_name,checksum,finished_at,rolled_back_at,applied_steps_count FROM \"_prisma_migrations\" ORDER BY started_at,id" >"$stage/prisma-ledger.before"
printf '%s\n' "$protected_counts" >"$stage/protected-counts.before"
chmod 0600 "$stage/before.dump" "$stage/before.inventory" "$stage/prisma-ledger.before" "$stage/protected-counts.before"
[[ -s "$stage/before.dump" && -s "$stage/before.inventory" && -s "$stage/prisma-ledger.before" ]] || fail 'VERIFIED_BACKUP_REQUIRED'

{
  printf '%s\n' \
    'BEGIN;' \
    "SET LOCAL lock_timeout='5s';" \
    "SET LOCAL statement_timeout='120s';" \
    "SELECT pg_advisory_xact_lock(hashtextextended('rivnu:erp-migration-recovery:20261102',0));" \
    "SET LOCAL ROLE $migrator;"
  emit_body "$failed_sql"
  emit_body "$dispatch_sql"
  emit_body "$activation_sql"
  cat <<SQL
REVOKE ALL ON TYPE "FiscalItemKind" FROM PUBLIC;
GRANT USAGE ON TYPE "FiscalItemKind" TO $runtime;
GRANT USAGE ON SCHEMA corestack_erp_fiscal TO $runtime;
GRANT SELECT ON TABLE corestack_erp_fiscal.dispatch TO $runtime;
GRANT INSERT (tenant_id,invoice_id,issuer_rnc,environment,operation_id,request_text,payload_sha256)
  ON TABLE corestack_erp_fiscal.dispatch TO $runtime;
GRANT UPDATE (state,attempts,next_attempt_at,lease_token,lease_until,document_id,encf,last_error,updated_at)
  ON TABLE corestack_erp_fiscal.dispatch TO $runtime;
GRANT USAGE,SELECT ON SEQUENCE corestack_erp_fiscal.dispatch_id_seq TO $runtime;
UPDATE "_prisma_migrations"
SET rolled_back_at=clock_timestamp()
WHERE migration_name='$failed_name' AND checksum='$failed_hash'
  AND finished_at IS NULL AND rolled_back_at IS NULL AND applied_steps_count=0;
INSERT INTO "_prisma_migrations"(
  id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count
) VALUES
  (gen_random_uuid()::text,'$failed_hash',clock_timestamp(),'$failed_name',NULL,NULL,clock_timestamp(),1),
  (gen_random_uuid()::text,'$dispatch_hash',clock_timestamp(),'$dispatch_name',NULL,NULL,clock_timestamp(),1),
  (gen_random_uuid()::text,'$activation_hash',clock_timestamp(),'$activation_name',NULL,NULL,clock_timestamp(),1);
COMMIT;
SQL
} | pg

[[ "$(pg -Atqc "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL AND rolled_back_at IS NULL")" == 0 ]] || fail 'UNFINISHED_MIGRATION_REMAINS'
[[ "$(pg -Atqc "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name IN ('$failed_name','$dispatch_name','$range_name','$activation_name') AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1")" == 4 ]] || fail 'MIGRATION_LEDGER_FINAL_STATE_INVALID'
[[ "$(pg -Atqc "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$failed_name' AND rolled_back_at IS NOT NULL")" == 1 ]] || fail 'FAILED_ATTEMPT_NOT_RESOLVED'
[[ "$(pg -Atqc "SELECT to_regtype('public.\"FiscalItemKind\"') IS NOT NULL AND to_regclass('corestack_erp_fiscal.dispatch') IS NOT NULL")" == t ]] || fail 'ERP_FISCAL_OBJECTS_MISSING'
[[ "$(pg -Atqc "SELECT pg_get_userbyid(relowner)='$migrator' FROM pg_class WHERE oid='corestack_erp_fiscal.dispatch'::regclass")" == t ]] || fail 'DISPATCH_OWNER_INVALID'
[[ "$(pg -Atqc "SELECT pg_get_constraintdef(oid) LIKE '%production%' FROM pg_constraint WHERE conrelid='corestack_erp_fiscal.dispatch'::regclass AND conname='dispatch_environment_check'")" == t ]] || fail 'PRODUCTION_DISPATCH_NOT_ENABLED'
[[ "$(pg -Atqc "SELECT has_schema_privilege('$runtime','corestack_erp_fiscal','USAGE') AND NOT has_schema_privilege('$runtime','corestack_erp_fiscal','CREATE')")" == t ]] || fail 'DISPATCH_SCHEMA_PRIVILEGES_INVALID'
[[ "$(pg -Atqc "SELECT has_table_privilege('$runtime','corestack_erp_fiscal.dispatch','SELECT') AND NOT has_table_privilege('$runtime','corestack_erp_fiscal.dispatch','DELETE,TRUNCATE,REFERENCES,TRIGGER')")" == t ]] || fail 'DISPATCH_TABLE_PRIVILEGES_INVALID'
[[ "$(pg -Atqc "SELECT has_column_privilege('$runtime','corestack_erp_fiscal.dispatch','state','UPDATE') AND NOT has_column_privilege('$runtime','corestack_erp_fiscal.dispatch','tenant_id','UPDATE') AND has_column_privilege('$runtime','corestack_erp_fiscal.dispatch','tenant_id','INSERT')")" == t ]] || fail 'DISPATCH_COLUMN_PRIVILEGES_INVALID'
[[ "$(pg -Atqc 'SELECT count(*) FROM corestack_erp_fiscal.dispatch')" == 0 ]] || fail 'UNEXPECTED_DISPATCH_CREATED'
[[ "$(pg -Atqc 'SELECT (SELECT count(*) FROM "Invoice")::text||'\''|'\''||(SELECT count(*) FROM "SalesOrder")::text||'\''|'\''||(SELECT count(*) FROM "ElectronicFiscalRange")::text')" == "$protected_counts" ]] || fail 'PROTECTED_ERP_COUNTS_CHANGED'
[[ "$(pg -Atqc "SELECT NOT has_schema_privilege('$runtime','public','CREATE')")" == t ]] || fail 'RUNTIME_DDL_BOUNDARY_LOST'

printf 'RIVNU_ERP_PENDING_MIGRATIONS_RECOVERED_MINIMUM_PRIVILEGE\n'
printf 'Backup=%s/before.dump\n' "$stage"
printf 'ProtectedCounts=%s\n' "$protected_counts"
printf '%s\n' 'No invoice, order, electronic range, sequence, credential, service or DGII endpoint was changed.'
