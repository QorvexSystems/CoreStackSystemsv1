#!/usr/bin/env bash
# Additive ERP outbox migration. Run personally with sudo on VM3.
set -Eeuo pipefail
set +x
umask 077

readonly database='rivnu_production'
readonly migrator='rivnu_migrator'
readonly runtime='rivnu_runtime'
readonly migration_name='20261031110000_electronic_fiscal_range_registration'
readonly migration_id='7d58b941-9925-4fcc-a5f7-202610311100'
readonly expected_hash='e7050ada5046c9f51af84b75bce97f62a65c6b885850a87f91337435c6fe46dc'
readonly stage='/var/lib/corestack-pki/rivnu-electronic-range-outbox-20261031'

fail() { printf '%s\n' "$*" >&2; exit 1; }
pg() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d "$database" -v ON_ERROR_STOP=1 "$@"; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'RUN_WITH_SUDO_ON_VM3'
[[ -d /var/lib/corestack-pki && ! -L /var/lib/corestack-pki ]] || fail 'PKI_STAGING_PARENT_INVALID'
[[ "$(stat -c '%u:%g:%a' /var/lib/corestack-pki)" == '0:0:700' ]] || fail 'PKI_STAGING_PARENT_PERMISSIONS_INVALID'
[[ ! -L "$stage" ]] || fail 'OUTBOX_MIGRATION_STAGE_SYMLINK_REJECTED'
[[ "$(pg -Atqc 'SHOW server_version_num')" == 17* ]] || fail 'POSTGRESQL_17_REQUIRED'
[[ "$(pg -Atqc 'SHOW ssl')" == 'on' ]] || fail 'POSTGRESQL_TLS_REQUIRED'
[[ "$(pg -Atqc "SELECT count(*) FROM pg_roles WHERE rolname IN ('$migrator','$runtime') AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls")" == '2' ]] || fail 'APPLICATION_ROLES_NOT_LEAST_PRIVILEGE'
[[ "$(pg -Atqc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='_prisma_migrations' AND column_name IN ('id','checksum','finished_at','migration_name','logs','rolled_back_at','started_at','applied_steps_count')")" == '8' ]] || fail 'PRISMA_MIGRATION_LEDGER_INVALID'
[[ "$(pg -Atqc "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$migration_name'")" == '0' ]] || fail 'MIGRATION_ALREADY_RECORDED'
[[ "$(pg -Atqc "SELECT (SELECT count(*) FROM pg_class WHERE relname='ElectronicFiscalRange')+(SELECT count(*) FROM pg_type WHERE typname='ElectronicFiscalRangeSyncStatus')")" == '0' ]] || fail 'OUTBOX_OBJECTS_ALREADY_EXIST_REVIEW_REQUIRED'
[[ "$(pg -Atqc "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL AND rolled_back_at IS NULL")" == '0' ]] || fail 'UNFINISHED_PRISMA_MIGRATION_PRESENT'

source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
source_sql="$source_dir/../../packages/database/prisma/migrations/$migration_name/migration.sql"
[[ -f "$source_sql" && ! -L "$source_sql" ]] || fail 'MIGRATION_SOURCE_INVALID'
[[ "$(sha256sum "$source_sql" | cut -d' ' -f1)" == "$expected_hash" ]] || fail 'MIGRATION_HASH_MISMATCH'

if [[ -e "$stage" ]]; then
  [[ -d "$stage" && "$(stat -c '%u:%g:%a' "$stage")" == '0:0:700' ]] || fail 'OUTBOX_MIGRATION_STAGE_INVALID'
  [[ -f "$stage/migration.sql" && ! -L "$stage/migration.sql" ]] || fail 'STAGED_MIGRATION_INVALID'
  [[ "$(sha256sum "$stage/migration.sql" | cut -d' ' -f1)" == "$expected_hash" ]] || fail 'STAGED_MIGRATION_HASH_MISMATCH'
  [[ -f "$stage/before.dump" && ! -L "$stage/before.dump" && -s "$stage/before.dump" ]] || fail 'STAGED_BACKUP_INVALID'
  [[ -f "$stage/before.inventory" && ! -L "$stage/before.inventory" && -s "$stage/before.inventory" ]] || fail 'STAGED_BACKUP_INVENTORY_INVALID'
else
  mkdir -m 0700 "$stage"
  cp -- "$source_sql" "$stage/migration.sql"
  sudo -u postgres pg_dump -h /var/run/postgresql -p 5432 -d "$database" --format=custom >"$stage/before.dump"
  pg_restore --list "$stage/before.dump" >"$stage/before.inventory"
  [[ -s "$stage/before.dump" && -s "$stage/before.inventory" ]] || fail 'VERIFIED_BACKUP_REQUIRED'
fi

{
cat <<SQL
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_advisory_xact_lock(hashtextextended('rivnu:electronic-range-outbox:20261031',0));
SET LOCAL ROLE $migrator;
SQL
cat "$stage/migration.sql"
cat <<SQL
REVOKE ALL ON TABLE "ElectronicFiscalRange" FROM PUBLIC,$runtime;
GRANT SELECT ON TABLE "ElectronicFiscalRange" TO $runtime;
GRANT INSERT ON TABLE "ElectronicFiscalRange" TO $runtime;
GRANT UPDATE (
  "syncStatus","syncAttempts","nextSyncAt","lastErrorCode","remoteRangeId","syncedAt","updatedAt"
) ON TABLE "ElectronicFiscalRange" TO $runtime;
REVOKE ALL ON TYPE "ElectronicFiscalRangeSyncStatus" FROM PUBLIC,$runtime;
GRANT USAGE ON TYPE "ElectronicFiscalRangeSyncStatus" TO $runtime;
INSERT INTO "_prisma_migrations"(
  id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count
) VALUES(
  '$migration_id','$expected_hash',clock_timestamp(),'$migration_name',NULL,NULL,clock_timestamp(),1
);
COMMIT;
SQL
} | pg

[[ "$(pg -Atqc "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$migration_name' AND checksum='$expected_hash' AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1")" == '1' ]] || fail 'MIGRATION_LEDGER_VERIFICATION_FAILED'
[[ "$(pg -Atqc "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='\"ElectronicFiscalRange\"'::regclass")" == "$migrator" ]] || fail 'OUTBOX_OWNER_INVALID'
[[ "$(pg -Atqc "SELECT has_table_privilege('$runtime','\"ElectronicFiscalRange\"','SELECT,INSERT') AND NOT has_table_privilege('$runtime','\"ElectronicFiscalRange\"','DELETE,TRUNCATE,REFERENCES,TRIGGER')")" == 't' ]] || fail 'OUTBOX_RUNTIME_PRIVILEGES_INVALID'
[[ "$(pg -Atqc "SELECT has_column_privilege('$runtime','\"ElectronicFiscalRange\"','syncStatus','UPDATE') AND NOT has_column_privilege('$runtime','\"ElectronicFiscalRange\"','startNumber','UPDATE') AND NOT has_column_privilege('$runtime','\"ElectronicFiscalRange\"','tenantId','UPDATE')")" == 't' ]] || fail 'OUTBOX_COLUMN_PRIVILEGES_INVALID'

printf 'RIVNU_ELECTRONIC_RANGE_OUTBOX_MIGRATED_MINIMUM_PRIVILEGE\n'
printf 'Backup=%s/before.dump\n' "$stage"
printf 'No fiscal production database, range, invoice, queue or DGII endpoint was changed.\n'
