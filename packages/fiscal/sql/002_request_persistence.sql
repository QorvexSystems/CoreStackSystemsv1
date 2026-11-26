-- Apply AFTER 001 as the dedicated fiscal owner. Not an ERP migration.
-- Initial offline preparation queue only: no signing, DGII transport or grants.
BEGIN;
CREATE TABLE corestack_fiscal.runtime_scope (
 login_role name PRIMARY KEY,
 tenant_id text NOT NULL CHECK(length(btrim(tenant_id)) BETWEEN 1 AND 200),
 issuer_rnc text NOT NULL CHECK(issuer_rnc ~ '^([0-9]{9}|[0-9]{11})$'),
 environment text NOT NULL CHECK(environment IN ('precertification','certification','production'))
);
CREATE TABLE corestack_fiscal.request_snapshot (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id text NOT NULL,
 issuer_rnc text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('precertification','certification','production')),
 operation_id text NOT NULL CHECK(length(btrim(operation_id)) BETWEEN 1 AND 200),
 source_document_id text NOT NULL CHECK(length(btrim(source_document_id)) BETWEEN 1 AND 200),
 source_revision text NOT NULL CHECK(length(btrim(source_revision)) BETWEEN 1 AND 200),
 ecf_type smallint NOT NULL CHECK(ecf_type IN (31,32,33,34,41,43,44,45,46,47)),
 business_date date NOT NULL,
 payload_text text NOT NULL CHECK(octet_length(payload_text) BETWEEN 2 AND 524288),
 payload_sha256 text NOT NULL CHECK(payload_sha256=encode(sha256(convert_to(payload_text,'UTF8')),'hex')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,issuer_rnc,environment,operation_id),
 UNIQUE(tenant_id,issuer_rnc,environment,source_document_id,source_revision)
);
CREATE TABLE corestack_fiscal.document (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 request_id bigint NOT NULL UNIQUE REFERENCES corestack_fiscal.request_snapshot(id),
 reservation_id bigint NOT NULL UNIQUE REFERENCES corestack_fiscal.sequence_reservation(id),
 encf text NOT NULL CHECK(encf ~ '^E[0-9]{12}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE corestack_fiscal.preparation_job (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 document_id bigint NOT NULL UNIQUE REFERENCES corestack_fiscal.document(id),
 action text NOT NULL DEFAULT 'PREPARE_XML' CHECK(action='PREPARE_XML'),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RUNNING','DONE','FAILED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE corestack_fiscal.audit_event (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 document_id bigint NOT NULL REFERENCES corestack_fiscal.document(id),
 event_code text NOT NULL CHECK(event_code='REQUEST_REGISTERED'),
 actor name NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION corestack_fiscal.reject_evidence_mutation() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Fiscal evidence is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER immutable_snapshot BEFORE UPDATE OR DELETE ON corestack_fiscal.request_snapshot
 FOR EACH ROW EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();
CREATE TRIGGER immutable_document BEFORE UPDATE OR DELETE ON corestack_fiscal.document
 FOR EACH ROW EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON corestack_fiscal.audit_event
 FOR EACH ROW EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();
CREATE TRIGGER no_truncate_snapshot BEFORE TRUNCATE ON corestack_fiscal.request_snapshot
 FOR EACH STATEMENT EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();
CREATE TRIGGER no_truncate_document BEFORE TRUNCATE ON corestack_fiscal.document
 FOR EACH STATEMENT EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();
CREATE TRIGGER no_truncate_audit BEFORE TRUNCATE ON corestack_fiscal.audit_event
 FOR EACH STATEMENT EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();

-- Caller identity comes from the authenticated DB session, never JSON or GUCs.
-- Application must run analyzeFiscalRequest BEFORE calling this function.
CREATE FUNCTION corestack_fiscal.register_request(p_snapshot text, p_sha256 text)
 RETURNS TABLE(document_id bigint, encf text, reused boolean)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE
 binding corestack_fiscal.runtime_scope%ROWTYPE;
 previous corestack_fiscal.request_snapshot%ROWTYPE;
 payload jsonb; request jsonb; operation text; source_id text; revision text;
 kind smallint; issued date; request_id bigint; reservation_id bigint;
 assigned_encf text; new_document_id bigint;
BEGIN
 SELECT * INTO binding FROM corestack_fiscal.runtime_scope WHERE login_role=session_user;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unbound fiscal DB identity' USING ERRCODE='42501'; END IF;
 IF p_snapshot IS NULL OR octet_length(p_snapshot) NOT BETWEEN 2 AND 524288
  OR p_sha256 IS NULL OR p_sha256 !~ '^[a-f0-9]{64}$'
  OR encode(sha256(convert_to(p_snapshot,'UTF8')),'hex') <> p_sha256
 THEN RAISE EXCEPTION 'Invalid snapshot digest/size'; END IF;
 payload:=p_snapshot::jsonb;
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object'
  OR payload->'scope' IS DISTINCT FROM jsonb_build_object('tenantId',binding.tenant_id,
    'issuerRnc',binding.issuer_rnc,'environment',binding.environment)
 THEN RAISE EXCEPTION 'Fiscal scope mismatch' USING ERRCODE='42501'; END IF;
 request:=payload->'request';
 IF jsonb_typeof(request) IS DISTINCT FROM 'object'
  OR request->>'version' IS DISTINCT FROM '1'
  OR request#>>'{issuer,rnc}' IS DISTINCT FROM binding.issuer_rnc
 THEN RAISE EXCEPTION 'Invalid request identity/version'; END IF;
 operation:=request->>'operationId'; source_id:=request#>>'{source,documentId}';
 revision:=request#>>'{source,revision}';
 kind:=(request->>'type')::smallint; issued:=(request->>'issuedOn')::date;
 IF operation IS NULL OR source_id IS NULL OR revision IS NULL OR kind IS NULL OR issued IS NULL
 THEN RAISE EXCEPTION 'Missing request evidence'; END IF;
 -- Same lock as range registration/reservation; serializes retry/conflict checks.
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(binding.tenant_id,binding.issuer_rnc,binding.environment)::text,0));
 SELECT * INTO previous FROM corestack_fiscal.request_snapshot s
  WHERE s.tenant_id=binding.tenant_id AND s.issuer_rnc=binding.issuer_rnc
   AND s.environment=binding.environment AND s.operation_id=operation;
 IF FOUND THEN
  IF previous.payload_sha256<>p_sha256 OR previous.payload_text<>p_snapshot THEN
   RAISE EXCEPTION 'Idempotency conflict: immutable request differs';
  END IF;
  RETURN QUERY SELECT d.id,d.encf,true FROM corestack_fiscal.document d WHERE d.request_id=previous.id;
  RETURN;
 END IF;
 INSERT INTO corestack_fiscal.request_snapshot(tenant_id,issuer_rnc,environment,operation_id,
   source_document_id,source_revision,ecf_type,business_date,payload_text,payload_sha256)
 VALUES(binding.tenant_id,binding.issuer_rnc,binding.environment,operation,source_id,revision,kind,issued,p_snapshot,p_sha256)
 RETURNING id INTO request_id;
 assigned_encf:=corestack_fiscal.reserve_encf(binding.tenant_id,binding.issuer_rnc,binding.environment,
   kind,operation,p_sha256,issued);
 SELECT r.id INTO STRICT reservation_id FROM corestack_fiscal.sequence_reservation r
  WHERE r.tenant_id=binding.tenant_id AND r.issuer_rnc=binding.issuer_rnc
   AND r.environment=binding.environment AND r.operation_id=operation;
 INSERT INTO corestack_fiscal.document(request_id,reservation_id,encf)
 VALUES(request_id,reservation_id,assigned_encf) RETURNING id INTO new_document_id;
 INSERT INTO corestack_fiscal.preparation_job(document_id) VALUES(new_document_id);
 INSERT INTO corestack_fiscal.audit_event(document_id,event_code,actor)
 VALUES(new_document_id,'REQUEST_REGISTERED',session_user);
 RETURN QUERY SELECT new_document_id,assigned_encf,false;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA corestack_fiscal FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA corestack_fiscal FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA corestack_fiscal FROM PUBLIC;
COMMIT;
