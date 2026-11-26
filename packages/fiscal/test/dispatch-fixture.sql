-- Minimal ERP tables, ONLY in the disposable integration database.
CREATE TABLE public."Tenant" (id text PRIMARY KEY, rnc text NOT NULL);
CREATE TABLE public."Invoice" (
  id text PRIMARY KEY, "tenantId" text NOT NULL, "documentType" text NOT NULL,
  status text NOT NULL, "fiscalStatus" text NOT NULL, ncf text, "eNcf" text,
  "issuedAt" timestamp, "updatedAt" timestamp NOT NULL
);
INSERT INTO public."Tenant" VALUES ('cmqn0r66a0002lit0vxbzq5l4','40220429126');
INSERT INTO public."Invoice" VALUES
 ('erp-synthetic-1','cmqn0r66a0002lit0vxbzq5l4','FISCAL_CREDIT_ELECTRONIC_31',
 'DRAFT','NOT_APPLICABLE',NULL,NULL,NULL,'2026-09-21 12:00:00');
INSERT INTO public."Invoice" SELECT 'erp-synthetic-2',"tenantId","documentType",status,"fiscalStatus",ncf,"eNcf","issuedAt","updatedAt"
 FROM public."Invoice" WHERE id='erp-synthetic-1';
\i /erp-dispatch-migration.sql
GRANT USAGE ON SCHEMA public, corestack_erp_fiscal TO rivnu_fe_pre_runtime;
GRANT SELECT, UPDATE ON public."Tenant",public."Invoice" TO rivnu_fe_pre_runtime;
GRANT SELECT, INSERT, UPDATE ON corestack_erp_fiscal.dispatch TO rivnu_fe_pre_runtime;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA corestack_erp_fiscal TO rivnu_fe_pre_runtime;
