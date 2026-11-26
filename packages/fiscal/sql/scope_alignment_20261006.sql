-- Align an empty initial fiscal store with the current RIVNU ERP tenant.
-- This migration MUST fail once any fiscal ranges or evidence exist.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL ROLE rivnu_fe_pre_owner;
LOCK TABLE fiscal_meta.issuer_scope,corestack_fiscal.runtime_scope,
 corestack_fiscal.sequence_range,corestack_fiscal.sequence_reservation,
 corestack_fiscal.request_snapshot,corestack_fiscal.document,
 corestack_fiscal.preparation_job,corestack_fiscal.document_artifact IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
 IF (SELECT count(*) FROM fiscal_meta.issuer_scope)<>1
  OR NOT EXISTS(SELECT FROM fiscal_meta.issuer_scope WHERE
    tenant_id='cmqn0r66a0002lit0vxbzq5l4' AND issuer_rnc='40220429126' AND environment='precertification')
  OR (SELECT count(*) FROM corestack_fiscal.runtime_scope)<>1
  OR NOT EXISTS(SELECT FROM corestack_fiscal.runtime_scope WHERE login_role='rivnu_fe_pre_runtime'
    AND tenant_id='cmqn0r66a0002lit0vxbzq5l4' AND issuer_rnc='40220429126' AND environment='precertification')
  OR EXISTS(SELECT FROM corestack_fiscal.sequence_range)
  OR EXISTS(SELECT FROM corestack_fiscal.sequence_reservation)
  OR EXISTS(SELECT FROM corestack_fiscal.request_snapshot)
  OR EXISTS(SELECT FROM corestack_fiscal.document)
  OR EXISTS(SELECT FROM corestack_fiscal.preparation_job)
  OR EXISTS(SELECT FROM corestack_fiscal.document_artifact)
 THEN RAISE EXCEPTION 'FISCAL_SCOPE_ALIGNMENT_PRECONDITION_FAILED'; END IF;
END $$;
ALTER TABLE fiscal_meta.issuer_scope DROP CONSTRAINT issuer_scope_tenant_id_check;
UPDATE fiscal_meta.issuer_scope
 SET tenant_id='cmt397emm0002nm0ogb50l2q6'
 WHERE tenant_id='cmqn0r66a0002lit0vxbzq5l4' AND issuer_rnc='40220429126' AND environment='precertification';
ALTER TABLE fiscal_meta.issuer_scope ADD CONSTRAINT issuer_scope_tenant_id_check
 CHECK(tenant_id='cmt397emm0002nm0ogb50l2q6');
UPDATE corestack_fiscal.runtime_scope
 SET tenant_id='cmt397emm0002nm0ogb50l2q6'
 WHERE login_role='rivnu_fe_pre_runtime' AND tenant_id='cmqn0r66a0002lit0vxbzq5l4'
  AND issuer_rnc='40220429126' AND environment='precertification';
INSERT INTO corestack_fiscal.schema_migration(name,sha256)
VALUES('scope_alignment_20261006.sql','REPLACED_BY_INSTALLER');
COMMIT;
