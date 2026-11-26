#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
container="$(docker run --rm -d --name "corestack-range-test-$$" --network none \
  --memory=256m --cpus=1 --tmpfs /var/lib/postgresql/data:rw,nosuid,size=128m \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine)"
trap 'docker stop "$container" >/dev/null' EXIT
for ((attempt=0; attempt<30; attempt++)); do
  docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
psql() { docker exec -i "$container" psql -X -d postgres -v ON_ERROR_STOP=1 "$@"; }

psql -U postgres <<'SQL'
CREATE ROLE fiscal_prod_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE fiscal_prod_range LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CREATE ON DATABASE postgres TO fiscal_prod_owner;
SQL
{ printf 'SET ROLE fiscal_prod_owner;\n'; cat "$root/sql/006_production_authorized_ranges.sql"; } | psql -U postgres
psql -U postgres <<'SQL'
SET ROLE fiscal_prod_owner;
INSERT INTO fiscal_meta.issuer_scope(tenant_id,issuer_rnc,environment)
VALUES('tenant-rivnu','40220429126','production');
INSERT INTO fiscal_meta.range_registration_identity(login_role,tenant_id,issuer_rnc,environment)
VALUES('fiscal_prod_range','tenant-rivnu','40220429126','production');
GRANT USAGE ON SCHEMA corestack_fiscal TO fiscal_prod_range;
GRANT EXECUTE ON FUNCTION corestack_fiscal.register_authorized_range(
  text,text,text,smallint,bigint,bigint,bigint,text,date,date
) TO fiscal_prod_range;
SQL

psql -U fiscal_prod_range <<'SQL'
SELECT * FROM corestack_fiscal.register_authorized_range(
  'cm12345678901234567890','tenant-rivnu','40220429126',31::smallint,1::bigint,9999999999::bigint,1::bigint,
  'DGII-PROD-1','2026-10-31','2027-12-31'
);
SELECT * FROM corestack_fiscal.register_authorized_range(
  'cm12345678901234567890','tenant-rivnu','40220429126',31::smallint,1::bigint,9999999999::bigint,1::bigint,
  'DGII-PROD-1','2026-10-31','2027-12-31'
);
DO $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    PERFORM corestack_fiscal.register_authorized_range(
      'cm12345678901234567890','tenant-rivnu','40220429126',31::smallint,1::bigint,9999999999::bigint,2::bigint,
      'DGII-PROD-1','2026-10-31','2027-12-31');
  EXCEPTION WHEN OTHERS THEN rejected := true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'changed replay accepted'; END IF;
  rejected := false;
  BEGIN
    PERFORM corestack_fiscal.register_authorized_range(
      'cm12345678901234567891','tenant-rivnu','40220429126',31::smallint,10::bigint,20::bigint,10::bigint,
      'DGII-PROD-2','2026-10-31','2027-12-31');
  EXCEPTION WHEN OTHERS THEN rejected := true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'overlap accepted'; END IF;
  rejected := false;
  BEGIN UPDATE corestack_fiscal.sequence_range SET next_number=2;
  EXCEPTION WHEN insufficient_privilege THEN rejected := true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'range role can mutate tables'; END IF;
END $$;
SQL

psql -U postgres <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM corestack_fiscal.sequence_range)<>1
     OR (SELECT next_number FROM corestack_fiscal.sequence_range)<>1
     OR (SELECT count(*) FROM corestack_fiscal.range_event)<>1
  THEN RAISE EXCEPTION 'range registry evidence mismatch'; END IF;
END $$;
SQL

printf 'PASS: production range registration is scoped, idempotent, overlap-safe and least-privilege.\n'
