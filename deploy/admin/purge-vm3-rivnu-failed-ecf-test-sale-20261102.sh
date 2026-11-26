#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

# This is intentionally a one-off, tightly scoped cleanup for the RIVNU E32
# test invoice that failed before an e-NCF was reserved or submitted.
readonly database='rivnu_production'
readonly fiscal_database='rivnu_fiscal_prod'
readonly tenant_id='cmqn0r66a0002lit0vxbzq5l4'
readonly invoice_id='cmvzonzld0016of06th954vtp'
readonly order_id='cmvzom1x4000lof06rrxa440j'
readonly invoice_number="RIV-ECF-PENDING-$order_id"
readonly expected_return_id='cmvzq3d180001qp76gwb0uyop'
readonly expected_total='1091.65'
readonly stage="/var/lib/corestack-pki/rivnu-test-sale-purge-$(date -u +%Y%m%dT%H%M%SZ)"

fail() { printf '%s\n' "$1" >&2; exit 1; }
pg() {
  sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 \
    -d "$database" -v ON_ERROR_STOP=1 -P pager=off "$@"
}
fiscal_pg() {
  sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 \
    -d "$fiscal_database" -v ON_ERROR_STOP=1 -P pager=off "$@"
}

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail RUN_WITH_SUDO_ON_VM3
[[ -d /var/lib/corestack-pki && ! -L /var/lib/corestack-pki ]] || fail PKI_STAGING_PARENT_INVALID
[[ ! -e "$stage" ]] || fail PURGE_STAGE_ALREADY_EXISTS
[[ "$(pg -Atqc 'SHOW server_version_num')" == 17* ]] || fail POSTGRESQL_17_REQUIRED
[[ "$(fiscal_pg -Atqc "SELECT count(*) FROM corestack_fiscal.request_snapshot WHERE tenant_id='$tenant_id' AND environment='production' AND source_document_id='$invoice_id'")" == 0 ]] || fail FISCAL_CORE_DOCUMENT_EXISTS_PURGE_FORBIDDEN

# The only safe deletion case: the ERP outbox reached its terminal review
# state but has no core document/e-NCF, signature, delivery, or DGII record.
pg <<SQL
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('rivnu:purge:failed-ecf-test:20261102',0));

DO \$\$
DECLARE
  invoice_row record;
  dispatch_count integer;
  return_count integer;
  item_count integer;
  payment_count integer;
  movement_count integer;
  movement_balance numeric;
  cash_balance numeric;
BEGIN
  SELECT i.id,i."tenantId",i."invoiceNumber",i."documentType",i.status,i."fiscalStatus",
         i."eNcf",i.total INTO invoice_row
  FROM "Invoice" i
  WHERE i.id='$invoice_id' FOR UPDATE;

  IF NOT FOUND
     OR invoice_row."tenantId"<>'$tenant_id'
     OR invoice_row."invoiceNumber"<>'$invoice_number'
     OR invoice_row."documentType"<>'CONSUMER_ELECTRONIC_32'
     OR invoice_row.status<>'CREDITED'
     OR invoice_row."fiscalStatus"<>'FAILED'
     OR invoice_row."eNcf" IS NOT NULL
     OR invoice_row.total<>$expected_total::numeric
  THEN
    RAISE EXCEPTION 'TARGET_INVOICE_PRECONDITION_FAILED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "SalesOrder" o
    WHERE o.id='$order_id' AND o."tenantId"='$tenant_id'
      AND o."invoiceId"='$invoice_id' AND o.status='COMPLETED'
  ) THEN
    RAISE EXCEPTION 'TARGET_ORDER_PRECONDITION_FAILED';
  END IF;

  SELECT count(*) INTO dispatch_count
  FROM corestack_erp_fiscal.dispatch d
  WHERE d.tenant_id='$tenant_id' AND d.invoice_id='$invoice_id'
    AND d.environment='production' AND d.operation_id='pos-$invoice_id'
    AND d.state='REVIEW_REQUIRED' AND d.document_id IS NULL AND d.encf IS NULL
    AND d.lease_token IS NULL AND d.lease_until IS NULL;
  IF dispatch_count<>1 THEN RAISE EXCEPTION 'DISPATCH_NOT_UNSENT_REVIEW_REQUIRED'; END IF;

  SELECT count(*) INTO return_count
  FROM "ReturnRequest" r
  WHERE r.id='$expected_return_id' AND r."tenantId"='$tenant_id'
    AND r."invoiceId"='$invoice_id' AND r.status='COMPLETED'
    AND r."refundAmount"=$expected_total::numeric AND r."cashRefundAmount"=$expected_total::numeric;
  IF return_count<>1 THEN RAISE EXCEPTION 'COMPENSATING_RETURN_PRECONDITION_FAILED'; END IF;

  SELECT count(*) INTO item_count FROM "InvoiceItem" WHERE "invoiceId"='$invoice_id';
  IF item_count<>14 THEN RAISE EXCEPTION 'INVOICE_ITEM_COUNT_UNEXPECTED'; END IF;
  IF (SELECT count(*) FROM "ReturnRequestItem" WHERE "returnRequestId"='$expected_return_id')<>item_count
  THEN RAISE EXCEPTION 'RETURN_ITEM_COUNT_UNEXPECTED'; END IF;

  SELECT count(*) INTO payment_count FROM "Payment"
  WHERE "tenantId"='$tenant_id' AND "invoiceId"='$invoice_id'
    AND status='COMPLETED' AND amount=$expected_total::numeric;
  IF payment_count<>1 THEN RAISE EXCEPTION 'PAYMENT_PRECONDITION_FAILED'; END IF;

  SELECT count(*),coalesce(sum(CASE WHEN type='SALE' THEN -quantity ELSE quantity END),0)
    INTO movement_count,movement_balance
  FROM "InventoryMovement"
  WHERE "tenantId"='$tenant_id' AND "invoiceId"='$invoice_id'
    AND type IN ('SALE','RETURN');
  IF movement_count<>28 OR movement_balance<>0 THEN
    RAISE EXCEPTION 'INVENTORY_NOT_ALREADY_RESTORED';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "InventoryMovement"
    WHERE "tenantId"='$tenant_id' AND "invoiceId"='$invoice_id' AND type IN ('SALE','RETURN')
    GROUP BY "productId"
    HAVING sum(CASE WHEN type='SALE' THEN -quantity ELSE quantity END)<>0
  ) THEN RAISE EXCEPTION 'INVENTORY_PRODUCT_BALANCE_INVALID'; END IF;

  SELECT coalesce(sum(CASE WHEN type='REFUND' THEN -amount ELSE amount END),0) INTO cash_balance
  FROM "CashMovement"
  WHERE "tenantId"='$tenant_id' AND "invoiceId"='$invoice_id';
  IF cash_balance<>0 THEN RAISE EXCEPTION 'CASH_NOT_ALREADY_RESTORED'; END IF;
END \$\$;
ROLLBACK;
SQL

install -d -o root -g root -m 0700 "$stage"
sudo -u postgres pg_dump -h /var/run/postgresql -p 5432 -d "$database" --format=custom >"$stage/before.dump"
chmod 0600 "$stage/before.dump"
[[ -s "$stage/before.dump" ]] || fail VERIFIED_BACKUP_REQUIRED

pg <<SQL
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_advisory_xact_lock(hashtextextended('rivnu:purge:failed-ecf-test:20261102',0));

LOCK TABLE corestack_erp_fiscal.dispatch,
  "Invoice","InvoiceItem","SalesOrder","SalesOrderItem","ReturnRequest","ReturnRequestItem",
  "Payment","CashMovement","InventoryMovement","EmployeeActivityLog","AuditLog"
  IN SHARE ROW EXCLUSIVE MODE;

DO \$\$
DECLARE
  dispatch_count integer;
  movement_count integer;
  movement_balance numeric;
  cash_balance numeric;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Invoice" i
    WHERE i.id='$invoice_id' AND i."tenantId"='$tenant_id'
      AND i."invoiceNumber"='$invoice_number'
      AND i."documentType"='CONSUMER_ELECTRONIC_32'
      AND i.status='CREDITED' AND i."fiscalStatus"='FAILED'
      AND i."eNcf" IS NULL AND i.total=$expected_total::numeric
  ) THEN RAISE EXCEPTION 'TARGET_INVOICE_CHANGED'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "SalesOrder" o WHERE o.id='$order_id' AND o."tenantId"='$tenant_id'
      AND o."invoiceId"='$invoice_id' AND o.status='COMPLETED'
  ) THEN RAISE EXCEPTION 'TARGET_ORDER_CHANGED'; END IF;

  SELECT count(*) INTO dispatch_count FROM corestack_erp_fiscal.dispatch d
  WHERE d.tenant_id='$tenant_id' AND d.invoice_id='$invoice_id'
    AND d.environment='production' AND d.operation_id='pos-$invoice_id'
    AND d.state='REVIEW_REQUIRED' AND d.document_id IS NULL AND d.encf IS NULL
    AND d.lease_token IS NULL AND d.lease_until IS NULL;
  IF dispatch_count<>1 THEN RAISE EXCEPTION 'DISPATCH_CHANGED'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "ReturnRequest" r WHERE r.id='$expected_return_id'
      AND r."tenantId"='$tenant_id' AND r."invoiceId"='$invoice_id'
      AND r.status='COMPLETED' AND r."refundAmount"=$expected_total::numeric
      AND r."cashRefundAmount"=$expected_total::numeric
  ) THEN RAISE EXCEPTION 'COMPENSATING_RETURN_CHANGED'; END IF;

  IF (SELECT count(*) FROM "InvoiceItem" WHERE "invoiceId"='$invoice_id')<>14
     OR (SELECT count(*) FROM "ReturnRequestItem" WHERE "returnRequestId"='$expected_return_id')<>14
     OR (SELECT count(*) FROM "Payment" WHERE "tenantId"='$tenant_id' AND "invoiceId"='$invoice_id'
         AND status='COMPLETED' AND amount=$expected_total::numeric)<>1
  THEN RAISE EXCEPTION 'RELATED_ROW_COUNTS_CHANGED'; END IF;

  SELECT count(*),coalesce(sum(CASE WHEN type='SALE' THEN -quantity ELSE quantity END),0)
    INTO movement_count,movement_balance
  FROM "InventoryMovement"
  WHERE "tenantId"='$tenant_id' AND "invoiceId"='$invoice_id' AND type IN ('SALE','RETURN');
  IF movement_count<>28 OR movement_balance<>0 THEN RAISE EXCEPTION 'INVENTORY_NOT_RESTORED'; END IF;
  IF EXISTS (
    SELECT 1
    FROM "InventoryMovement"
    WHERE "tenantId"='$tenant_id' AND "invoiceId"='$invoice_id' AND type IN ('SALE','RETURN')
    GROUP BY "productId"
    HAVING sum(CASE WHEN type='SALE' THEN -quantity ELSE quantity END)<>0
  ) THEN RAISE EXCEPTION 'INVENTORY_PRODUCT_BALANCE_CHANGED'; END IF;

  SELECT coalesce(sum(CASE WHEN type='REFUND' THEN -amount ELSE amount END),0) INTO cash_balance
  FROM "CashMovement" WHERE "tenantId"='$tenant_id' AND "invoiceId"='$invoice_id';
  IF cash_balance<>0 THEN RAISE EXCEPTION 'CASH_NOT_RESTORED'; END IF;
END \$\$;

DELETE FROM "EmployeeActivityLog"
WHERE "tenantId"='$tenant_id' AND ("invoiceId"='$invoice_id'
  OR (entity='ReturnRequest' AND "entityId"='$expected_return_id')
  OR (entity='Invoice' AND "entityId"='$invoice_id')
  OR (entity='SalesOrder' AND "entityId"='$order_id'));
DELETE FROM "AuditLog"
WHERE "tenantId"='$tenant_id' AND ((entity='ReturnRequest' AND "entityId"='$expected_return_id')
  OR (entity='Invoice' AND "entityId"='$invoice_id')
  OR (entity='SalesOrder' AND "entityId"='$order_id'));
DELETE FROM "CashMovement" WHERE "tenantId"='$tenant_id' AND "invoiceId"='$invoice_id';
DELETE FROM "InventoryMovement" WHERE "tenantId"='$tenant_id' AND "invoiceId"='$invoice_id';
DELETE FROM "Payment" WHERE "tenantId"='$tenant_id' AND "invoiceId"='$invoice_id';
DELETE FROM "ReturnRequest" WHERE id='$expected_return_id' AND "tenantId"='$tenant_id' AND "invoiceId"='$invoice_id';
DELETE FROM "SalesOrder" WHERE id='$order_id' AND "tenantId"='$tenant_id' AND "invoiceId"='$invoice_id';

ALTER TABLE corestack_erp_fiscal.dispatch DISABLE TRIGGER dispatch_immutable;
DELETE FROM corestack_erp_fiscal.dispatch
WHERE tenant_id='$tenant_id' AND invoice_id='$invoice_id' AND environment='production'
  AND operation_id='pos-$invoice_id' AND state='REVIEW_REQUIRED'
  AND document_id IS NULL AND encf IS NULL;
ALTER TABLE corestack_erp_fiscal.dispatch ENABLE TRIGGER dispatch_immutable;

DELETE FROM "Invoice" WHERE id='$invoice_id' AND "tenantId"='$tenant_id'
  AND "eNcf" IS NULL AND status='CREDITED' AND "fiscalStatus"='FAILED';
COMMIT;
SQL

verification="$(pg -Atqc "
SELECT
  (SELECT count(*) FROM \"Invoice\" WHERE id='$invoice_id')::text||'|'||
  (SELECT count(*) FROM \"SalesOrder\" WHERE id='$order_id')::text||'|'||
  (SELECT count(*) FROM \"ReturnRequest\" WHERE id='$expected_return_id')::text||'|'||
  (SELECT count(*) FROM corestack_erp_fiscal.dispatch WHERE invoice_id='$invoice_id')::text||'|'||
  (SELECT count(*) FROM \"InventoryMovement\" WHERE \"invoiceId\"='$invoice_id')::text||'|'||
  (SELECT count(*) FROM \"CashMovement\" WHERE \"invoiceId\"='$invoice_id')::text||'|'||
  (SELECT count(*) FROM \"Payment\" WHERE \"invoiceId\"='$invoice_id')::text||'|'||
  (SELECT count(*) FROM pg_trigger WHERE tgrelid='corestack_erp_fiscal.dispatch'::regclass
    AND tgname='dispatch_immutable' AND tgenabled='O')::text
")"
[[ "$verification" == '0|0|0|0|0|0|0|1' ]] || fail "PURGE_VERIFICATION_FAILED_$verification"
[[ "$(fiscal_pg -Atqc "SELECT count(*) FROM corestack_fiscal.request_snapshot WHERE source_document_id='$invoice_id'")" == 0 ]] || fail FISCAL_CORE_VERIFICATION_FAILED

printf '%s\n' RIVNU_FAILED_ECF_TEST_SALE_PURGED
printf 'Backup=%s/before.dump\n' "$stage"
printf '%s\n' 'The failed test sale, compensating return, order, invoice, payments, cash and inventory movements were removed.'
printf '%s\n' 'Stock and cash were already net-zero before deletion; no stock, cash, e-NCF or DGII record was altered.'
