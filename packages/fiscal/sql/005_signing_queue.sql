-- Explicit signing intent. Installation and processing controls start paused.
BEGIN;
CREATE TABLE corestack_fiscal.signing_control (
 tenant_id text NOT NULL, issuer_rnc text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('precertification','certification','production')),
 paused boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,issuer_rnc,environment)
);
CREATE TABLE corestack_fiscal.signing_job (
 document_id bigint PRIMARY KEY REFERENCES corestack_fiscal.document(id),
 state text NOT NULL DEFAULT 'REQUESTED' CHECK(state IN ('REQUESTED','SIGNING','ENQUEUED','FAILED')),
 claim_token uuid, claimed_by name, lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX signing_ready ON corestack_fiscal.signing_job(available_at,document_id)
 WHERE state IN ('REQUESTED','SIGNING');
CREATE TABLE corestack_fiscal.signing_event (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 document_id bigint NOT NULL REFERENCES corestack_fiscal.signing_job(document_id),
 event_code text NOT NULL CHECK(event_code IN ('REQUESTED','CLAIMED','ENQUEUED','RETRY','FAILED')),
 actor name NOT NULL DEFAULT session_user,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_signing_event BEFORE UPDATE OR DELETE ON corestack_fiscal.signing_event
 FOR EACH ROW EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();
CREATE TRIGGER no_truncate_signing_event BEFORE TRUNCATE ON corestack_fiscal.signing_event
 FOR EACH STATEMENT EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();

CREATE FUNCTION corestack_fiscal.request_signing(p_document bigint) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE saved corestack_fiscal.signing_job%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT FROM corestack_fiscal.document d
  JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
  JOIN corestack_fiscal.runtime_scope b ON b.login_role=session_user
   AND (b.tenant_id,b.issuer_rnc,b.environment)=(s.tenant_id,s.issuer_rnc,s.environment)
  JOIN corestack_fiscal.preparation_job p ON p.document_id=d.id AND p.state='DONE'
  JOIN corestack_fiscal.document_artifact a ON a.document_id=d.id
  WHERE d.id=p_document)
 THEN RAISE EXCEPTION 'Document not prepared or scope mismatch' USING ERRCODE='42501'; END IF;
 SELECT * INTO saved FROM corestack_fiscal.signing_job WHERE document_id=p_document;
 IF FOUND THEN RETURN false; END IF;
 INSERT INTO corestack_fiscal.signing_job(document_id) VALUES(p_document);
 INSERT INTO corestack_fiscal.signing_event(document_id,event_code) VALUES(p_document,'REQUESTED');
 RETURN true;
END $$;

CREATE FUNCTION corestack_fiscal.claim_signing() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE job corestack_fiscal.signing_job%ROWTYPE;
BEGIN
 SELECT j.* INTO job FROM corestack_fiscal.signing_job j
 JOIN corestack_fiscal.document d ON d.id=j.document_id
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
 JOIN corestack_fiscal.runtime_scope b ON b.login_role=session_user
  AND (b.tenant_id,b.issuer_rnc,b.environment)=(s.tenant_id,s.issuer_rnc,s.environment)
 JOIN corestack_fiscal.signing_control ctl
  ON (ctl.tenant_id,ctl.issuer_rnc,ctl.environment)=(s.tenant_id,s.issuer_rnc,s.environment) AND NOT ctl.paused
 WHERE j.state IN ('REQUESTED','SIGNING') AND j.available_at<=clock_timestamp()
  AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp())
 ORDER BY j.available_at,j.document_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF job.attempts>=5 THEN
  UPDATE corestack_fiscal.signing_job SET state='FAILED',claim_token=NULL,claimed_by=NULL,
   lease_until=NULL,last_error='ATTEMPTS_EXHAUSTED',updated_at=clock_timestamp()
   WHERE document_id=job.document_id;
  INSERT INTO corestack_fiscal.signing_event(document_id,event_code) VALUES(job.document_id,'FAILED');
  RETURN NULL;
 END IF;
 UPDATE corestack_fiscal.signing_job SET state='SIGNING',attempts=attempts+1,
  claim_token=gen_random_uuid(),claimed_by=session_user,lease_until=clock_timestamp()+interval '120 seconds',
  last_error=NULL,updated_at=clock_timestamp() WHERE document_id=job.document_id RETURNING * INTO job;
 INSERT INTO corestack_fiscal.signing_event(document_id,event_code) VALUES(job.document_id,'CLAIMED');
 RETURN jsonb_build_object('documentId',job.document_id::text,'claimToken',job.claim_token::text);
END $$;

CREATE FUNCTION corestack_fiscal.complete_signing(p_document bigint,p_token uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE job corestack_fiscal.signing_job%ROWTYPE;
BEGIN
 SELECT j.* INTO job FROM corestack_fiscal.signing_job j
 JOIN corestack_fiscal.document d ON d.id=j.document_id
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
 JOIN corestack_fiscal.runtime_scope b ON b.login_role=session_user
  AND (b.tenant_id,b.issuer_rnc,b.environment)=(s.tenant_id,s.issuer_rnc,s.environment)
 WHERE j.document_id=p_document FOR UPDATE OF j;
 IF NOT FOUND OR job.claim_token IS DISTINCT FROM p_token OR job.claimed_by IS DISTINCT FROM session_user
  OR job.state<>'SIGNING' OR job.lease_until<=clock_timestamp() THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT FROM corestack_fiscal.outbound_artifact WHERE document_id=p_document)
 THEN RAISE EXCEPTION 'Signed artifact not durably enqueued'; END IF;
 UPDATE corestack_fiscal.signing_job SET state='ENQUEUED',claim_token=NULL,claimed_by=NULL,
  lease_until=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE document_id=p_document;
 INSERT INTO corestack_fiscal.signing_event(document_id,event_code) VALUES(p_document,'ENQUEUED');
 RETURN true;
END $$;

CREATE FUNCTION corestack_fiscal.fail_signing(p_document bigint,p_token uuid,p_code text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE job corestack_fiscal.signing_job%ROWTYPE; terminal boolean;
BEGIN
 IF p_code NOT IN ('SIGNING_FAILED','SOURCE_INVALID','QUEUE_UNAVAILABLE') THEN
  RAISE EXCEPTION 'Invalid signing failure code'; END IF;
 SELECT j.* INTO job FROM corestack_fiscal.signing_job j
 JOIN corestack_fiscal.document d ON d.id=j.document_id
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
 JOIN corestack_fiscal.runtime_scope b ON b.login_role=session_user
  AND (b.tenant_id,b.issuer_rnc,b.environment)=(s.tenant_id,s.issuer_rnc,s.environment)
 WHERE j.document_id=p_document FOR UPDATE OF j;
 IF NOT FOUND OR job.claim_token IS DISTINCT FROM p_token OR job.claimed_by IS DISTINCT FROM session_user
  OR job.state<>'SIGNING' OR job.lease_until<=clock_timestamp() THEN RETURN false; END IF;
 terminal:=p_code='SOURCE_INVALID' OR job.attempts>=5;
 UPDATE corestack_fiscal.signing_job SET state=CASE WHEN terminal THEN 'FAILED' ELSE 'REQUESTED' END,
  claim_token=NULL,claimed_by=NULL,lease_until=NULL,last_error=p_code,
  available_at=clock_timestamp()+make_interval(secs=>least(300,30*attempts)),updated_at=clock_timestamp()
  WHERE document_id=p_document;
 INSERT INTO corestack_fiscal.signing_event(document_id,event_code)
  VALUES(p_document,CASE WHEN terminal THEN 'FAILED' ELSE 'RETRY' END);
 RETURN true;
END $$;
REVOKE ALL ON corestack_fiscal.signing_control,corestack_fiscal.signing_job,corestack_fiscal.signing_event FROM PUBLIC;
REVOKE ALL ON SEQUENCE corestack_fiscal.signing_event_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION corestack_fiscal.request_signing(bigint),corestack_fiscal.claim_signing(),
 corestack_fiscal.complete_signing(bigint,uuid),corestack_fiscal.fail_signing(bigint,uuid,text) FROM PUBLIC;
COMMIT;
