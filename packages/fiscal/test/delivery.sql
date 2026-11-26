-- Database contract test ONLY. Synthetic XML is deliberately not a real signature.
GRANT EXECUTE ON FUNCTION corestack_fiscal.enqueue_delivery(bigint,text,text,text,text,text,text),
 corestack_fiscal.claim_delivery(),corestack_fiscal.complete_delivery(bigint,uuid,text,text,jsonb),corestack_fiscal.delivery_health()
 TO fiscal_persistence_runtime,fiscal_other_worker;
SELECT document_id AS delivery_document,xml_sha256 AS source_hash FROM corestack_fiscal.document_artifact LIMIT 1 \gset
SET SESSION AUTHORIZATION fiscal_persistence_runtime;
SELECT corestack_fiscal.enqueue_delivery(:'delivery_document','<Synthetic/>',encode(sha256(convert_to('<Synthetic/>','UTF8')),'hex'),:'source_hash',repeat('a',64),'<Synthetic/>',encode(sha256(convert_to('<Synthetic/>','UTF8')),'hex')) AS created \gset
\if :created
\else
 \quit 1
\endif
SELECT NOT corestack_fiscal.enqueue_delivery(:'delivery_document','<Synthetic/>',encode(sha256(convert_to('<Synthetic/>','UTF8')),'hex'),:'source_hash',repeat('a',64),'<Synthetic/>',encode(sha256(convert_to('<Synthetic/>','UTF8')),'hex')) AS reused \gset
\if :reused
\else
 \quit 1
\endif
DO $$ BEGIN
 IF corestack_fiscal.claim_delivery() IS NOT NULL
 OR corestack_fiscal.delivery_health()->>'paused'<>'true'
 THEN RAISE EXCEPTION 'Unconfigured delivery must stay paused'; END IF;
END $$;
RESET SESSION AUTHORIZATION;
INSERT INTO corestack_fiscal.delivery_control VALUES('persistence','101010632','precertification',false,clock_timestamp());
SET SESSION AUTHORIZATION fiscal_persistence_runtime;
SELECT c->>'claimToken' AS first_token,c->>'action'='SEND' AS send FROM (SELECT corestack_fiscal.claim_delivery() c) q \gset
\if :send
\else
 \quit 1
\endif
DO $$ BEGIN
 IF corestack_fiscal.claim_delivery() IS NOT NULL THEN RAISE EXCEPTION 'Lease claimed twice'; END IF;
 BEGIN UPDATE corestack_fiscal.delivery_job SET state='READY'; RAISE EXCEPTION 'Direct write allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET SESSION AUTHORIZATION;
-- Crash after possible POST: expire lease without recording any response.
UPDATE corestack_fiscal.delivery_job SET lease_until='2000-01-01';
SET SESSION AUTHORIZATION fiscal_other_worker;
DO $$ BEGIN
 IF corestack_fiscal.claim_delivery() IS NOT NULL THEN RAISE EXCEPTION 'Cross tenant claim'; END IF;
END $$;
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION fiscal_persistence_runtime;
SELECT c->>'claimToken' AS next_token,c->>'action'='RECONCILE' AS reconcile FROM (SELECT corestack_fiscal.claim_delivery() c) q \gset
\if :reconcile
\else
 \quit 1
\endif
SELECT NOT corestack_fiscal.complete_delivery(:'delivery_document',:'first_token','ACCEPTED',NULL,'{}') AS fenced \gset
\if :fenced
\else
 \quit 1
\endif
SELECT corestack_fiscal.complete_delivery(:'delivery_document',:'next_token','PROCESSING','synthetic-track','{"code":3}');
RESET SESSION AUTHORIZATION;
UPDATE corestack_fiscal.delivery_job SET available_at='2000-01-01';
SET SESSION AUTHORIZATION fiscal_persistence_runtime;
SELECT c->>'claimToken' AS final_token,c->>'trackId'='synthetic-track' AS bound FROM (SELECT corestack_fiscal.claim_delivery() c) q \gset
\if :bound
\else
 \quit 1
\endif
SELECT corestack_fiscal.complete_delivery(:'delivery_document',:'final_token','ACCEPTED','synthetic-track','{"code":1}');
DO $$ BEGIN
 IF corestack_fiscal.claim_delivery() IS NOT NULL THEN RAISE EXCEPTION 'Terminal job reclaimed'; END IF;
 IF corestack_fiscal.delivery_health()#>>'{counts,ACCEPTED}'<>'1'
 THEN RAISE EXCEPTION 'Health state missing'; END IF;
END $$;
RESET SESSION AUTHORIZATION;
DO $$ BEGIN
 IF (SELECT state FROM corestack_fiscal.delivery_job)<>'ACCEPTED'
 OR (SELECT count(*) FROM corestack_fiscal.outbound_artifact)<>1
 OR (SELECT count(*) FROM corestack_fiscal.delivery_event)<>6
 THEN RAISE EXCEPTION 'Missing/duplicated delivery evidence'; END IF;
 BEGIN DELETE FROM corestack_fiscal.outbound_artifact; RAISE EXCEPTION 'Artifact deletion allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN TRUNCATE corestack_fiscal.delivery_event; RAISE EXCEPTION 'Audit truncation allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
