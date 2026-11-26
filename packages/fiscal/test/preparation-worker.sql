GRANT EXECUTE ON FUNCTION corestack_fiscal.claim_preparation(),
 corestack_fiscal.complete_preparation(bigint,uuid,text,text,text,text),
 corestack_fiscal.fail_preparation(bigint,uuid,text),corestack_fiscal.read_preparation(bigint)
 TO fiscal_persistence_runtime;
SET SESSION AUTHORIZATION fiscal_persistence_runtime;
DO $$ DECLARE c jsonb; x text; digest text; rejected boolean:=false; BEGIN
 c:=corestack_fiscal.claim_preparation();
 IF c IS NULL THEN RAISE EXCEPTION 'No initial claim'; END IF;
 x:='<ECF><eNCF>'||(c->>'encf')||'</eNCF><RNCEmisor>101010632</RNCEmisor></ECF>';
 digest:=encode(sha256(convert_to(x,'UTF8')),'hex');
 BEGIN PERFORM corestack_fiscal.complete_preparation((c->>'jobId')::bigint,(c->>'claimToken')::uuid,x,repeat('0',64),repeat('a',64),'ECF');
 EXCEPTION WHEN raise_exception THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Invalid XML digest accepted'; END IF;
 PERFORM corestack_fiscal.complete_preparation((c->>'jobId')::bigint,(c->>'claimToken')::uuid,x,digest,repeat('a',64),'ECF');
 -- Repeating completion after a lost response must not create an event/artifact twice.
 PERFORM corestack_fiscal.complete_preparation((c->>'jobId')::bigint,(c->>'claimToken')::uuid,x,digest,repeat('a',64),'ECF');
 IF corestack_fiscal.read_preparation((c->>'documentId')::bigint)->>'xml'<>x
 OR corestack_fiscal.read_preparation((c->>'documentId')::bigint)->>'sendable'<>'false' THEN RAISE EXCEPTION 'Artifact read failed'; END IF;
 rejected:=false;
 BEGIN PERFORM corestack_fiscal.complete_preparation((c->>'jobId')::bigint,(c->>'claimToken')::uuid,x||' ',encode(sha256(convert_to(x||' ','UTF8')),'hex'),repeat('a',64),'ECF');
 EXCEPTION WHEN raise_exception THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Artifact overwrite accepted'; END IF;
END $$;
SELECT c->>'jobId' AS retry_job,c->>'claimToken' AS retry_token,c->>'plannedSignatureAt' AS planned
 FROM (SELECT corestack_fiscal.claim_preparation() c) q \gset
SELECT corestack_fiscal.fail_preparation(:'retry_job'::bigint,:'retry_token'::uuid,'WORKER_UNAVAILABLE');
SELECT corestack_fiscal.fail_preparation(:'retry_job'::bigint,:'retry_token'::uuid,'WORKER_UNAVAILABLE');
RESET SESSION AUTHORIZATION;
SELECT state='PENDING' AND available_at>clock_timestamp() AS delayed FROM corestack_fiscal.preparation_job WHERE id=:'retry_job'::bigint \gset
\if :delayed
\else
 \quit 1
\endif
UPDATE corestack_fiscal.preparation_job SET available_at='2000-01-01' WHERE id=:'retry_job'::bigint;
SET SESSION AUTHORIZATION fiscal_persistence_runtime;
SELECT c->>'jobId' AS new_job,c->>'claimToken' AS new_token,c->>'plannedSignatureAt' AS new_planned
 FROM (SELECT corestack_fiscal.claim_preparation() c) q \gset
SELECT :'new_job'=:'retry_job' AND :'new_token'<>:'retry_token' AND :'new_planned'=:'planned' AS fenced \gset
\if :fenced
\else
 \quit 1
\endif
-- Store only synthetic test tokens in custom settings for the exception assertion.
SELECT set_config('test.old_job',:'retry_job',false),set_config('test.old_token',:'retry_token',false);
DO $$ DECLARE rejected boolean:=false; BEGIN
 BEGIN PERFORM corestack_fiscal.fail_preparation(current_setting('test.old_job')::bigint,current_setting('test.old_token')::uuid,'INVALID_XML');
 EXCEPTION WHEN serialization_failure THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Obsolete worker token accepted'; END IF;
END $$;
RESET SESSION AUTHORIZATION;
-- Simulate five lost workers without waiting ten minutes; final claim dead-letters.
UPDATE corestack_fiscal.preparation_job SET attempts=5,lease_until='2000-01-01',available_at='2000-01-01' WHERE id=:'retry_job'::bigint;
SET SESSION AUTHORIZATION fiscal_persistence_runtime;
SELECT corestack_fiscal.claim_preparation() IS NULL AS exhausted \gset
\if :exhausted
\else
 \quit 1
\endif
DO $$ DECLARE c jsonb; result text; BEGIN
 c:=corestack_fiscal.claim_preparation();
 result:=corestack_fiscal.fail_preparation((c->>'jobId')::bigint,(c->>'claimToken')::uuid,'INVALID_XML');
 IF result<>'FAILED' THEN RAISE EXCEPTION 'Permanent validation error retried'; END IF;
END $$;
RESET SESSION AUTHORIZATION;
CREATE ROLE fiscal_other_worker LOGIN;
INSERT INTO corestack_fiscal.runtime_scope VALUES('fiscal_other_worker','other','101010632','precertification');
GRANT USAGE ON SCHEMA corestack_fiscal TO fiscal_other_worker;
GRANT EXECUTE ON FUNCTION corestack_fiscal.claim_preparation(),corestack_fiscal.read_preparation(bigint),
 corestack_fiscal.fail_preparation(bigint,uuid,text) TO fiscal_other_worker;
SET SESSION AUTHORIZATION fiscal_other_worker;
DO $$ BEGIN
 IF corestack_fiscal.claim_preparation() IS NOT NULL OR corestack_fiscal.read_preparation(1) IS NOT NULL THEN
  RAISE EXCEPTION 'Cross-tenant claim/read';
 END IF;
END $$;
SELECT set_config('test.old_job',:'retry_job',false),set_config('test.old_token',:'retry_token',false);
DO $$ DECLARE rejected boolean:=false; BEGIN
 BEGIN PERFORM corestack_fiscal.fail_preparation(current_setting('test.old_job')::bigint,current_setting('test.old_token')::uuid,'INVALID_XML');
 EXCEPTION WHEN insufficient_privilege THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Cross-tenant failure accepted'; END IF;
END $$;
RESET SESSION AUTHORIZATION;
DO $$ DECLARE rejected boolean:=false; BEGIN
 BEGIN UPDATE corestack_fiscal.document_artifact SET xml_text=xml_text;
 EXCEPTION WHEN insufficient_privilege THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Mutable artifact'; END IF;
 IF (SELECT count(*) FROM corestack_fiscal.document_artifact)<>1
 OR (SELECT count(*) FROM corestack_fiscal.audit_event WHERE event_code='UNSIGNED_XML_STORED')<>1
 OR (SELECT count(*) FROM corestack_fiscal.audit_event WHERE event_code='PREPARATION_RETRY')<>1
 OR (SELECT count(*) FROM corestack_fiscal.audit_event WHERE event_code='PREPARATION_FAILED')<>2
 THEN RAISE EXCEPTION 'Duplicate/missing atomic events'; END IF;
END $$;
