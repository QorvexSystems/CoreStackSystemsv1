\set ON_ERROR_STOP on
\if :{?creator_role}
\else
  \echo 'creator_role is required'
  \quit 2
\endif
-- Emergency rollback for the exact 44-table / 14-function state observed read-only on 2026-10-28.
-- Prefer security-restore-exact.generated.sql from 00_capture_current.sql when available.
BEGIN;
GRANT USAGE ON SCHEMA public TO PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE
 public."AuditLog", public."CashMovement", public."CashRegister", public."CashSession",
 public."CompanyBranding", public."CorporateOrderUnit", public."CreditSaleApproval", public."Customer",
 public."ElectronicDocument", public."EmployeeActivityLog", public."EmployeeProfile", public."FiscalSequence",
 public."GoodsReceipt", public."GoodsReceiptItem", public."ImportBatch", public."ImportBatchRow",
 public."ImportRowError", public."InventoryMovement", public."InventorySyncJob", public."Invoice",
 public."InvoiceItem", public."Membership", public."MobileOcrCaptureSession", public."OrderWorkflowEvent",
 public."Payment", public."Product", public."ProductCategory", public."PurchaseOrder",
 public."PurchaseOrderEvent", public."PurchaseOrderItem", public."ReturnRequest", public."ReturnRequestItem",
 public."SalesOrder", public."SalesOrderItem", public."ShopifyEvent", public."Supplier",
 public."SupplierInvoice", public."SupplierInvoiceAttachment", public."SupplierInvoiceItem", public."SupplierPayment",
 public."SupplierProduct", public."Tenant", public."User", public."_prisma_migrations"
 TO anon, authenticated;

GRANT EXECUTE ON FUNCTION
 public.qorvex_assert_credit_approval(text), public.qorvex_assert_purchase_order_item_received(text),
 public.qorvex_assert_receipt_differences(text), public.qorvex_assert_supplier_invoice_accounting(text),
 public.qorvex_check_credit_approval(), public.qorvex_check_purchase_order_item_received(),
 public.qorvex_check_receipt_differences(), public.qorvex_check_supplier_invoice_accounting(),
 public.qorvex_enforce_goods_receipt_coherence(), public.qorvex_enforce_goods_receipt_item_coherence(),
 public.qorvex_enforce_purchase_order_coherence(), public.qorvex_enforce_supplier_invoice_coherence(),
 public.qorvex_enforce_supplier_invoice_item_coherence(), public.qorvex_enforce_tenant_reference()
 TO PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE :"creator_role" IN SCHEMA public
 GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE :"creator_role" IN SCHEMA public
 GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE :"creator_role" IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC, anon, authenticated;

SELECT format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY',v.name) FROM (VALUES
 ('AuditLog'),('CashMovement'),('CashRegister'),('CashSession'),('CompanyBranding'),('CorporateOrderUnit'),
 ('CreditSaleApproval'),('Customer'),('ElectronicDocument'),('EmployeeActivityLog'),('EmployeeProfile'),('FiscalSequence'),
 ('GoodsReceipt'),('GoodsReceiptItem'),('ImportBatch'),('ImportBatchRow'),('ImportRowError'),('InventoryMovement'),
 ('InventorySyncJob'),('Invoice'),('InvoiceItem'),('Membership'),('MobileOcrCaptureSession'),('OrderWorkflowEvent'),
 ('Payment'),('Product'),('ProductCategory'),('PurchaseOrder'),('PurchaseOrderEvent'),('PurchaseOrderItem'),
 ('ReturnRequest'),('ReturnRequestItem'),('SalesOrder'),('SalesOrderItem'),('ShopifyEvent'),('Supplier'),
 ('SupplierInvoice'),('SupplierInvoiceAttachment'),('SupplierInvoiceItem'),('SupplierPayment'),('SupplierProduct'),
 ('Tenant'),('User'),('_prisma_migrations')
) v(name) ORDER BY v.name \gexec
COMMIT;

