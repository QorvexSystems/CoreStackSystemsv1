-- SQL contract only; cryptographic signing is tested separately.
GRANT EXECUTE ON FUNCTION corestack_fiscal.request_signing(bigint),corestack_fiscal.claim_signing(),
 corestack_fiscal.complete_signing(bigint,uuid),corestack_fiscal.fail_signing(bigint,uuid,text)
 TO fiscal_persistence_runtime,fiscal_other_worker;
INSERT INTO corestack_fiscal.signing_control VALUES
 ('persistence','101010632','precertification',true,clock_timestamp()),
 ('other','101010632','precertification',true,clock_timestamp());
SELECT document_id AS signing_document FROM corestack_fiscal.outbound_artifact LIMIT 1 \gset
SET SESSION AUTHORIZATION fiscal_persistence_runtime;
SELECT corestack_fiscal.request_signing(:'signing_document') AS requested \gset
\if :requested
\else
 \quit 1
\endif
SELECT NOT corestack_fiscal.request_signing(:'signing_document') AS idempotent \gset
\if :idempotent
\else
 \quit 1
\endif
DO $$ BEGIN IF corestack_fiscal.claim_signing() IS NOT NULL THEN
 RAISE EXCEPTION 'Paused signing queue claimed work'; END IF; END $$;
RESET SESSION AUTHORIZATION;
UPDATE corestack_fiscal.signing_control SET paused=false WHERE tenant_id='persistence';
SET SESSION AUTHORIZATION fiscal_other_worker;
DO $$ BEGIN IF corestack_fiscal.claim_signing() IS NOT NULL THEN
 RAISE EXCEPTION 'Cross-tenant signer claimed work'; END IF; END $$;
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION fiscal_persistence_runtime;
SELECT c->>'documentId' AS claimed_document,c->>'claimToken' AS signing_token
 FROM (SELECT corestack_fiscal.claim_signing() c) q \gset
SELECT :'claimed_document'=:'signing_document' AS correct_claim \gset
\if :correct_claim
\else
 \quit 1
\endif
SELECT corestack_fiscal.complete_signing(:'claimed_document'::bigint,:'signing_token'::uuid) AS completed \gset
\if :completed
\else
 \quit 1
\endif
DO $$ BEGIN IF corestack_fiscal.claim_signing() IS NOT NULL THEN
 RAISE EXCEPTION 'Terminal signing job reclaimed'; END IF; END $$;
RESET SESSION AUTHORIZATION;
DO $$ BEGIN
 IF (SELECT state FROM corestack_fiscal.signing_job)<>'ENQUEUED'
 OR (SELECT count(*) FROM corestack_fiscal.signing_event)<>3
 THEN RAISE EXCEPTION 'Signing state/evidence mismatch'; END IF;
END $$;
