ALTER TABLE "WarehouseStock" ADD COLUMN "reservedQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "InvoiceItem" ADD COLUMN "personalization" JSONB;
ALTER TABLE "CorporateOrderUnit" ADD COLUMN "salesOrderItemId" TEXT;
ALTER TABLE "CorporateOrderUnit" ADD CONSTRAINT "CorporateOrderUnit_salesOrderItemId_fkey" FOREIGN KEY ("salesOrderItemId") REFERENCES "SalesOrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierInvoice" ADD COLUMN "inventoryDestination" "PurchaseOrderDestination" NOT NULL DEFAULT 'SALES_INVENTORY';
UPDATE "SupplierInvoice" i SET "inventoryDestination" = p."destination" FROM "PurchaseOrder" p WHERE p.id = i."purchaseOrderId";
ALTER TABLE "ReturnRequest" ADD COLUMN "restockDestination" "ProductInventoryDestination";
CREATE TABLE "ShopifyEvent" ("id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "eventId" TEXT NOT NULL, "type" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "ShopifyEvent_tenantId_eventId_key" ON "ShopifyEvent"("tenantId","eventId");
CREATE TABLE "InventorySyncJob" ("id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "productId" TEXT NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1, "attempts" INTEGER NOT NULL DEFAULT 0, "error" TEXT, "pending" BOOLEAN NOT NULL DEFAULT true, "updatedAt" TIMESTAMP(3) NOT NULL);
CREATE UNIQUE INDEX "InventorySyncJob_tenantId_productId_key" ON "InventorySyncJob"("tenantId","productId");
ALTER TABLE "Product" ADD CONSTRAINT "Product_stock_reservation_check" CHECK ("stock" >= 0 AND "reservedStock" >= 0 AND "stock" >= "reservedStock") NOT VALID;
ALTER TABLE "WarehouseStock" ADD CONSTRAINT "WarehouseStock_reservation_check" CHECK ("quantity" >= 0 AND "reservedQuantity" >= 0 AND "quantity" >= "reservedQuantity") NOT VALID;
CREATE UNIQUE INDEX "CashSession_one_open_register" ON "CashSession"("tenantId","cashRegisterId") WHERE "status" = 'OPEN';


ALTER TABLE "InvoiceItem" ADD COLUMN "externalLineId" TEXT;
ALTER TABLE "SalesOrderItem" ADD COLUMN "externalLineId" TEXT;


ALTER TABLE "SalesOrder" ADD COLUMN "shopifyFulfillmentSyncedAt" TIMESTAMP(3), ADD COLUMN "shopifyFulfillmentError" TEXT;
