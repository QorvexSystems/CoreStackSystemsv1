-- Schema compatibility test ONLY; this is not a fiscal contract or DGII case.
-- Refuses the live preview and all production databases.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'rivnu_fe_schema_test_20260922' THEN
    RAISE EXCEPTION 'WRONG_TEST_DATABASE';
  END IF;
END $$;
INSERT INTO public."Tenant" (id,name,slug,"updatedAt")
VALUES ('synthetic-fe-schema','SYNTHETIC FISCAL SCHEMA TEST','synthetic-fe-schema',now());
INSERT INTO public."Invoice" (id,"tenantId","invoiceNumber","documentType","updatedAt")
VALUES ('synthetic-fe-invoice','synthetic-fe-schema','SYNTHETIC-NOT-A-FISCAL-INVOICE','FISCAL_CREDIT_ELECTRONIC_31',now());
INSERT INTO corestack_erp_fiscal.dispatch
  (tenant_id,invoice_id,issuer_rnc,environment,operation_id,request_text,payload_sha256)
VALUES ('synthetic-fe-schema','synthetic-fe-invoice','101010632','precertification',
  'synthetic-schema-only','{"fixture":"schema-only-not-dispatchable"}',repeat('a',64));
DO $$ BEGIN
  BEGIN
    UPDATE corestack_erp_fiscal.dispatch SET request_text='changed';
    RAISE EXCEPTION 'TEST_FAILED_IMMUTABILITY';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FISCAL_DISPATCH_EVIDENCE_IMMUTABLE' THEN RAISE; END IF;
  END;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='InvoiceItem' AND column_name='originalUnitPrice') THEN
    RAISE EXCEPTION 'MISSING_EVIDENCE_COLUMN';
  END IF;
END $$;
ROLLBACK;
SELECT 'PASS: actual preview schema accepts fiscal migrations, synthetic FK insert and immutable snapshot guard; test data rolled back.' AS result;
