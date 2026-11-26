\set ON_ERROR_STOP on
-- Run only against the existing isolated VM4 preview. No real issuer DB.
DO $$ BEGIN
 IF current_database()<>'corestack_preview_remote'
 OR NOT EXISTS(SELECT FROM corestack_fiscal.runtime_scope WHERE tenant_id='cmt397emm0002nm0ogb50l2q6'
  AND issuer_rnc='40220429126' AND environment='precertification')
 OR EXISTS(SELECT FROM corestack_fiscal.runtime_scope WHERE tenant_id<>'cmt397emm0002nm0ogb50l2q6')
 THEN RAISE EXCEPTION 'ISOLATED_PREVIEW_REQUIRED'; END IF;
 IF to_regclass('corestack_fiscal.delivery_job') IS NOT NULL
 THEN RAISE EXCEPTION 'DELIVERY_MIGRATION_ALREADY_PRESENT_REVIEW_REQUIRED'; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='preview_owner' AND (rolsuper OR rolcanlogin OR rolcreaterole OR rolcreatedb))
 THEN RAISE EXCEPTION 'UNSAFE_PREVIEW_OWNER'; END IF;
END $$;
SET ROLE preview_owner;
\ir 004_delivery_queue.sql
RESET ROLE;
DO $$ BEGIN
 IF EXISTS(SELECT FROM corestack_fiscal.delivery_control WHERE NOT paused)
 OR EXISTS(SELECT FROM corestack_fiscal.delivery_job)
 OR has_function_privilege('preview_runtime','corestack_fiscal.enqueue_delivery(bigint,text,text,text,text,text,text)','EXECUTE')
 OR has_function_privilege('preview_runtime','corestack_fiscal.claim_delivery()','EXECUTE')
 THEN RAISE EXCEPTION 'DELIVERY_NOT_SAFELY_DISABLED'; END IF;
END $$;
SELECT 'PREVIEW_DELIVERY_SCHEMA_INSTALLED_PAUSED_NO_RUNTIME_GRANTS' AS result;
