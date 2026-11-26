-- Immutable, signature-derived printed representation. The range identity may
-- read it only after DGII acceptance; it never receives either XML artifact.
BEGIN;

CREATE TABLE corestack_fiscal.printed_representation (
 document_id bigint PRIMARY KEY REFERENCES corestack_fiscal.outbound_artifact(document_id),
 model jsonb NOT NULL CHECK(
   jsonb_typeof(model)='object' AND octet_length(model::text) BETWEEN 100 AND 1048576
 ),
 model_sha256 text NOT NULL CHECK(model_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_printed_representation BEFORE UPDATE OR DELETE
 ON corestack_fiscal.printed_representation FOR EACH ROW
 EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();
CREATE TRIGGER no_truncate_printed_representation BEFORE TRUNCATE
 ON corestack_fiscal.printed_representation FOR EACH STATEMENT
 EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();

CREATE FUNCTION corestack_fiscal.store_printed_representation(p_document bigint,p_model jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE saved jsonb;
BEGIN
 IF p_model IS NULL OR jsonb_typeof(p_model)<>'object'
   OR p_model->>'encf' IS NULL OR p_model->>'issuerRnc' IS NULL
   OR p_model->>'signedSha256' IS NULL OR p_model->>'sourceSha256' IS NULL
   OR p_model->>'qrUrl' IS NULL
 THEN RAISE EXCEPTION 'Invalid printed representation'; END IF;
 IF NOT EXISTS(
   SELECT 1 FROM corestack_fiscal.document d
   JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
   JOIN corestack_fiscal.outbound_artifact a ON a.document_id=d.id
   JOIN corestack_fiscal.runtime_scope b ON b.login_role=session_user
    AND (b.tenant_id,b.issuer_rnc,b.environment)=(s.tenant_id,s.issuer_rnc,s.environment)
   WHERE d.id=p_document AND d.encf=p_model->>'encf'
    AND s.issuer_rnc=p_model->>'issuerRnc'
    AND a.signed_ecf_sha256=p_model->>'signedSha256'
    AND a.source_sha256=p_model->>'sourceSha256'
 ) THEN RAISE EXCEPTION 'Printed representation evidence mismatch' USING ERRCODE='42501'; END IF;
 SELECT model INTO saved FROM corestack_fiscal.printed_representation WHERE document_id=p_document;
 IF FOUND THEN
   IF saved IS DISTINCT FROM p_model THEN RAISE EXCEPTION 'Immutable representation conflict'; END IF;
   RETURN false;
 END IF;
 INSERT INTO corestack_fiscal.printed_representation(document_id,model,model_sha256)
 VALUES(p_document,p_model,encode(sha256(convert_to(p_model::text,'UTF8')),'hex'));
 RETURN true;
END $$;

CREATE FUNCTION corestack_fiscal.read_accepted_printed_representation(p_document bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,corestack_fiscal,fiscal_meta AS $$
DECLARE binding fiscal_meta.range_registration_identity%ROWTYPE;
DECLARE result jsonb;
BEGIN
 SELECT * INTO binding FROM fiscal_meta.range_registration_identity WHERE login_role=session_user;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='unbound identity'; END IF;
 SELECT p.model INTO result
 FROM corestack_fiscal.printed_representation p
 JOIN corestack_fiscal.document d ON d.id=p.document_id
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
 JOIN corestack_fiscal.delivery_job j ON j.document_id=d.id
 WHERE d.id=p_document AND j.state IN ('ACCEPTED','ACCEPTED_CONDITIONALLY')
   AND (s.tenant_id,s.issuer_rnc,s.environment)=
       (binding.tenant_id,binding.issuer_rnc,binding.environment);
 RETURN result;
END $$;

CREATE FUNCTION corestack_fiscal.enqueue_delivery_with_representation(
 p_document bigint,p_xml text,p_hash text,p_source_hash text,p_certificate_hash text,
 p_signed_ecf text,p_signed_ecf_hash text,p_model jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE created boolean;
BEGIN
 created:=corestack_fiscal.enqueue_delivery(
   p_document,p_xml,p_hash,p_source_hash,p_certificate_hash,p_signed_ecf,p_signed_ecf_hash
 );
 PERFORM corestack_fiscal.store_printed_representation(p_document,p_model);
 RETURN created;
END $$;

REVOKE ALL ON corestack_fiscal.printed_representation FROM PUBLIC;
REVOKE ALL ON FUNCTION corestack_fiscal.store_printed_representation(bigint,jsonb),
 corestack_fiscal.read_accepted_printed_representation(bigint),
 corestack_fiscal.enqueue_delivery_with_representation(bigint,text,text,text,text,text,text,jsonb)
 FROM PUBLIC;
COMMIT;
