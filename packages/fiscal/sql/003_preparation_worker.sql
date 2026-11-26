-- Offline unsigned-XML preparation only. No DGII transport or signing capability.
BEGIN;
ALTER TABLE corestack_fiscal.preparation_job
 ADD COLUMN claim_token uuid,
 ADD COLUMN claimed_by name,
 ADD COLUMN lease_until timestamptz,
 ADD COLUMN planned_signature_at text,
 ADD COLUMN last_error_code text;
CREATE INDEX preparation_job_ready ON corestack_fiscal.preparation_job(state,available_at,lease_until,id);
ALTER TABLE corestack_fiscal.audit_event DROP CONSTRAINT audit_event_event_code_check;
ALTER TABLE corestack_fiscal.audit_event ADD CHECK(event_code IN
 ('REQUEST_REGISTERED','PREPARATION_CLAIMED','PREPARATION_RETRY','PREPARATION_FAILED','UNSIGNED_XML_STORED'));
CREATE TABLE corestack_fiscal.document_artifact (
 document_id bigint PRIMARY KEY REFERENCES corestack_fiscal.document(id),
 kind text NOT NULL DEFAULT 'UNSIGNED_ECF' CHECK(kind='UNSIGNED_ECF'),
 xml_text text NOT NULL CHECK(octet_length(xml_text) BETWEEN 1 AND 2097152),
 xml_sha256 text NOT NULL CHECK(xml_sha256=encode(sha256(convert_to(xml_text,'UTF8')),'hex')),
 schema_sha256 text NOT NULL CHECK(schema_sha256 ~ '^[a-f0-9]{64}$'),
 validation_profile text NOT NULL CHECK(validation_profile='DGII_V1_UNSIGNED_XSD'),
 mapping_profile text NOT NULL CHECK(mapping_profile='DOP_BASIC_V1'),
 planned_route text NOT NULL CHECK(planned_route IN ('ECF','RFCE')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_artifact BEFORE UPDATE OR DELETE ON corestack_fiscal.document_artifact
 FOR EACH ROW EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();
CREATE TRIGGER no_truncate_artifact BEFORE TRUNCATE ON corestack_fiscal.document_artifact
 FOR EACH STATEMENT EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();

CREATE FUNCTION corestack_fiscal.claim_preparation() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE job corestack_fiscal.preparation_job%ROWTYPE; result jsonb;
BEGIN
 IF NOT EXISTS(SELECT FROM corestack_fiscal.runtime_scope WHERE login_role=session_user) THEN
  RAISE EXCEPTION 'Unbound worker identity' USING ERRCODE='42501';
 END IF;
 SELECT j.* INTO job FROM corestack_fiscal.preparation_job j
 JOIN corestack_fiscal.document d ON d.id=j.document_id
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
 JOIN corestack_fiscal.runtime_scope b ON b.login_role=session_user
  AND (b.tenant_id,b.issuer_rnc,b.environment)=(s.tenant_id,s.issuer_rnc,s.environment)
 WHERE (j.state='PENDING' AND j.available_at<=clock_timestamp())
    OR (j.state='RUNNING' AND j.lease_until<=clock_timestamp())
 ORDER BY j.available_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF job.attempts>=5 THEN
  UPDATE corestack_fiscal.preparation_job SET state='FAILED',lease_until=NULL,last_error_code='LEASE_EXHAUSTED' WHERE id=job.id;
  INSERT INTO corestack_fiscal.audit_event(document_id,event_code,actor) VALUES(job.document_id,'PREPARATION_FAILED',session_user);
  RETURN NULL;
 END IF;
 UPDATE corestack_fiscal.preparation_job SET state='RUNNING', attempts=attempts+1,
  claim_token=gen_random_uuid(),claimed_by=session_user,lease_until=clock_timestamp()+interval '120 seconds',
  planned_signature_at=coalesce(planned_signature_at,
   to_char(clock_timestamp() AT TIME ZONE 'America/Santo_Domingo','YYYY-MM-DD"T"HH24:MI:SS')||'-04:00'),
  last_error_code=NULL
 WHERE id=job.id RETURNING * INTO job;
 INSERT INTO corestack_fiscal.audit_event(document_id,event_code,actor) VALUES(job.document_id,'PREPARATION_CLAIMED',session_user);
 SELECT jsonb_build_object('jobId',job.id::text,'documentId',d.id::text,'claimToken',job.claim_token::text,
  'attempt',job.attempts,'snapshotText',s.payload_text,'payloadSha256',s.payload_sha256,
  'encf',d.encf,'validUntil',r.valid_until::text,'plannedSignatureAt',job.planned_signature_at)
 INTO result FROM corestack_fiscal.document d
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
 JOIN corestack_fiscal.sequence_reservation sr ON sr.id=d.reservation_id
 JOIN corestack_fiscal.sequence_range r ON r.id=sr.range_id WHERE d.id=job.document_id;
 RETURN result;
END $$;

CREATE FUNCTION corestack_fiscal.complete_preparation(p_job bigint,p_token uuid,p_xml text,p_sha256 text,p_schema_hash text,p_route text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE job corestack_fiscal.preparation_job%ROWTYPE; assigned text; issuer text; saved corestack_fiscal.document_artifact%ROWTYPE;
BEGIN
 SELECT j.* INTO job FROM corestack_fiscal.preparation_job j
 JOIN corestack_fiscal.document d ON d.id=j.document_id
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
 JOIN corestack_fiscal.runtime_scope b ON b.login_role=session_user
  AND (b.tenant_id,b.issuer_rnc,b.environment)=(s.tenant_id,s.issuer_rnc,s.environment)
 WHERE j.id=p_job FOR UPDATE OF j;
 IF NOT FOUND THEN RAISE EXCEPTION 'Job scope mismatch' USING ERRCODE='42501'; END IF;
 IF p_token IS NULL OR job.claim_token IS DISTINCT FROM p_token OR job.claimed_by IS DISTINCT FROM session_user THEN
  RAISE EXCEPTION 'Stale worker claim' USING ERRCODE='40001';
 END IF;
 IF job.state='DONE' THEN
  SELECT * INTO STRICT saved FROM corestack_fiscal.document_artifact WHERE document_id=job.document_id;
  IF (saved.xml_text,saved.xml_sha256,saved.schema_sha256,saved.planned_route) IS DISTINCT FROM (p_xml,p_sha256,p_schema_hash,p_route) THEN
   RAISE EXCEPTION 'Immutable artifact conflict';
  END IF;
  RETURN true;
 END IF;
 IF job.state<>'RUNNING' OR job.lease_until IS NULL OR job.lease_until<=clock_timestamp() THEN
  RAISE EXCEPTION 'Expired worker lease' USING ERRCODE='40001';
 END IF;
 SELECT d.encf,s.issuer_rnc INTO assigned,issuer FROM corestack_fiscal.document d
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id WHERE d.id=job.document_id;
 IF p_xml IS NULL OR octet_length(p_xml) NOT BETWEEN 1 AND 2097152
  OR p_sha256 IS NULL OR p_sha256<>encode(sha256(convert_to(p_xml,'UTF8')),'hex')
  OR p_schema_hash IS NULL OR p_schema_hash !~ '^[a-f0-9]{64}$'
  OR p_route IS NULL OR p_route NOT IN ('ECF','RFCE') OR p_xml ~ '<!'
  OR strpos(p_xml,'<eNCF>'||assigned||'</eNCF>')=0
  OR strpos(p_xml,'<RNCEmisor>'||issuer||'</RNCEmisor>')=0
 THEN RAISE EXCEPTION 'Invalid unsigned artifact evidence'; END IF;
 INSERT INTO corestack_fiscal.document_artifact(document_id,xml_text,xml_sha256,schema_sha256,validation_profile,mapping_profile,planned_route)
 VALUES(job.document_id,p_xml,p_sha256,p_schema_hash,'DGII_V1_UNSIGNED_XSD','DOP_BASIC_V1',p_route);
 UPDATE corestack_fiscal.preparation_job SET state='DONE',lease_until=NULL,last_error_code=NULL WHERE id=job.id;
 INSERT INTO corestack_fiscal.audit_event(document_id,event_code,actor) VALUES(job.document_id,'UNSIGNED_XML_STORED',session_user);
 RETURN true;
END $$;

CREATE FUNCTION corestack_fiscal.fail_preparation(p_job bigint,p_token uuid,p_code text)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE job corestack_fiscal.preparation_job%ROWTYPE; next_state text;
BEGIN
 IF p_code IS NULL OR p_code NOT IN ('INVALID_SNAPSHOT','INVALID_XML','SCHEMA_UNAVAILABLE','WORKER_UNAVAILABLE') THEN
  RAISE EXCEPTION 'Unknown sanitized failure code';
 END IF;
 SELECT j.* INTO job FROM corestack_fiscal.preparation_job j
 JOIN corestack_fiscal.document d ON d.id=j.document_id
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
 JOIN corestack_fiscal.runtime_scope b ON b.login_role=session_user
  AND (b.tenant_id,b.issuer_rnc,b.environment)=(s.tenant_id,s.issuer_rnc,s.environment)
 WHERE j.id=p_job FOR UPDATE OF j;
 IF NOT FOUND THEN RAISE EXCEPTION 'Job scope mismatch' USING ERRCODE='42501'; END IF;
 IF p_token IS NULL OR job.claim_token IS DISTINCT FROM p_token OR job.claimed_by IS DISTINCT FROM session_user THEN
  RAISE EXCEPTION 'Stale worker claim' USING ERRCODE='40001';
 END IF;
 IF job.state IN ('PENDING','FAILED') AND job.last_error_code=p_code THEN RETURN job.state; END IF;
 IF job.state<>'RUNNING' OR job.lease_until IS NULL OR job.lease_until<=clock_timestamp() THEN
  RAISE EXCEPTION 'Expired worker lease' USING ERRCODE='40001';
 END IF;
 next_state:=CASE WHEN p_code IN ('INVALID_SNAPSHOT','INVALID_XML') OR job.attempts>=5 THEN 'FAILED' ELSE 'PENDING' END;
 UPDATE corestack_fiscal.preparation_job SET state=next_state,lease_until=NULL,last_error_code=p_code,
  available_at=clock_timestamp()+make_interval(secs=>least(300,30*(2^(job.attempts-1))::integer)) WHERE id=job.id;
 INSERT INTO corestack_fiscal.audit_event(document_id,event_code,actor)
 VALUES(job.document_id,CASE WHEN next_state='FAILED' THEN 'PREPARATION_FAILED' ELSE 'PREPARATION_RETRY' END,session_user);
 RETURN next_state;
END $$;

CREATE FUNCTION corestack_fiscal.read_preparation(p_document bigint) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,corestack_fiscal AS $$
 SELECT jsonb_build_object('documentId',d.id::text,'encf',d.encf,'state',j.state,'attempts',j.attempts,
  'lastErrorCode',j.last_error_code,'xml',a.xml_text,'xmlSha256',a.xml_sha256,
  'schemaSha256',a.schema_sha256,'sendable',false)
 FROM corestack_fiscal.document d JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
 JOIN corestack_fiscal.runtime_scope b ON b.login_role=session_user
  AND (b.tenant_id,b.issuer_rnc,b.environment)=(s.tenant_id,s.issuer_rnc,s.environment)
 JOIN corestack_fiscal.preparation_job j ON j.document_id=d.id
 LEFT JOIN corestack_fiscal.document_artifact a ON a.document_id=d.id WHERE d.id=p_document
$$;
REVOKE ALL ON ALL TABLES IN SCHEMA corestack_fiscal FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA corestack_fiscal FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA corestack_fiscal FROM PUBLIC;
COMMIT;
