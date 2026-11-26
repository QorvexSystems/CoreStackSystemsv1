-- Harden sales-order flow for order taking -> cashier -> invoice.
-- Existing enum values are kept; new values are appended for PostgreSQL compatibility.
ALTER TYPE "SalesOrderStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
ALTER TYPE "SalesOrderStatus" ADD VALUE IF NOT EXISTS 'CREATED';
ALTER TYPE "SalesOrderStatus" ADD VALUE IF NOT EXISTS 'IN_CASHIER';
ALTER TYPE "SalesOrderStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

ALTER TYPE "EmployeeLogAction" ADD VALUE IF NOT EXISTS 'CLAIM_SALES_ORDER';
ALTER TYPE "EmployeeLogAction" ADD VALUE IF NOT EXISTS 'RELEASE_SALES_ORDER';
ALTER TYPE "EmployeeLogAction" ADD VALUE IF NOT EXISTS 'EXPIRE_SALES_ORDER';

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "reservedStock" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "SalesOrder"
  ADD COLUMN IF NOT EXISTS "claimedById" TEXT,
  ADD COLUMN IF NOT EXISTS "claimedCashSessionId" TEXT,
  ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "claimExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "releasedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancelReason" TEXT;

ALTER TABLE "SalesOrderItem"
  ADD COLUMN IF NOT EXISTS "reservedQuantity" INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'SalesOrder_claimedById_fkey'
  ) THEN
    ALTER TABLE "SalesOrder"
      ADD CONSTRAINT "SalesOrder_claimedById_fkey"
      FOREIGN KEY ("claimedById") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'SalesOrder_claimedCashSessionId_fkey'
  ) THEN
    ALTER TABLE "SalesOrder"
      ADD CONSTRAINT "SalesOrder_claimedCashSessionId_fkey"
      FOREIGN KEY ("claimedCashSessionId") REFERENCES "CashSession"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

UPDATE "SalesOrderItem" AS soi
SET "reservedQuantity" = CAST(soi."quantity" AS INTEGER)
FROM "SalesOrder" AS so
, "Product" AS p
WHERE so."id" = soi."salesOrderId"
  AND p."id" = soi."productId"
  AND so."status" = 'SENT_TO_CASHIER'
  AND p."trackInventory" = TRUE
  AND soi."quantity" = FLOOR(soi."quantity");

UPDATE "Product" AS p
SET "reservedStock" = COALESCE(reserved.reserved_qty, 0)
FROM (
  SELECT
    soi."productId",
    SUM(soi."reservedQuantity")::INTEGER AS reserved_qty
  FROM "SalesOrderItem" AS soi
  JOIN "SalesOrder" AS so ON so."id" = soi."salesOrderId"
  WHERE so."status" = 'SENT_TO_CASHIER'
    AND soi."productId" IS NOT NULL
  GROUP BY soi."productId"
) AS reserved
WHERE p."id" = reserved."productId";

UPDATE "Product"
SET "reservedStock" = 0
WHERE "reservedStock" < 0;

CREATE INDEX IF NOT EXISTS "Product_tenantId_reservedStock_idx" ON "Product"("tenantId", "reservedStock");
CREATE INDEX IF NOT EXISTS "SalesOrder_claimedById_idx" ON "SalesOrder"("claimedById");
CREATE INDEX IF NOT EXISTS "SalesOrder_claimedCashSessionId_idx" ON "SalesOrder"("claimedCashSessionId");
CREATE INDEX IF NOT EXISTS "SalesOrder_claimExpiresAt_idx" ON "SalesOrder"("claimExpiresAt");
