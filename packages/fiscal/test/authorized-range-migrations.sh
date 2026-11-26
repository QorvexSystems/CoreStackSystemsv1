#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
name="corestack-range-migrations-test-$$"
container="$(docker run --rm -d --name "$name" --network none \
  --memory=256m --cpus=1 --tmpfs /var/lib/postgresql/data:rw,nosuid,size=160m \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine)"
trap 'docker stop "$container" >/dev/null 2>&1 || true' EXIT
for ((attempt=0; attempt<30; attempt++)); do
  docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
psql() { docker exec -i "$container" psql -X -U postgres -v ON_ERROR_STOP=1 "$@"; }

psql -d postgres <<'SQL'
CREATE ROLE rivnu_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE rivnu_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE rivnu_production OWNER rivnu_migrator;
SQL
psql -d rivnu_production <<'SQL'
SET ROLE rivnu_migrator;
CREATE TABLE "Tenant"(id text PRIMARY KEY);
CREATE TABLE "User"(id text PRIMARY KEY);
CREATE TABLE "_prisma_migrations"(
 id varchar(36) PRIMARY KEY,checksum varchar(64) NOT NULL,finished_at timestamptz,
 migration_name varchar(255) NOT NULL,logs text,rolled_back_at timestamptz,
 started_at timestamptz NOT NULL DEFAULT now(),applied_steps_count integer NOT NULL DEFAULT 0
);
SQL
{
  printf '%s\n' "BEGIN; SET LOCAL ROLE rivnu_migrator;"
  cat "$root/packages/database/prisma/migrations/20261031110000_electronic_fiscal_range_registration/migration.sql"
  cat <<'SQL'
REVOKE ALL ON TABLE "ElectronicFiscalRange" FROM PUBLIC,rivnu_runtime;
GRANT SELECT,INSERT ON TABLE "ElectronicFiscalRange" TO rivnu_runtime;
GRANT UPDATE ("syncStatus","syncAttempts","nextSyncAt","lastErrorCode","remoteRangeId","syncedAt","updatedAt") ON TABLE "ElectronicFiscalRange" TO rivnu_runtime;
REVOKE ALL ON TYPE "ElectronicFiscalRangeSyncStatus" FROM PUBLIC,rivnu_runtime;
GRANT USAGE ON TYPE "ElectronicFiscalRangeSyncStatus" TO rivnu_runtime;
COMMIT;
SQL
} | psql -d rivnu_production
psql -d rivnu_production <<'SQL'
INSERT INTO "Tenant" VALUES('tenant-rivnu');
INSERT INTO "User" VALUES('user-admin');
SET SESSION AUTHORIZATION rivnu_runtime;
INSERT INTO "ElectronicFiscalRange"(
 id,"tenantId","issuerTaxId","ecfType",prefix,"startNumber","endNumber","nextNumber",
 "authorizationNumber","createdById","updatedAt"
) VALUES('range-one','tenant-rivnu','40220429126',31,'E31',1,100,1,'AUTH-1','user-admin',now());
UPDATE "ElectronicFiscalRange" SET "syncStatus"='SYNCING',"syncAttempts"=1,"updatedAt"=now()
WHERE id='range-one';
DO $$
DECLARE denied boolean:=false;
BEGIN
 BEGIN UPDATE "ElectronicFiscalRange" SET "startNumber"=2 WHERE id='range-one';
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'business range mutation was allowed'; END IF;
 denied:=false;
 BEGIN DELETE FROM "ElectronicFiscalRange" WHERE id='range-one';
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'range deletion was allowed'; END IF;
 denied:=false;
 BEGIN
  INSERT INTO "ElectronicFiscalRange"(
   id,"tenantId","issuerTaxId","ecfType",prefix,"startNumber","endNumber","nextNumber",
   "authorizationNumber","createdById","updatedAt"
  ) VALUES('range-two','tenant-rivnu','40220429126',31,'E31',50,150,50,'AUTH-2','user-admin',now());
 EXCEPTION WHEN exclusion_violation THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'overlapping range was allowed'; END IF;
END $$;
SQL

psql -d postgres <<'SQL'
CREATE ROLE rivnu_fe_prod_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE rivnu_fe_prod_range LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CREATE ON DATABASE postgres TO rivnu_fe_prod_owner;
SQL
{
 printf 'BEGIN; SET LOCAL ROLE rivnu_fe_prod_owner;\n'
 sed '/^BEGIN;$/d; /^COMMIT;$/d' "$root/packages/fiscal/sql/006_production_authorized_ranges.sql"
 cat <<'SQL'
INSERT INTO fiscal_meta.issuer_scope(tenant_id,issuer_rnc,environment)
VALUES('tenant-rivnu','40220429126','production');
INSERT INTO fiscal_meta.range_registration_identity(login_role,tenant_id,issuer_rnc,environment)
VALUES('rivnu_fe_prod_range','tenant-rivnu','40220429126','production');
GRANT USAGE ON SCHEMA fiscal_meta,corestack_fiscal TO rivnu_fe_prod_range;
GRANT SELECT ON fiscal_meta.issuer_scope TO rivnu_fe_prod_range;
GRANT EXECUTE ON FUNCTION corestack_fiscal.register_authorized_range(
 text,text,text,smallint,bigint,bigint,bigint,text,date,date
) TO rivnu_fe_prod_range;
COMMIT;
SQL
} | psql -d postgres
psql -d postgres <<'SQL'
SET SESSION AUTHORIZATION rivnu_fe_prod_range;
SELECT * FROM corestack_fiscal.register_authorized_range(
 'cm12345678901234567890','tenant-rivnu','40220429126',31::smallint,
 1::bigint,100::bigint,1::bigint,'AUTH-1',CURRENT_DATE,CURRENT_DATE
);
DO $$
DECLARE denied boolean:=false;
BEGIN
 BEGIN UPDATE corestack_fiscal.sequence_range SET next_number=2;
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'fiscal direct DML was allowed'; END IF;
END $$;
SQL

printf 'PASS: ERP outbox and fiscal production migrations enforce minimum privileges.\n'
