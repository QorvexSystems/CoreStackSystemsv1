#!/usr/bin/env bash
# Disposable database only: no host ports, no production credentials or persistent volume.
set -euo pipefail
fiscal_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
fiscal_container="$(docker run --rm -d --name "corestack-fiscal-test-$$" \
  --network none --memory=256m --cpus=1 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=128m \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine)"
trap 'docker stop "$fiscal_container" >/dev/null' EXIT
fiscal_ready=false
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$fiscal_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    fiscal_ready=true
    break
  fi
  sleep 1
done
if [[ "$fiscal_ready" != true ]]; then
  echo 'Disposable PostgreSQL did not become ready.' >&2
  exit 1
fi
fiscal_psql() { docker exec -i "$fiscal_container" psql -X -U postgres -v ON_ERROR_STOP=1 "$@"; }
fiscal_psql < "$fiscal_root/sql/001_sequence_registry.sql"
fiscal_psql < "$fiscal_root/test/sequences.sql"
fiscal_psql <<'SQL'
SELECT corestack_fiscal.register_range('concurrent','101010632','certification',31::smallint,
  1,100,'2026-01-01','2026-12-31','SYNTHETIC-CONCURRENCY');
BEGIN;
SELECT corestack_fiscal.reserve_encf('concurrent','101010632','certification',31::smallint,
  'rolled-back',repeat('a',64),'2026-09-20');
ROLLBACK;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM corestack_fiscal.sequence_reservation) OR
     (SELECT next_number FROM corestack_fiscal.sequence_range WHERE tenant_id='concurrent') <> 1
  THEN RAISE EXCEPTION 'Rollback consumed a number'; END IF;
END $$;
SQL
fiscal_jobs=()
for ((request=1; request<=32; request++)); do
  fiscal_psql -qAt -c "SELECT corestack_fiscal.reserve_encf('concurrent','101010632','certification',31::smallint,
    'unique-$request',repeat('a',64),'2026-09-20');" >/dev/null &
  fiscal_jobs+=("$!")
done
for ((request=1; request<=16; request++)); do
  fiscal_psql -qAt -c "SELECT corestack_fiscal.reserve_encf('concurrent','101010632','certification',31::smallint,
    'same-operation',repeat('b',64),'2026-09-20');" >/dev/null &
  fiscal_jobs+=("$!")
done
fiscal_failed=false
for fiscal_job in "${fiscal_jobs[@]}"; do
  if ! wait "$fiscal_job"; then fiscal_failed=true; fi
done
if [[ "$fiscal_failed" == true ]]; then exit 1; fi
fiscal_psql <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM corestack_fiscal.sequence_reservation) <> 33 OR
     (SELECT count(DISTINCT encf) FROM corestack_fiscal.sequence_reservation) <> 33 OR
     (SELECT next_number FROM corestack_fiscal.sequence_range WHERE tenant_id='concurrent') <> 34 OR
     (SELECT count(*) FROM corestack_fiscal.sequence_reservation WHERE operation_id='same-operation') <> 1
  THEN RAISE EXCEPTION 'Concurrency/idempotency failed'; END IF;
END $$;
CREATE ROLE fiscal_test_runtime;
GRANT USAGE ON SCHEMA corestack_fiscal TO fiscal_test_runtime;
GRANT EXECUTE ON FUNCTION corestack_fiscal.reserve_encf(text,text,text,smallint,text,text,date) TO fiscal_test_runtime;
SET ROLE fiscal_test_runtime;
SELECT corestack_fiscal.reserve_encf('concurrent','101010632','certification',31::smallint,
  'least-privilege',repeat('a',64),'2026-09-20');
DO $$ DECLARE rejected boolean := false; BEGIN
  BEGIN
    UPDATE corestack_fiscal.sequence_range SET next_number=1;
  EXCEPTION WHEN insufficient_privilege THEN rejected := true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'Runtime can mutate sequence tables'; END IF;
  rejected := false;
  BEGIN
    PERFORM corestack_fiscal.register_range('concurrent','101010632','certification',32::smallint,
      1,100,'2026-01-01','2026-12-31','UNAUTHORIZED');
  EXCEPTION WHEN insufficient_privilege THEN rejected := true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'Runtime can authorize ranges'; END IF;
END $$;
RESET ROLE;
SQL
echo 'PASS: 10 types; range boundaries, isolation, expiry, rollback, 48 concurrent requests and restricted runtime role.'
fiscal_psql < "$fiscal_root/sql/002_request_persistence.sql"
fiscal_psql < "$fiscal_root/test/persistence.sql"
fiscal_jobs=()
for ((request=1; request<=16; request++)); do
  fiscal_psql -U fiscal_persistence_runtime -d postgres -qAt -c "SELECT * FROM corestack_fiscal.register_request(public.test_snapshot('parallel'), encode(sha256(convert_to(public.test_snapshot('parallel'),'UTF8')),'hex'));" >/dev/null &
  fiscal_jobs+=("$!")
done
fiscal_failed=false
for fiscal_job in "${fiscal_jobs[@]}"; do
  if ! wait "$fiscal_job"; then fiscal_failed=true; fi
done
[[ "$fiscal_failed" == false ]] || exit 1
fiscal_psql <<'SQL'
DO $$ BEGIN
 IF (SELECT count(*) FROM corestack_fiscal.request_snapshot)<>11
 OR (SELECT count(*) FROM corestack_fiscal.document)<>11
 OR (SELECT count(*) FROM corestack_fiscal.preparation_job)<>11
 OR (SELECT count(*) FROM corestack_fiscal.audit_event)<>11
 OR (SELECT next_number FROM corestack_fiscal.sequence_range WHERE tenant_id='persistence' AND ecf_type=31)<>3
 THEN RAISE EXCEPTION 'Concurrent atomic persistence duplicated evidence/reservation'; END IF;
END $$;
SQL
echo 'PASS: atomic snapshot/document/reservation/job/audit, 10 types, scoped role, immutable evidence, rollback and 16 concurrent retries.'
fiscal_psql < "$fiscal_root/sql/003_preparation_worker.sql"
fiscal_psql < "$fiscal_root/test/preparation-worker.sql"
fiscal_psql < "$fiscal_root/sql/004_delivery_queue.sql"
fiscal_psql < "$fiscal_root/test/delivery.sql"
echo 'PASS: durable delivery, immutable artifact/audit, lost-send reconciliation, fencing and tenant isolation.'
fiscal_psql < "$fiscal_root/sql/005_signing_queue.sql"
fiscal_psql < "$fiscal_root/test/signing.sql"
echo 'PASS: explicit signing intent, paused-by-default control, idempotency, fencing and tenant isolation.'
fiscal_jobs=()
for ((request=1; request<=16; request++)); do
 fiscal_psql -U fiscal_persistence_runtime -d postgres -qAt -c 'SELECT corestack_fiscal.claim_preparation();' >/dev/null &
 fiscal_jobs+=("$!")
done
fiscal_failed=false
for fiscal_job in "${fiscal_jobs[@]}"; do
 if ! wait "$fiscal_job"; then fiscal_failed=true; fi
done
[[ "$fiscal_failed" == false ]] || exit 1
fiscal_psql <<'SQL'
DO $$ BEGIN
 IF (SELECT count(*) FROM corestack_fiscal.preparation_job WHERE state='RUNNING')<>8
 OR (SELECT count(DISTINCT claim_token) FROM corestack_fiscal.preparation_job WHERE state='RUNNING')<>8
 OR EXISTS(SELECT FROM corestack_fiscal.preparation_job WHERE state='RUNNING' AND attempts<>1)
 THEN RAISE EXCEPTION 'Concurrent worker claims duplicated/skipped eligible jobs'; END IF;
END $$;
SQL
echo 'PASS: lease fencing, bounded retries, recovery, atomic immutable XML, scoped access and 16 concurrent claimers.'
# Full restore rehearsal of synthetic fiscal schema, not merely pg_restore --list.
# Both databases disappear with this disposable, network-isolated container.
fiscal_psql -c 'CREATE DATABASE fiscal_restore_fixture;'
docker exec "$fiscal_container" pg_dump -U postgres -d postgres -n corestack_fiscal -Fc |
 docker exec -i "$fiscal_container" pg_restore -U postgres -d fiscal_restore_fixture --exit-on-error
fiscal_psql -d fiscal_restore_fixture <<'SQL'
DO $$ BEGIN
 IF (SELECT count(*) FROM corestack_fiscal.outbound_artifact)<>1
 OR (SELECT state FROM corestack_fiscal.delivery_job)<>'ACCEPTED'
 OR (SELECT count(*) FROM corestack_fiscal.delivery_event)<>6
 OR EXISTS(SELECT FROM corestack_fiscal.outbound_artifact WHERE
 xml_sha256<>encode(sha256(convert_to(xml_text,'UTF8')),'hex') OR
 signed_ecf_sha256<>encode(sha256(convert_to(signed_ecf_text,'UTF8')),'hex'))
 THEN RAISE EXCEPTION 'Restored delivery evidence differs'; END IF;
 BEGIN UPDATE corestack_fiscal.outbound_artifact SET xml_text=xml_text;
 RAISE EXCEPTION 'Restored immutable trigger missing';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SET SESSION AUTHORIZATION fiscal_persistence_runtime;
DO $$ BEGIN
 IF corestack_fiscal.delivery_health()#>>'{counts,ACCEPTED}'<>'1'
 OR corestack_fiscal.claim_delivery() IS NOT NULL
 THEN RAISE EXCEPTION 'Restored state or grants incorrect'; END IF;
END $$;
SQL
echo 'PASS: full synthetic fiscal backup/restore preserves evidence, hashes, immutable triggers, runtime grants and terminal delivery state.'
