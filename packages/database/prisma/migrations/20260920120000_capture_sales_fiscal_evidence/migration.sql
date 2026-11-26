-- Additive only: historical evidence stays NULL. Do not reconstruct it from
-- current catalogue prices, units or inventory settings.
CREATE TYPE "FiscalItemKind" AS ENUM ('GOOD', 'SERVICE');

ALTER TABLE "Product" ADD COLUMN "fiscalItemKind" "FiscalItemKind";
ALTER TABLE "SalesOrderItem"
  ADD COLUMN "originalUnitPrice" DECIMAL(14,4),
  ADD COLUMN "fiscalItemKind" "FiscalItemKind";
ALTER TABLE "InvoiceItem"
  ADD COLUMN "originalUnitPrice" DECIMAL(14,4),
  ADD COLUMN "fiscalItemKind" "FiscalItemKind";

ALTER TABLE "SalesOrderItem" ADD CONSTRAINT "SalesOrderItem_originalUnitPrice_nonnegative"
  CHECK ("originalUnitPrice" IS NULL OR "originalUnitPrice" >= 0);
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_originalUnitPrice_nonnegative"
  CHECK ("originalUnitPrice" IS NULL OR "originalUnitPrice" >= 0);
