-- PREVIEW ONLY. Additive migration; never install in a fiscal/ERP production DB.
BEGIN;
DO $$ BEGIN
 IF current_database()<>'corestack_preview_remote' OR NOT EXISTS (
 SELECT FROM corestack_fiscal.runtime_scope WHERE login_role='preview_runtime'
 AND tenant_id='cmt397emm0002nm0ogb50l2q6' AND issuer_rnc='40220429126' AND environment='precertification')
 THEN RAISE EXCEPTION 'PREVIEW_ONLY'; END IF;
END $$;
CREATE SCHEMA preview_rehearsal;
REVOKE ALL ON SCHEMA preview_rehearsal FROM PUBLIC;
CREATE TABLE preview_rehearsal.job (
 document_id bigint PRIMARY KEY REFERENCES corestack_fiscal.document,
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 model jsonb, error_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE preview_rehearsal.receipt (
 encf text PRIMARY KEY, payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_receipt BEFORE UPDATE OR DELETE ON preview_rehearsal.receipt
 FOR EACH ROW EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();
CREATE TRIGGER no_truncate_receipt BEFORE TRUNCATE ON preview_rehearsal.receipt
 FOR EACH STATEMENT EXECUTE FUNCTION corestack_fiscal.reject_evidence_mutation();
CREATE FUNCTION preview_rehearsal.source(p_id bigint) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('documentId',d.id::text,'encf',d.encf,'snapshotText',s.payload_text,
 'payloadSha256',s.payload_sha256,'validUntil',r.valid_until::text,
 'plannedSignatureAt',p.planned_signature_at,'xml',a.xml_text,'xmlSha256',a.xml_sha256,
 'signedXml',o.signed_ecf_text)
 FROM corestack_fiscal.document d
 JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
 JOIN corestack_fiscal.runtime_scope b ON b.login_role=session_user
 AND (b.tenant_id,b.issuer_rnc,b.environment)=(s.tenant_id,s.issuer_rnc,s.environment)
 JOIN corestack_fiscal.sequence_reservation sr ON sr.id=d.reservation_id
 JOIN corestack_fiscal.sequence_range r ON r.id=sr.range_id
 JOIN corestack_fiscal.preparation_job p ON p.document_id=d.id AND p.state='DONE'
 JOIN corestack_fiscal.document_artifact a ON a.document_id=d.id
 LEFT JOIN corestack_fiscal.outbound_artifact o ON o.document_id=d.id
 WHERE d.id=p_id AND session_user='preview_runtime'
 $$;
CREATE FUNCTION preview_rehearsal.status(p_id bigint) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('documentId',p_id::text,'encf',preview_rehearsal.source(p_id)->>'encf',
 'synthetic',true,'sendable',false,'state',coalesce(d.state,'SIGNING_PENDING'),
 'model',j.model,'errorCode',j.error_code,'attempts',j.attempts)
 FROM preview_rehearsal.job j LEFT JOIN corestack_fiscal.delivery_job d ON d.document_id=j.document_id
 WHERE j.document_id=p_id AND preview_rehearsal.source(p_id) IS NOT NULL
 $$;
CREATE FUNCTION preview_rehearsal.request(p_id bigint) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF preview_rehearsal.source(p_id) IS NULL THEN RAISE EXCEPTION 'PREVIEW_SOURCE_UNAVAILABLE'; END IF;
 INSERT INTO preview_rehearsal.job(document_id) VALUES(p_id) ON CONFLICT DO NOTHING;
 RETURN preview_rehearsal.status(p_id);
 END $$;
CREATE FUNCTION preview_rehearsal.next_job() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE id bigint; BEGIN
 SELECT document_id INTO id FROM preview_rehearsal.job
 WHERE model IS NULL AND error_code IS NULL AND available_at<=clock_timestamp()
 AND preview_rehearsal.source(document_id) IS NOT NULL ORDER BY available_at LIMIT 1 FOR UPDATE;
 IF id IS NULL THEN RETURN NULL; END IF;
 UPDATE preview_rehearsal.job SET attempts=attempts+1,available_at=clock_timestamp()+interval '30 seconds',
 error_code=CASE WHEN attempts>=9 THEN 'SYNTHETIC_REVIEW_REQUIRED' ELSE NULL END WHERE document_id=id;
 RETURN jsonb_build_object('source',preview_rehearsal.source(id),'status',preview_rehearsal.status(id));
 END $$;
CREATE FUNCTION preview_rehearsal.finish(p_id bigint,p_model jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF preview_rehearsal.source(p_id) IS NULL OR p_model IS NULL OR octet_length(p_model::text)>2097152
 OR p_model->>'sourceSha256' IS DISTINCT FROM preview_rehearsal.source(p_id)->>'xmlSha256'
 OR NOT EXISTS(SELECT FROM corestack_fiscal.delivery_job WHERE document_id=p_id AND state='ACCEPTED')
 THEN RAISE EXCEPTION 'PREVIEW_RESULT_INVALID'; END IF;
 UPDATE preview_rehearsal.job SET model=p_model WHERE document_id=p_id AND model IS NULL;
 IF NOT FOUND AND NOT EXISTS(SELECT FROM preview_rehearsal.job WHERE document_id=p_id AND model=p_model)
 THEN RAISE EXCEPTION 'PREVIEW_RESULT_CONFLICT'; END IF;
 RETURN true;
 END $$;
CREATE FUNCTION preview_rehearsal.receipt(p_encf text,p_payload jsonb DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE saved jsonb; BEGIN
 IF NOT EXISTS(SELECT FROM corestack_fiscal.document d JOIN preview_rehearsal.job j ON j.document_id=d.id
 WHERE d.encf=p_encf AND preview_rehearsal.source(d.id) IS NOT NULL)
 THEN RAISE EXCEPTION 'PREVIEW_RECEIPT_SCOPE'; END IF;
 IF p_payload IS NOT NULL THEN
 IF octet_length(p_payload::text)>4096 THEN RAISE EXCEPTION 'PREVIEW_RECEIPT_SIZE'; END IF;
 INSERT INTO preview_rehearsal.receipt VALUES(p_encf,p_payload,clock_timestamp()) ON CONFLICT DO NOTHING;
 END IF;
 SELECT payload INTO saved FROM preview_rehearsal.receipt WHERE encf=p_encf;
 IF p_payload IS NOT NULL AND saved IS DISTINCT FROM p_payload THEN RAISE EXCEPTION 'PREVIEW_RECEIPT_CONFLICT'; END IF;
 RETURN saved;
 END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA preview_rehearsal FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA preview_rehearsal FROM PUBLIC;
GRANT USAGE ON SCHEMA preview_rehearsal TO preview_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA preview_rehearsal TO preview_runtime;
GRANT EXECUTE ON FUNCTION corestack_fiscal.enqueue_delivery(bigint,text,text,text,text,text,text),
 corestack_fiscal.claim_delivery(),corestack_fiscal.complete_delivery(bigint,uuid,text,text,jsonb) TO preview_runtime;
INSERT INTO corestack_fiscal.delivery_control(tenant_id,issuer_rnc,environment,paused)
 VALUES('cmt397emm0002nm0ogb50l2q6','40220429126','precertification',false);
COMMIT;
