CREATE ROLE fiscal_persistence_runtime LOGIN;
GRANT USAGE ON SCHEMA corestack_fiscal TO fiscal_persistence_runtime;
GRANT EXECUTE ON FUNCTION corestack_fiscal.register_request(text,text) TO fiscal_persistence_runtime;
INSERT INTO corestack_fiscal.runtime_scope VALUES ('fiscal_persistence_runtime','persistence','101010632','precertification');
DO $$ DECLARE t smallint; BEGIN
 FOREACH t IN ARRAY ARRAY[31,32,33,34,41,43,44,45,46,47]::smallint[] LOOP
  PERFORM corestack_fiscal.register_range('persistence','101010632','precertification',t,1,100,'2026-01-01','2026-12-31','SYNTHETIC-PERSISTENCE');
 END LOOP;
END $$;
-- Test fixture only, not a fiscal-valid payload; DB tests do not replace mapper validation.
CREATE FUNCTION public.test_snapshot(op text,t smallint DEFAULT 31) RETURNS text LANGUAGE sql AS $$
 SELECT jsonb_build_object('scope',jsonb_build_object('tenantId','persistence','issuerRnc','101010632','environment','precertification'),
 'request',jsonb_build_object('version','1','operationId',op,'source',jsonb_build_object('documentId',op,'revision','1'),
 'type',t,'issuedOn','2026-09-21','issuer',jsonb_build_object('rnc','101010632')))::text
$$;
SET SESSION AUTHORIZATION fiscal_persistence_runtime;
DO $$ DECLARE t smallint; p text; first_result record; retry_result record; rejected boolean; BEGIN
 FOREACH t IN ARRAY ARRAY[31,32,33,34,41,43,44,45,46,47]::smallint[] LOOP
  p:=public.test_snapshot('type-'||t,t);
  SELECT * INTO first_result FROM corestack_fiscal.register_request(p,encode(sha256(convert_to(p,'UTF8')),'hex'));
  SELECT * INTO retry_result FROM corestack_fiscal.register_request(p,encode(sha256(convert_to(p,'UTF8')),'hex'));
  IF first_result.reused OR NOT retry_result.reused OR first_result.document_id<>retry_result.document_id
   OR first_result.encf<>'E'||t||'0000000001' THEN RAISE EXCEPTION 'Atomic registration/retry failed'; END IF;
 END LOOP;
 rejected:=false;
 BEGIN UPDATE corestack_fiscal.request_snapshot SET payload_text='{}';
 EXCEPTION WHEN insufficient_privilege THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Direct snapshot write permitted'; END IF;
 rejected:=false;
 BEGIN PERFORM corestack_fiscal.reserve_encf('persistence','101010632','precertification',31::smallint,'bypass',repeat('a',64),'2026-09-21');
 EXCEPTION WHEN insufficient_privilege THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Direct reservation bypass permitted'; END IF;
 rejected:=false;
 BEGIN PERFORM corestack_fiscal.register_request(p,repeat('0',64));
 EXCEPTION WHEN raise_exception THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Digest mismatch accepted'; END IF;
 p:=jsonb_set(p::jsonb,'{scope,environment}','"production"')::text;
 rejected:=false;
 BEGIN PERFORM corestack_fiscal.register_request(p,encode(sha256(convert_to(p,'UTF8')),'hex'));
 EXCEPTION WHEN insufficient_privilege THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Scope spoof accepted'; END IF;
 p:=jsonb_set(public.test_snapshot('type-31')::jsonb,'{request,issuedOn}','"2026-09-22"')::text;
 rejected:=false;
 BEGIN PERFORM corestack_fiscal.register_request(p,encode(sha256(convert_to(p,'UTF8')),'hex'));
 EXCEPTION WHEN raise_exception THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Changed retry accepted'; END IF;
 p:=jsonb_set(public.test_snapshot('new-operation')::jsonb,'{request,source,documentId}','"type-31"')::text;
 rejected:=false;
 BEGIN PERFORM corestack_fiscal.register_request(p,encode(sha256(convert_to(p,'UTF8')),'hex'));
 EXCEPTION WHEN unique_violation THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Same source/revision accepted under new operation'; END IF;
END $$;
RESET SESSION AUTHORIZATION;
DO $$ DECLARE rejected boolean:=false; BEGIN
 BEGIN UPDATE corestack_fiscal.request_snapshot SET operation_id='altered';
 EXCEPTION WHEN insufficient_privilege THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Immutability trigger failed'; END IF;
 IF (SELECT count(*) FROM corestack_fiscal.request_snapshot)<>10
 OR (SELECT count(*) FROM corestack_fiscal.document)<>10
 OR (SELECT count(*) FROM corestack_fiscal.preparation_job)<>10
 OR (SELECT count(*) FROM corestack_fiscal.audit_event)<>10 THEN RAISE EXCEPTION 'Atomic evidence counts differ'; END IF;
END $$;
-- Force a failure AFTER reservation and document insertion.
CREATE FUNCTION public.fail_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic job failure'; END $$;
CREATE TRIGGER test_job_failure BEFORE INSERT ON corestack_fiscal.preparation_job FOR EACH ROW EXECUTE FUNCTION public.fail_job();
SET SESSION AUTHORIZATION fiscal_persistence_runtime;
DO $$ DECLARE p text:=public.test_snapshot('must-rollback'); rejected boolean:=false; BEGIN
 BEGIN PERFORM corestack_fiscal.register_request(p,encode(sha256(convert_to(p,'UTF8')),'hex'));
 EXCEPTION WHEN raise_exception THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Injected failure not propagated'; END IF;
END $$;
RESET SESSION AUTHORIZATION;
DROP TRIGGER test_job_failure ON corestack_fiscal.preparation_job;
DO $$ BEGIN
 IF EXISTS(SELECT FROM corestack_fiscal.request_snapshot WHERE operation_id='must-rollback')
 OR EXISTS(SELECT FROM corestack_fiscal.sequence_reservation WHERE operation_id='must-rollback')
 OR (SELECT next_number FROM corestack_fiscal.sequence_range WHERE tenant_id='persistence' AND ecf_type=31)<>2
 THEN RAISE EXCEPTION 'Failure left evidence or consumed e-NCF'; END IF;
END $$;
