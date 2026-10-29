ALTER TABLE "Product"
ADD COLUMN "shopifyProductId" TEXT,
ADD COLUMN "shopifyVariantId" TEXT,
ADD COLUMN "shopifyInventoryItemId" TEXT,
ADD COLUMN "shopifySyncedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Product_tenantId_shopifyVariantId_key"
ON "Product"("tenantId", "shopifyVariantId");
