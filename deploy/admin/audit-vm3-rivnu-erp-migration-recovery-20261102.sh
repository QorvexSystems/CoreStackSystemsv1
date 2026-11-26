#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly database='rivnu_production'
readonly migrator='rivnu_migrator'
readonly runtime='rivnu_runtime'

fail() { printf '%s\n' "$1" >&2; exit 1; }
pg() {
  sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 \
    -d "$database" -v ON_ERROR_STOP=1 -P pager=off "$@"
}

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'RUN_WITH_SUDO_ON_VM3'
[[ "$(pg -Atqc 'SHOW server_version_num')" == 17* ]] || fail 'POSTGRESQL_17_REQUIRED'
[[ "$(pg -Atqc 'SHOW ssl')" == on ]] || fail 'POSTGRESQL_TLS_REQUIRED'

printf '%s\n' '=== DATABASE AND ROLES ==='
pg <<SQL
BEGIN READ ONLY;
SELECT current_database() AS database,
       pg_get_userbyid(datdba) AS database_owner
FROM pg_database WHERE datname=current_database();
SELECT n.nspname AS schema,
       pg_get_userbyid(n.nspowner) AS owner,
       has_schema_privilege('$migrator',n.oid,'CREATE') AS migrator_create,
       has_schema_privilege('$runtime',n.oid,'CREATE') AS runtime_create,
       has_schema_privilege('$runtime',n.oid,'USAGE') AS runtime_usage
FROM pg_namespace n
WHERE n.nspname IN ('public','corestack_erp_fiscal')
ORDER BY n.nspname;
SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
FROM pg_roles WHERE rolname IN ('$migrator','$runtime') ORDER BY rolname;
COMMIT;
SQL

printf '%s\n' '=== RELEVANT PRISMA LEDGER ==='
pg <<'SQL'
BEGIN READ ONLY;
SELECT migration_name,checksum,
       finished_at IS NOT NULL AS finished,
       rolled_back_at IS NOT NULL AS rolled_back,
       applied_steps_count,
       CASE
         WHEN logs IS NULL THEN NULL
         WHEN logs LIKE '%permission denied for schema public%' THEN 'PERMISSION_DENIED_PUBLIC'
         ELSE 'OTHER_REDACTED'
       END AS log_class
FROM "_prisma_migrations"
WHERE migration_name IN (
  '20260920120000_capture_sales_fiscal_evidence',
  '20260921180000_add_fiscal_dispatch_outbox',
  '20261031110000_electronic_fiscal_range_registration',
  '20261102023000_enable_production_fiscal_dispatch'
)
ORDER BY started_at,id;
SELECT count(*) AS unfinished_migrations
FROM "_prisma_migrations"
WHERE finished_at IS NULL AND rolled_back_at IS NULL;
COMMIT;
SQL

printf '%s\n' '=== OBJECT STATE ==='
pg <<'SQL'
BEGIN READ ONLY;
SELECT
  to_regtype('public."FiscalItemKind"')::text AS fiscal_item_kind,
  to_regclass('corestack_erp_fiscal.dispatch')::text AS dispatch,
  to_regclass('public."ElectronicFiscalRange"')::text AS electronic_range;
SELECT table_name,column_name
FROM information_schema.columns
WHERE table_schema='public'
  AND (
    (table_name='Product' AND column_name='fiscalItemKind') OR
    (table_name='SalesOrderItem' AND column_name IN ('originalUnitPrice','fiscalItemKind')) OR
    (table_name='InvoiceItem' AND column_name IN ('originalUnitPrice','fiscalItemKind'))
  )
ORDER BY table_name,column_name;
SELECT conname,pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid=COALESCE(to_regclass('corestack_erp_fiscal.dispatch'),0)
  AND conname='dispatch_environment_check';
COMMIT;
SQL

printf '%s\n' '=== HBA AND ACTIVE APPLICATION ==='
sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 \
  -d postgres -v ON_ERROR_STOP=1 -P pager=off <<SQL
BEGIN READ ONLY;
SELECT line_number,type,database,user_name,address,auth_method,error
FROM pg_hba_file_rules
WHERE '$database'=ANY(database) OR '$runtime'=ANY(user_name) OR '$migrator'=ANY(user_name)
ORDER BY line_number;
SELECT usename,application_name,client_addr,state,count(*)
FROM pg_stat_activity
WHERE datname='$database'
GROUP BY usename,application_name,client_addr,state
ORDER BY usename,application_name,client_addr,state;
COMMIT;
SQL

printf '%s\n' 'RIVNU_VM3_ERP_MIGRATION_RECOVERY_AUDIT_COMPLETE_NO_CHANGES'
printf '%s\n' 'No role, privilege, object, migration, invoice, range or DGII endpoint was changed.'
