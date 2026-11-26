\set ON_ERROR_STOP on
BEGIN;
DO $$
BEGIN
 IF NOT EXISTS (
   SELECT FROM corestack_fiscal.schema_migration
   WHERE name='004_delivery_queue.sql'
     AND sha256='7f0f30e3612364b03c8ac45490c5149d6d84c12823ac2472dfcc75705627278c'
 ) OR NOT EXISTS (
   SELECT FROM corestack_fiscal.delivery_control
   WHERE tenant_id='cmt397emm0002nm0ogb50l2q6'
     AND issuer_rnc='40220429126' AND environment='precertification' AND paused
 ) OR (SELECT count(*) FROM pg_roles
       WHERE rolname IN ('rivnu_fe_pre_signer','rivnu_fe_pre_delivery'))<>2
   OR EXISTS (
   SELECT FROM pg_roles
   WHERE rolname IN ('rivnu_fe_pre_signer','rivnu_fe_pre_delivery')
     AND (rolpassword IS NULL OR rolcanlogin)
 ) THEN
   RAISE EXCEPTION 'DELIVERY_IDENTITY_ENABLE_PRECONDITION_FAILED';
 END IF;
END $$;
ALTER ROLE rivnu_fe_pre_signer LOGIN;
ALTER ROLE rivnu_fe_pre_delivery LOGIN;
COMMIT;
SELECT 'FISCAL_DELIVERY_IDENTITIES_LOGIN_ENABLED_QUEUE_PAUSED' AS result;
