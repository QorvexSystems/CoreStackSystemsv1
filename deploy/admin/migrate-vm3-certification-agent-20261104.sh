#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
readonly name='20261104170000_electronic_certification_orchestrator'
readonly expected='d412c684155545289e06600d37b2589a3c7fa03e77e9ef7cb09f763d97914891'
readonly source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly source_sql="$source_root/packages/database/prisma/migrations/$name/migration.sql"
fail() { printf '%s\n' "$1" >&2; exit 1; }
pg() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d rivnu_production -v ON_ERROR_STOP=1 -P pager=off "$@"; }
[[ $EUID == 0 && "$(hostname)" == VM3-SQLDB ]] || fail RUN_WITH_SUDO_ON_VM3
[[ -f "$source_sql" && ! -L "$source_sql" && "$(sha256sum "$source_sql" | cut -d' ' -f1)" == "$expected" ]] || fail MIGRATION_HASH_MISMATCH
[[ "$(pg -Atqc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()")" == rivnu_migrator ]] || fail DATABASE_OWNER_MISMATCH
[[ "$(pg -Atqc "SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls FROM pg_roles WHERE rolname='rivnu_runtime'")" == t ]] || fail RUNTIME_ROLE_BOUNDARY_INVALID
[[ "$(pg -Atqc "SELECT NOT has_schema_privilege('rivnu_runtime','public','CREATE') AND NOT pg_has_role('rivnu_runtime','rivnu_migrator','MEMBER')")" == t ]] || fail RUNTIME_DDL_BOUNDARY_INVALID
[[ "$(pg -Atqc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL')" == 0 ]] || fail UNFINISHED_MIGRATION_PRESENT
ledger=$(pg -Atqc "SELECT checksum FROM \"_prisma_migrations\" WHERE migration_name='$name' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")
if [[ -n "$ledger" ]]; then
  [[ "$ledger" == "$expected" ]] || fail MIGRATION_LEDGER_HASH_MISMATCH
  printf '%s\n' CERTIFICATION_AGENT_MIGRATION_ALREADY_APPLIED
  exit 0
fi
[[ "$(pg -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'ElectronicCertification%'")" == 0 ]] || fail PARTIAL_CERTIFICATION_SCHEMA_REQUIRES_REVIEW
readonly backup="/var/lib/corestack-pki/certification-agent-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$backup"
sudo -u postgres pg_dump -h /var/run/postgresql -p 5432 -d rivnu_production --schema-only >"$backup/before-schema.sql"
[[ -s "$backup/before-schema.sql" ]] || fail SCHEMA_BACKUP_REQUIRED
install -m 0400 "$source_sql" "$backup/migration.sql"
# SQL is streamed through stdin. PostgreSQL never needs filesystem permission
# to read a root-owned backup, and the runtime never receives CREATE privileges.
{
  printf '%s\n' 'BEGIN;' "SET LOCAL lock_timeout='5s';" "SET LOCAL statement_timeout='60s';" \
    "SELECT pg_advisory_xact_lock(hashtextextended('certification-agent:migration:20261104',0));" 'SET LOCAL ROLE rivnu_migrator;'
  awk '$0 == "BEGIN;" || $0 == "COMMIT;" { next } { print }' "$source_sql"
  printf '%s\n' \
    'REVOKE ALL ON "ElectronicCertificationCase", "ElectronicCertificationStep", "ElectronicCertificationJob", "ElectronicCertificationArtifact", "ElectronicCertificationEvent" FROM PUBLIC, rivnu_runtime;' \
    'GRANT SELECT, INSERT, UPDATE ON "ElectronicCertificationCase", "ElectronicCertificationStep", "ElectronicCertificationJob" TO rivnu_runtime;' \
    'GRANT SELECT, INSERT ON "ElectronicCertificationArtifact", "ElectronicCertificationEvent" TO rivnu_runtime;' \
    "INSERT INTO \"_prisma_migrations\"(id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES (gen_random_uuid()::text,'$expected',clock_timestamp(),'$name',clock_timestamp(),1);" \
    'COMMIT;'
} | pg
printf 'CERTIFICATION_AGENT_SCHEMA_MIGRATED_MINIMUM_PRIVILEGE backup=%s\n' "$backup"
printf '%s\n' 'No invoice, range, fiscal credential, DGII request or client certification was created.'
