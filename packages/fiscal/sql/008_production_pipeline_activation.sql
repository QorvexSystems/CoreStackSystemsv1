-- Installed only after 002-005 and an explicit production activation review.
BEGIN;

CREATE FUNCTION corestack_fiscal.enqueue_signing_after_preparation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,corestack_fiscal AS $$
BEGIN
  IF OLD.state IS DISTINCT FROM 'DONE' AND NEW.state='DONE' THEN
    INSERT INTO corestack_fiscal.signing_job(document_id)
      VALUES(NEW.document_id) ON CONFLICT(document_id) DO NOTHING;
    INSERT INTO corestack_fiscal.signing_event(document_id,event_code)
      SELECT NEW.document_id,'REQUESTED'
      WHERE NOT EXISTS(
        SELECT 1 FROM corestack_fiscal.signing_event
        WHERE document_id=NEW.document_id AND event_code='REQUESTED'
      );
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER preparation_requests_signing
AFTER UPDATE OF state ON corestack_fiscal.preparation_job
FOR EACH ROW EXECUTE FUNCTION corestack_fiscal.enqueue_signing_after_preparation();

CREATE FUNCTION corestack_fiscal.read_document_status(p_document bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,corestack_fiscal AS $$
DECLARE binding corestack_fiscal.runtime_scope%ROWTYPE;
DECLARE result jsonb;
BEGIN
  SELECT * INTO binding FROM corestack_fiscal.runtime_scope WHERE login_role=session_user;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='unbound identity'; END IF;
  SELECT jsonb_build_object(
    'documentId',d.id::text,'sourceDocumentId',s.source_document_id,'encf',d.encf,
    'preparation',p.state,'signing',coalesce(sj.state,'WAITING'),
    'delivery',coalesce(dj.state,'WAITING'),'trackId',dj.track_id,
    'updatedAt',coalesce(dj.updated_at,sj.updated_at,p.created_at)
  ) INTO result
  FROM corestack_fiscal.document d
  JOIN corestack_fiscal.request_snapshot s ON s.id=d.request_id
  JOIN corestack_fiscal.preparation_job p ON p.document_id=d.id
  LEFT JOIN corestack_fiscal.signing_job sj ON sj.document_id=d.id
  LEFT JOIN corestack_fiscal.delivery_job dj ON dj.document_id=d.id
  WHERE d.id=p_document AND
    (s.tenant_id,s.issuer_rnc,s.environment)=
    (binding.tenant_id,binding.issuer_rnc,binding.environment);
  RETURN result;
END $$;

INSERT INTO corestack_fiscal.signing_control(tenant_id,issuer_rnc,environment,paused)
SELECT tenant_id,issuer_rnc,environment,false FROM fiscal_meta.issuer_scope
ON CONFLICT(tenant_id,issuer_rnc,environment) DO UPDATE
  SET paused=false,updated_at=clock_timestamp();
INSERT INTO corestack_fiscal.delivery_control(tenant_id,issuer_rnc,environment,paused)
SELECT tenant_id,issuer_rnc,environment,false FROM fiscal_meta.issuer_scope
ON CONFLICT(tenant_id,issuer_rnc,environment) DO UPDATE
  SET paused=false,updated_at=clock_timestamp();

REVOKE ALL ON FUNCTION corestack_fiscal.enqueue_signing_after_preparation() FROM PUBLIC;
REVOKE ALL ON FUNCTION corestack_fiscal.read_document_status(bigint) FROM PUBLIC;
COMMIT;
