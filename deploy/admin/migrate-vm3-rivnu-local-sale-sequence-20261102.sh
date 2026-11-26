#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly database='rivnu_production'
readonly migrator='rivnu_migrator'
readonly runtime='rivnu_runtime'
readonly migration_name='20261102100000_rivnu_local_sale_sequence'
readonly migration_hash='28a652c9cda93baff94a45d6caf1e275a5536e72fb83b8fc1685266b19663d9b'
readonly source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly migration="$source_root/packages/database/prisma/migrations/$migration_name/migration.sql"
readonly stage="/var/lib/corestack-pki/rivnu-local-sale-sequence-$(date -u +%Y%m%dT%H%M%SZ)"

fail() { printf '%s\n' "$1" >&2; exit 1; }
pg() {
  sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 \
    -d "$database" -v ON_ERROR_STOP=1 -P pager=off "$@"
}

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail RUN_WITH_SUDO_ON_VM3
[[ -f "$migration" && ! -L "$migration" ]] || fail MIGRATION_SOURCE_INVALID
[[ "$(sha256sum "$migration" | cut -d' ' -f1)" == "$migration_hash" ]] || fail MIGRATION_HASH_MISMATCH
[[ "$(pg -Atqc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()")" == "$migrator" ]] || fail DATABASE_OWNER_INVALID
[[ "$(pg -Atqc "SELECT count(*) FROM pg_roles WHERE rolname IN ('$migrator','$runtime')")" == 2 ]] || fail REQUIRED_ROLES_MISSING
[[ "$(pg -Atqc "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$migration_name'")" == 0 ]] || fail MIGRATION_ALREADY_RECORDED_REVIEW_REQUIRED
[[ "$(pg -Atqc "SELECT to_regclass('public.\"LocalSaleSequence\"') IS NULL")" == t ]] || fail PARTIAL_LOCAL_SEQUENCE_PRESENT

install -d -o root -g root -m 0700 "$stage"
install -o root -g root -m 0400 "$migration" "$stage/migration.sql"
sudo -u postgres pg_dump -h /var/run/postgresql -p 5432 -d "$database" --format=custom >"$stage/before.dump"
chmod 0600 "$stage/before.dump"
[[ -s "$stage/before.dump" ]] || fail VERIFIED_BACKUP_REQUIRED

{
  printf '%s\n' \
    'BEGIN;' \
    "SET LOCAL lock_timeout='5s';" \
    "SET LOCAL statement_timeout='60s';" \
    "SELECT pg_advisory_xact_lock(hashtextextended('rivnu:local-sale-sequence:20261102',0));" \
    "SET LOCAL ROLE $migrator;"
  sed '/^[[:space:]]*REVOKE ALL ON TABLE "LocalSaleSequence" FROM PUBLIC;[[:space:]]*$/,$d' "$migration"
  cat <<SQL
REVOKE ALL ON TABLE "LocalSaleSequence" FROM PUBLIC;
REVOKE ALL ON TABLE "LocalSaleSequence" FROM $runtime;
GRANT SELECT,INSERT,UPDATE ON TABLE "LocalSaleSequence" TO $runtime;
INSERT INTO "_prisma_migrations"(
  id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count
) VALUES (
  gen_random_uuid()::text,'$migration_hash',clock_timestamp(),'$migration_name',NULL,NULL,clock_timestamp(),1
);
COMMIT;
SQL
} | pg

[[ "$(pg -Atqc "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$migration_name' AND checksum='$migration_hash' AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1")" == 1 ]] || fail MIGRATION_LEDGER_INVALID
[[ "$(pg -Atqc "SELECT pg_get_userbyid(relowner)='$migrator' FROM pg_class WHERE oid='public.\"LocalSaleSequence\"'::regclass")" == t ]] || fail TABLE_OWNER_INVALID
[[ "$(pg -Atqc "SELECT has_table_privilege('$runtime','public.\"LocalSaleSequence\"','SELECT,INSERT,UPDATE') AND NOT has_table_privilege('$runtime','public.\"LocalSaleSequence\"','DELETE,TRUNCATE,REFERENCES,TRIGGER')")" == t ]] || fail RUNTIME_PRIVILEGE_BOUNDARY_INVALID
[[ "$(pg -Atqc 'SELECT count(*) FROM "LocalSaleSequence"')" == 0 ]] || fail UNEXPECTED_SEQUENCE_CREATED

printf 'RIVNU_LOCAL_SALE_SEQUENCE_MIGRATED_MINIMUM_PRIVILEGE\n'
printf 'Backup=%s/before.dump\n' "$stage"
printf '%s\n' 'No invoice, fiscal number, local reference, payment, inventory movement or DGII request was created.'
