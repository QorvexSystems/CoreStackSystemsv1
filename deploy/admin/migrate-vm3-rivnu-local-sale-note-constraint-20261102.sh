#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly database='rivnu_production'
readonly migrator='rivnu_migrator'
readonly runtime='rivnu_runtime'
readonly migration_name='20261102143500_allow_local_sale_note_in_cashier'
readonly migration_hash='1e69cdc4aace088d3bcf88ab3f07255fd73e662299af014b194d282c11b286e2'
readonly source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly migration_sql="$source_root/packages/database/prisma/migrations/$migration_name/migration.sql"
readonly stage="/var/lib/corestack-pki/rivnu-local-sale-note-constraint-$(date -u +%Y%m%dT%H%M%SZ)"

fail() { printf '%s\n' "$1" >&2; exit 1; }
pg() {
  sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 \
    -d "$database" -v ON_ERROR_STOP=1 -P pager=off "$@"
}
emit_body() {
  awk '$0 == "BEGIN;" || $0 == "COMMIT;" { next } { print }' "$1"
}

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail RUN_WITH_SUDO_ON_VM3
[[ -f "$migration_sql" && ! -L "$migration_sql" ]] || fail MIGRATION_SOURCE_MISSING
[[ "$(sha256sum "$migration_sql" | cut -d' ' -f1)" == "$migration_hash" ]] || fail MIGRATION_HASH_MISMATCH
[[ "$(pg -Atqc 'SHOW server_version_num')" == 17* ]] || fail POSTGRESQL_17_REQUIRED
[[ "$(pg -Atqc 'SHOW ssl')" == on ]] || fail POSTGRESQL_TLS_REQUIRED
[[ "$(pg -Atqc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()")" == "$migrator" ]] || fail DATABASE_OWNER_INVALID
[[ "$(pg -Atqc "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.\"SalesOrder\"'::regclass")" == "$migrator" ]] || fail SALES_ORDER_OWNER_INVALID
[[ "$(pg -Atqc "SELECT NOT has_schema_privilege('$runtime','public','CREATE')")" == t ]] || fail RUNTIME_DDL_BOUNDARY_INVALID
[[ "$(pg -Atqc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL')" == 0 ]] || fail UNFINISHED_MIGRATION_PRESENT
[[ "$(pg -Atqc "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$migration_name'")" == 0 ]] || fail MIGRATION_ALREADY_RECORDED_REVIEW_REQUIRED

readonly current_constraint="$(pg -Atqc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.\"SalesOrder\"'::regclass AND conname='SalesOrder_fiscal_purpose_document_type_check'")"
[[ -n "$current_constraint" ]] || fail SALES_ORDER_FISCAL_CONSTRAINT_MISSING
[[ "$current_constraint" == *CONSUMER_ELECTRONIC_32* && "$current_constraint" != *LOCAL_SALE_NOTE* ]] || fail SALES_ORDER_FISCAL_CONSTRAINT_UNEXPECTED
readonly protected_counts="$(pg -Atqc 'SELECT (SELECT count(*) FROM "SalesOrder")::text||'\''|'\''||(SELECT count(*) FROM "Invoice")::text||'\''|'\''||(SELECT count(*) FROM "LocalSaleSequence")::text')"

install -d -o root -g root -m 0700 "$stage"
install -o root -g root -m 0400 "$migration_sql" "$stage/migration.sql"
printf '%s\n' "$current_constraint" >"$stage/constraint.before.txt"
printf '%s\n' "$protected_counts" >"$stage/protected-counts.before"
pg -Atqc 'SELECT id,migration_name,checksum,finished_at,rolled_back_at,applied_steps_count FROM "_prisma_migrations" ORDER BY started_at,id' >"$stage/prisma-ledger.before"
sudo -u postgres pg_dump -h /var/run/postgresql -p 5432 -d "$database" \
  --schema-only --table='public."SalesOrder"' >"$stage/SalesOrder.before.sql"
chmod 0600 "$stage"/*.before "$stage"/*.txt "$stage"/*.sql
[[ -s "$stage/SalesOrder.before.sql" && -s "$stage/prisma-ledger.before" ]] || fail VERIFIED_BACKUP_REQUIRED

{
  printf '%s\n' \
    'BEGIN;' \
    "SET LOCAL lock_timeout='5s';" \
    "SET LOCAL statement_timeout='60s';" \
    "SELECT pg_advisory_xact_lock(hashtextextended('rivnu:local-sale-note-constraint:20261102',0));" \
    "SET LOCAL ROLE $migrator;"
  emit_body "$migration_sql"
  cat <<SQL
INSERT INTO "_prisma_migrations"(
  id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count
) VALUES (
  gen_random_uuid()::text,'$migration_hash',clock_timestamp(),'$migration_name',NULL,NULL,clock_timestamp(),1
);
COMMIT;
SQL
} | pg

readonly final_constraint="$(pg -Atqc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.\"SalesOrder\"'::regclass AND conname='SalesOrder_fiscal_purpose_document_type_check'")"
[[ "$final_constraint" == *LOCAL_SALE_NOTE* ]] || fail LOCAL_SALE_NOTE_CONSTRAINT_NOT_ACTIVE
[[ "$(pg -Atqc "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$migration_name' AND checksum='$migration_hash' AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1")" == 1 ]] || fail MIGRATION_LEDGER_INVALID
[[ "$(pg -Atqc 'SELECT (SELECT count(*) FROM "SalesOrder")::text||'\''|'\''||(SELECT count(*) FROM "Invoice")::text||'\''|'\''||(SELECT count(*) FROM "LocalSaleSequence")::text')" == "$protected_counts" ]] || fail PROTECTED_COUNTS_CHANGED
[[ "$(pg -Atqc "SELECT NOT has_schema_privilege('$runtime','public','CREATE')")" == t ]] || fail RUNTIME_DDL_BOUNDARY_LOST

printf 'RIVNU_LOCAL_SALE_NOTE_CONSTRAINT_MIGRATED_MINIMUM_PRIVILEGE\n'
printf 'Backup=%s\n' "$stage"
printf 'ProtectedCounts=%s\n' "$protected_counts"
printf '%s\n' 'No order, invoice, sequence, payment, inventory movement or DGII request was created.'
