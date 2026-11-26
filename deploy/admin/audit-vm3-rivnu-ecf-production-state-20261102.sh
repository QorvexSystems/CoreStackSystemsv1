#!/usr/bin/env bash
# Read-only cross-database audit before RIVNU's first production e-CF.
set -Eeuo pipefail
set +x
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'RUN_WITH_SUDO_ON_VM3'

pg() {
  sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 \
    -v ON_ERROR_STOP=1 -P pager=off "$@"
}

printf '\n=== ERP PRODUCTION ===\n'
pg -d rivnu_production <<'SQL'
BEGIN READ ONLY;
DO $audit$
BEGIN
  IF (SELECT count(*) FROM "_prisma_migrations"
      WHERE finished_at IS NULL AND rolled_back_at IS NULL) <> 0 THEN
    RAISE EXCEPTION 'UNFINISHED_PRISMA_MIGRATION';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "_prisma_migrations"
    WHERE migration_name='20261102023000_enable_production_fiscal_dispatch'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL
  ) THEN RAISE EXCEPTION 'PRODUCTION_DISPATCH_MIGRATION_MISSING'; END IF;
  IF (SELECT count(*) FROM "ElectronicFiscalRange"
      WHERE "tenantId"='cmqn0r66a0002lit0vxbzq5l4'
        AND "issuerTaxId"='40220429126' AND "ecfType"=31
        AND "startNumber"=1 AND "endNumber"=300 AND "nextNumber"=1
        AND "syncStatus"='SYNCED' AND "remoteRangeId"='1'
        AND "lastErrorCode" IS NULL AND "validUntil"=DATE '2027-12-31') <> 1 THEN
    RAISE EXCEPTION 'ERP_E31_RANGE_STATE_INVALID';
  END IF;
  IF (SELECT count(*) FROM corestack_erp_fiscal.dispatch WHERE environment='production') <> 0 THEN
    RAISE EXCEPTION 'ERP_PRODUCTION_DISPATCH_NOT_EMPTY';
  END IF;
  IF (SELECT count(*) FROM "Invoice"
      WHERE "documentType"::text IN ('FISCAL_CREDIT_ELECTRONIC_31','CONSUMER_ELECTRONIC_32')) <> 0 THEN
    RAISE EXCEPTION 'ERP_ECF_INVOICE_ALREADY_EXISTS';
  END IF;
END
$audit$;
SELECT "tenantId","issuerTaxId","ecfType","startNumber","endNumber","nextNumber",
       "syncStatus","remoteRangeId","validUntil"
FROM "ElectronicFiscalRange"
WHERE "issuerTaxId"='40220429126' AND "ecfType"=31;
COMMIT;
SQL

printf '\n=== ISOLATED FISCAL PRODUCTION ===\n'
pg -d rivnu_fiscal_prod <<'SQL'
BEGIN READ ONLY;
DO $audit$
BEGIN
  IF (SELECT count(*) FROM fiscal_meta.issuer_scope
      WHERE tenant_id='cmqn0r66a0002lit0vxbzq5l4'
        AND issuer_rnc='40220429126' AND environment='production') <> 1 THEN
    RAISE EXCEPTION 'FISCAL_SCOPE_INVALID';
  END IF;
  IF (SELECT count(*) FROM corestack_fiscal.sequence_range
      WHERE tenant_id='cmqn0r66a0002lit0vxbzq5l4'
        AND issuer_rnc='40220429126' AND environment='production'
        AND ecf_type=31 AND first_number=1 AND last_number=300 AND next_number=1
        AND authorization_reference='6005643910' AND valid_until=DATE '2027-12-31') <> 1 THEN
    RAISE EXCEPTION 'FISCAL_E31_RANGE_STATE_INVALID';
  END IF;
  IF (SELECT count(*) FROM corestack_fiscal.sequence_reservation) <> 0
     OR (SELECT count(*) FROM corestack_fiscal.request_snapshot) <> 0
     OR (SELECT count(*) FROM corestack_fiscal.document) <> 0
     OR (SELECT count(*) FROM corestack_fiscal.preparation_job) <> 0
     OR (SELECT count(*) FROM corestack_fiscal.signing_job) <> 0
     OR (SELECT count(*) FROM corestack_fiscal.delivery_job) <> 0
     OR (SELECT count(*) FROM corestack_fiscal.outbound_artifact) <> 0 THEN
    RAISE EXCEPTION 'FISCAL_PIPELINE_NOT_EMPTY_BEFORE_FIRST_ECF';
  END IF;
  IF (SELECT count(*) FROM corestack_fiscal.signing_control
      WHERE tenant_id='cmqn0r66a0002lit0vxbzq5l4' AND issuer_rnc='40220429126'
        AND environment='production' AND paused=false) <> 1
     OR (SELECT count(*) FROM corestack_fiscal.delivery_control
      WHERE tenant_id='cmqn0r66a0002lit0vxbzq5l4' AND issuer_rnc='40220429126'
        AND environment='production' AND paused=false) <> 1 THEN
    RAISE EXCEPTION 'FISCAL_PIPELINE_CONTROL_NOT_ACTIVE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rivnu_fe_prod_runtime'
      AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit=4) THEN
    RAISE EXCEPTION 'FISCAL_RUNTIME_ROLE_INVALID';
  END IF;
  IF has_table_privilege('rivnu_fe_prod_runtime','corestack_fiscal.sequence_range','SELECT')
     OR has_table_privilege('rivnu_fe_prod_runtime','corestack_fiscal.sequence_range','INSERT')
     OR has_table_privilege('rivnu_fe_prod_runtime','corestack_fiscal.sequence_range','UPDATE')
     OR has_table_privilege('rivnu_fe_prod_runtime','corestack_fiscal.sequence_range','DELETE') THEN
    RAISE EXCEPTION 'FISCAL_RUNTIME_DIRECT_RANGE_PRIVILEGE';
  END IF;
  IF NOT has_function_privilege('rivnu_fe_prod_runtime',
       'corestack_fiscal.claim_preparation()','EXECUTE')
     OR NOT has_function_privilege('rivnu_fe_prod_runtime',
       'corestack_fiscal.claim_signing()','EXECUTE')
     OR NOT has_function_privilege('rivnu_fe_prod_runtime',
       'corestack_fiscal.claim_delivery()','EXECUTE')
     OR NOT has_function_privilege('rivnu_fe_prod_runtime',
       'corestack_fiscal.read_document_status(bigint)','EXECUTE') THEN
    RAISE EXCEPTION 'FISCAL_RUNTIME_EXECUTE_PRIVILEGE_MISSING';
  END IF;
  IF NOT has_function_privilege('rivnu_fe_prod_range',
       'corestack_fiscal.register_request(text,text)','EXECUTE')
     OR NOT has_function_privilege('rivnu_fe_prod_range',
       'corestack_fiscal.register_authorized_range(text,text,text,smallint,bigint,bigint,bigint,text,date,date)','EXECUTE')
     OR NOT has_function_privilege('rivnu_fe_prod_range',
       'corestack_fiscal.read_authorized_ranges()','EXECUTE')
     OR NOT has_function_privilege('rivnu_fe_prod_range',
       'corestack_fiscal.read_document_status(bigint)','EXECUTE') THEN
    RAISE EXCEPTION 'FISCAL_RANGE_SERVICE_EXECUTE_PRIVILEGE_MISSING';
  END IF;
END
$audit$;
SELECT tenant_id,issuer_rnc,environment,ecf_type,first_number,last_number,next_number,
       (last_number-next_number+1) AS remaining,authorization_reference,valid_until
FROM corestack_fiscal.sequence_range ORDER BY ecf_type,first_number;
SELECT paused AS signing_paused FROM corestack_fiscal.signing_control;
SELECT paused AS delivery_paused FROM corestack_fiscal.delivery_control;
COMMIT;
SQL

printf '%s\n' 'RIVNU_VM3_ECF_PRODUCTION_STATE_AUDIT_PASSED_READ_ONLY'
printf '%s\n' 'No range, sequence, reservation, invoice, queue, credential or DGII endpoint was changed.'
