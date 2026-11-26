-- Reviewed deployment required. NOT automatically installed by bootstrap scripts.
-- Caller must verify XMLDSig, delegation, XSD and source binding before enqueue.
-- No grants: provision the dedicated signing/delivery identity separately.
BEGIN;
-- Owner-controlled operational hold. New scopes cannot transmit by accident.
-- This does not authorize any legal contingency or conversion to paper NCF.
CREATE TABLE corestack_fiscal.delivery_control (
 tenant_id text NOT NULL, issuer_rnc text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('precertification','certification','production')),
 paused boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,issuer_rnc,environment)
);
CREATE TABLE corestack_fiscal.outbound_artifact (
 document_id bigint PRIMARY KEY REFERENCES corestack_fiscal.document(id),
 route text NOT NULL CHECK(route IN ('ECF','RFCE')),
 xml_text text NOT NULL CHECK(octet_length(xml_text) BETWEEN 1 AND 2097152),
 xml_sha256 text NOT NULL CHECK(xml_sha256=encode(sha256(convert_to(xml_text,'UTF8')),'hex')),
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 certificate_sha256 text NOT NULL CHECK(certificate_sha256 ~ '^[a-f0-9]{64}$'),
 signed_ecf_text text NOT NULL CHECK(octet_length(signed_ecf_text) BETWEEN 1 AND 2097152),
 signed_ecf_sha256 text NOT NULL CHECK(signed_ecf_sha256=encode(sha256(convert_to(signed_ecf_text,'UTF8')),'hex')),
 CHECK(route='RFCE' OR (signed_ecf_text=xml_text AND signed_ecf_sha256=xml_sha256)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_outbound BEFORE UPDATE OR DELETE ON corestack_fiscal.outbound_artifact
 FOR EACH ROW EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();
CREATE TRIGGER no_truncate_outbound BEFORE TRUNCATE ON corestack_fiscal.outbound_artifact
 FOR EACH STATEMENT EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();
CREATE TABLE corestack_fiscal.delivery_job (
 document_id bigint PRIMARY KEY REFERENCES corestack_fiscal.outbound_artifact(document_id),
 state text NOT NULL DEFAULT 'READY' CHECK(state IN ('READY','SENDING','RECONCILE','POLLING','ACCEPTED','ACCEPTED_CONDITIONALLY','REJECTED','REVIEW_REQUIRED')),
 claim_token uuid, claimed_by name, lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 track_id text CHECK(track_id ~ '^[A-Za-z0-9-]{1,200}$'),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX delivery_ready ON corestack_fiscal.delivery_job(available_at,document_id)
 WHERE state IN ('READY','SENDING','RECONCILE','POLLING');
CREATE TABLE corestack_fiscal.delivery_event (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 document_id bigint NOT NULL REFERENCES corestack_fiscal.delivery_job(document_id),
 event_code text NOT NULL,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=262144),
 actor name NOT NULL DEFAULT session_user,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_delivery_event BEFORE UPDATE OR DELETE ON corestack_fiscal.delivery_event
 FOR EACH ROW EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();
CREATE TRIGGER no_truncate_delivery_event BEFORE TRUNCATE ON corestack_fiscal.delivery_event
 FOR EACH STATEMENT EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();

CREATE FUNCTION corestack_fiscal.enqueue_delivery(p_document bigint,p_xml text,p_hash text,p_source_hash text,p_certificate_hash text,p_signed_ecf text,p_signed_ecf_hash text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE original corestack_fiscal.document_artifact%ROWTYPE; saved corestack_fiscal.outbound_artifact%ROWTYPE;
BEGIN
 SELECT a.* INTO original FROM corestack_fiscal.document_artifact a
 JOIN corestack_fiscal.document d ON d.id=a.document_id
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
 JOIN corestack_fiscal.runtime_scope b ON b.login_role=session_user
 AND (b.tenant_id,b.issuer_rnc,b.environment)=(s.tenant_id,s.issuer_rnc,s.environment)
 WHERE a.document_id=p_document FOR UPDATE OF a;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown prepared document or scope' USING ERRCODE='42501'; END IF;
 IF p_source_hash IS DISTINCT FROM original.xml_sha256 OR p_xml IS NULL OR p_xml ~ '<!'
 THEN RAISE EXCEPTION 'Invalid delivery source'; END IF;
 SELECT * INTO saved FROM corestack_fiscal.outbound_artifact WHERE document_id=p_document;
 IF FOUND THEN
  IF (saved.xml_text,saved.xml_sha256,saved.source_sha256,saved.certificate_sha256,saved.signed_ecf_text,saved.signed_ecf_sha256)
   IS DISTINCT FROM (p_xml,p_hash,p_source_hash,p_certificate_hash,p_signed_ecf,p_signed_ecf_hash)
  THEN RAISE EXCEPTION 'Immutable signed artifact conflict'; END IF;
  RETURN false;
 END IF;
 INSERT INTO corestack_fiscal.outbound_artifact(document_id,route,xml_text,xml_sha256,source_sha256,certificate_sha256,signed_ecf_text,signed_ecf_sha256)
 VALUES(p_document,original.planned_route,p_xml,p_hash,p_source_hash,p_certificate_hash,p_signed_ecf,p_signed_ecf_hash);
 INSERT INTO corestack_fiscal.delivery_job(document_id) VALUES(p_document);
 INSERT INTO corestack_fiscal.delivery_event(document_id,event_code) VALUES(p_document,'ENQUEUED');
 RETURN true;
END $$;

CREATE FUNCTION corestack_fiscal.claim_delivery() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE job corestack_fiscal.delivery_job%ROWTYPE; action text; result jsonb;
BEGIN
 IF NOT EXISTS(SELECT FROM corestack_fiscal.runtime_scope WHERE login_role=session_user)
 THEN RAISE EXCEPTION 'Unbound identity' USING ERRCODE='42501'; END IF;
 SELECT j.* INTO job FROM corestack_fiscal.delivery_job j
 JOIN corestack_fiscal.document d ON d.id=j.document_id
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
 JOIN corestack_fiscal.runtime_scope b ON b.login_role=session_user
 AND (b.tenant_id,b.issuer_rnc,b.environment)=(s.tenant_id,s.issuer_rnc,s.environment)
 JOIN corestack_fiscal.delivery_control ctl ON (ctl.tenant_id,ctl.issuer_rnc,ctl.environment)=(s.tenant_id,s.issuer_rnc,s.environment)
 AND NOT ctl.paused
 WHERE j.state IN ('READY','SENDING','RECONCILE','POLLING') AND j.available_at<=clock_timestamp()
 AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp())
 ORDER BY j.available_at,j.document_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF job.attempts>=20 THEN
  UPDATE corestack_fiscal.delivery_job SET state='REVIEW_REQUIRED',lease_until=NULL,updated_at=clock_timestamp() WHERE document_id=job.document_id;
  INSERT INTO corestack_fiscal.delivery_event(document_id,event_code) VALUES(job.document_id,'ATTEMPTS_EXHAUSTED');
  RETURN NULL;
 END IF;
 -- A crash after claiming may have occurred AFTER the POST. NEVER resend blindly.
 action:=CASE WHEN job.state='READY' THEN 'SEND' ELSE 'RECONCILE' END;
 UPDATE corestack_fiscal.delivery_job SET state=CASE WHEN action='SEND' THEN 'SENDING' ELSE 'RECONCILE' END,
  claim_token=gen_random_uuid(),claimed_by=session_user,lease_until=clock_timestamp()+interval '120 seconds',
  attempts=attempts+1,updated_at=clock_timestamp() WHERE document_id=job.document_id RETURNING * INTO job;
 INSERT INTO corestack_fiscal.delivery_event(document_id,event_code) VALUES(job.document_id,action||'_CLAIMED');
 SELECT jsonb_build_object('documentId',d.id::text,'encf',d.encf,'claimToken',job.claim_token::text,
 'action',action,'route',a.route,'xml',a.xml_text,'sha256',a.xml_sha256,'trackId',job.track_id,
 'scope',jsonb_build_object('tenantId',s.tenant_id,'issuerRnc',s.issuer_rnc,'environment',s.environment))
 INTO result FROM corestack_fiscal.document d JOIN corestack_fiscal.outbound_artifact a ON a.document_id=d.id
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id WHERE d.id=job.document_id;
 RETURN result;
END $$;

CREATE FUNCTION corestack_fiscal.complete_delivery(p_document bigint,p_token uuid,p_outcome text,p_track text,p_evidence jsonb)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE job corestack_fiscal.delivery_job%ROWTYPE;
BEGIN
 SELECT j.* INTO job FROM corestack_fiscal.delivery_job j
 JOIN corestack_fiscal.document d ON d.id=j.document_id
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
 JOIN corestack_fiscal.runtime_scope b ON b.login_role=session_user
 AND (b.tenant_id,b.issuer_rnc,b.environment)=(s.tenant_id,s.issuer_rnc,s.environment)
 WHERE j.document_id=p_document FOR UPDATE OF j;
 IF NOT FOUND THEN RAISE EXCEPTION 'Delivery scope mismatch' USING ERRCODE='42501'; END IF;
 IF p_token IS NULL OR job.claim_token IS DISTINCT FROM p_token OR job.claimed_by IS DISTINCT FROM session_user
 OR job.lease_until IS NULL OR job.lease_until<=clock_timestamp()
 THEN RETURN false; END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN ('UNCONFIRMED','PROCESSING','ACCEPTED','ACCEPTED_CONDITIONALLY','REJECTED','REVIEW_REQUIRED')
 OR p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'object'
 THEN RAISE EXCEPTION 'Invalid delivery outcome'; END IF;
 IF job.track_id IS NOT NULL AND p_track IS NOT NULL AND job.track_id<>p_track
 THEN RAISE EXCEPTION 'Track identity conflict'; END IF;
 UPDATE corestack_fiscal.delivery_job SET state=CASE p_outcome WHEN 'UNCONFIRMED' THEN 'RECONCILE' WHEN 'PROCESSING' THEN 'POLLING' ELSE p_outcome END,
 track_id=coalesce(track_id,p_track),lease_until=NULL,claim_token=NULL,claimed_by=NULL,
 available_at=clock_timestamp()+make_interval(secs=>least(900,5*(2^least(attempts,7))::integer)),updated_at=clock_timestamp()
 WHERE document_id=p_document;
 INSERT INTO corestack_fiscal.delivery_event(document_id,event_code,evidence) VALUES(p_document,p_outcome,p_evidence);
 RETURN true;
END $$;
CREATE FUNCTION corestack_fiscal.delivery_health() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE binding corestack_fiscal.runtime_scope%ROWTYPE; held boolean; counts jsonb; oldest timestamptz;
BEGIN
 SELECT * INTO binding FROM corestack_fiscal.runtime_scope WHERE login_role=session_user;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unbound identity' USING ERRCODE='42501'; END IF;
 SELECT paused INTO held FROM corestack_fiscal.delivery_control WHERE
 (tenant_id,issuer_rnc,environment)=(binding.tenant_id,binding.issuer_rnc,binding.environment);
 SELECT coalesce(jsonb_object_agg(state,n),'{}'::jsonb) INTO counts FROM (
 SELECT j.state,count(*) AS n FROM corestack_fiscal.delivery_job j
 JOIN corestack_fiscal.document d ON d.id=j.document_id
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
 WHERE (s.tenant_id,s.issuer_rnc,s.environment)=(binding.tenant_id,binding.issuer_rnc,binding.environment)
 GROUP BY j.state) q;
 SELECT min(a.created_at) INTO oldest FROM corestack_fiscal.delivery_job j
 JOIN corestack_fiscal.outbound_artifact a ON a.document_id=j.document_id
 JOIN corestack_fiscal.document d ON d.id=j.document_id
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
 WHERE (s.tenant_id,s.issuer_rnc,s.environment)=(binding.tenant_id,binding.issuer_rnc,binding.environment)
 AND j.state IN ('READY','SENDING','RECONCILE','POLLING','REVIEW_REQUIRED');
 RETURN jsonb_build_object('paused',coalesce(held,true),'counts',counts,'oldestUnresolvedAt',oldest);
END $$;
REVOKE ALL ON corestack_fiscal.delivery_control,corestack_fiscal.outbound_artifact,corestack_fiscal.delivery_job,corestack_fiscal.delivery_event FROM PUBLIC;
REVOKE ALL ON SEQUENCE corestack_fiscal.delivery_event_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION corestack_fiscal.enqueue_delivery(bigint,text,text,text,text,text,text),corestack_fiscal.claim_delivery(),corestack_fiscal.complete_delivery(bigint,uuid,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION corestack_fiscal.delivery_health() FROM PUBLIC;
COMMIT;
