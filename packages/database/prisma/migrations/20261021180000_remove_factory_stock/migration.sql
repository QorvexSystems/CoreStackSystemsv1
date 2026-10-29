-- Factory is a work queue, not a separate physical-stock location.
-- Existing demo balances and movement history in these tables are intentionally discarded.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "SalesOrder" o
    JOIN "SalesOrderItem" i ON i."salesOrderId" = o.id
    WHERE o."inventorySource" = 'WAREHOUSE' AND i."reservedQuantity" > 0
  ) THEN
    RAISE EXCEPTION 'Resolve outstanding factory-stock reservations before removing factory stock';
  END IF;
END $$;

UPDATE "Product" SET "inventoryDestination" = 'SALES_INVENTORY' WHERE "inventoryDestination" = 'WAREHOUSE';
UPDATE "SalesOrder" SET "inventorySource" = 'SALES_INVENTORY' WHERE "inventorySource" = 'WAREHOUSE';
UPDATE "PurchaseOrder" SET "destination" = 'SALES_INVENTORY' WHERE "destination" = 'WAREHOUSE';
UPDATE "SupplierInvoice" SET "inventoryDestination" = 'SALES_INVENTORY' WHERE "inventoryDestination" = 'WAREHOUSE';
UPDATE "ReturnRequest" SET "restockDestination" = 'SALES_INVENTORY' WHERE "restockDestination" = 'WAREHOUSE';

DROP TABLE IF EXISTS "WarehouseMovement";
DROP TABLE IF EXISTS "WarehouseStock";
DROP TYPE IF EXISTS "WarehouseMovementType";

ALTER TYPE "ProductInventoryDestination" RENAME TO "ProductInventoryDestination_old";
CREATE TYPE "ProductInventoryDestination" AS ENUM ('SALES_INVENTORY');
ALTER TABLE "Product" ALTER COLUMN "inventoryDestination" DROP DEFAULT;
ALTER TABLE "SalesOrder" ALTER COLUMN "inventorySource" DROP DEFAULT;
ALTER TABLE "Product" ALTER COLUMN "inventoryDestination" TYPE "ProductInventoryDestination" USING "inventoryDestination"::text::"ProductInventoryDestination";
ALTER TABLE "SalesOrder" ALTER COLUMN "inventorySource" TYPE "ProductInventoryDestination" USING "inventorySource"::text::"ProductInventoryDestination";
ALTER TABLE "ReturnRequest" ALTER COLUMN "restockDestination" TYPE "ProductInventoryDestination" USING "restockDestination"::text::"ProductInventoryDestination";
ALTER TABLE "Product" ALTER COLUMN "inventoryDestination" SET DEFAULT 'SALES_INVENTORY';
ALTER TABLE "SalesOrder" ALTER COLUMN "inventorySource" SET DEFAULT 'SALES_INVENTORY';
DROP TYPE "ProductInventoryDestination_old";

ALTER TYPE "PurchaseOrderDestination" RENAME TO "PurchaseOrderDestination_old";
CREATE TYPE "PurchaseOrderDestination" AS ENUM ('SALES_INVENTORY');
ALTER TABLE "PurchaseOrder" ALTER COLUMN "destination" DROP DEFAULT;
ALTER TABLE "SupplierInvoice" ALTER COLUMN "inventoryDestination" DROP DEFAULT;
ALTER TABLE "PurchaseOrder" ALTER COLUMN "destination" TYPE "PurchaseOrderDestination" USING "destination"::text::"PurchaseOrderDestination";
ALTER TABLE "SupplierInvoice" ALTER COLUMN "inventoryDestination" TYPE "PurchaseOrderDestination" USING "inventoryDestination"::text::"PurchaseOrderDestination";
ALTER TABLE "PurchaseOrder" ALTER COLUMN "destination" SET DEFAULT 'SALES_INVENTORY';
ALTER TABLE "SupplierInvoice" ALTER COLUMN "inventoryDestination" SET DEFAULT 'SALES_INVENTORY';
DROP TYPE "PurchaseOrderDestination_old";

COMMIT;
