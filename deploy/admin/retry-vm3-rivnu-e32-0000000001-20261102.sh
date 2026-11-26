#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly database='rivnu_fiscal_prod'
readonly stage="/var/lib/corestack-pki/rivnu-e32-retry-20261102-$(date -u +%Y%m%dT%H%M%SZ)"
fail(){ printf '%s\n' "$1" >&2; exit 1; }
pg(){ sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d "$database" -v ON_ERROR_STOP=1 "$@"; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail RUN_WITH_SUDO_ON_VM3
install -d -o root -g root -m 0700 "$stage"
sudo -u postgres pg_dump -h /var/run/postgresql -p 5432 -d "$database" \
  --format=custom >"$stage/before.dump"
chmod 0600 "$stage/before.dump"

pg <<'SQL'
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('RIVNU_E320000000001_SIGNING_RECOVERY',0));

DO $$
DECLARE valid_rows integer;
BEGIN
 SELECT count(*) INTO valid_rows
 FROM corestack_fiscal.document d
 JOIN corestack_fiscal.request_snapshot r ON r.id=d.request_id
 JOIN corestack_fiscal.preparation_job p ON p.document_id=d.id
 JOIN corestack_fiscal.signing_job s ON s.document_id=d.id
 WHERE d.id=1 AND d.encf='E320000000001'
   AND r.source_document_id='cmvzvt4bs000joh075va5rkbg'
   AND r.tenant_id='cmqn0r66a0002lit0vxbzq5l4'
   AND r.issuer_rnc='40220429126' AND r.environment='production'
   AND p.state='DONE' AND s.state='FAILED' AND s.attempts=5
   AND s.last_error IN ('SIGNING_FAILED','ATTEMPTS_EXHAUSTED')
   AND NOT EXISTS(SELECT FROM corestack_fiscal.outbound_artifact a WHERE a.document_id=d.id)
   AND NOT EXISTS(SELECT FROM corestack_fiscal.delivery_job q WHERE q.document_id=d.id);
 IF valid_rows<>1 THEN
   RAISE EXCEPTION 'E32_RECOVERY_PRECONDITION_FAILED';
 END IF;
END $$;

UPDATE corestack_fiscal.signing_job
SET state='REQUESTED',attempts=0,available_at=clock_timestamp(),
    claim_token=NULL,claimed_by=NULL,lease_until=NULL,last_error=NULL,
    updated_at=clock_timestamp()
WHERE document_id=1;

INSERT INTO corestack_fiscal.signing_event(document_id,event_code)
VALUES(1,'RETRY');
COMMIT;
SQL

printf 'RIVNU_E32_0000000001_SIGNING_RETRY_REQUESTED backup=%s\n' "$stage"
printf '%s\n' 'The existing reserved e-NCF is reused; no new sequence was reserved.'
