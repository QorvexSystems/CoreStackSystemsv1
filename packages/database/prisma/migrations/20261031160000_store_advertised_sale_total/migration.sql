-- Preserve the original customer-facing amount for exact gross discounts.
-- Existing invoices and quotations remain unchanged; new lines store this snapshot.
ALTER TABLE "SalesOrderItem" ADD COLUMN "regularTotal" DECIMAL(12,2);
ALTER TABLE "InvoiceItem" ADD COLUMN "regularTotal" DECIMAL(12,2);
