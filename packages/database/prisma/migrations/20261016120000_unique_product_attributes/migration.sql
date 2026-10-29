-- Unique Personalizado sells each material/measurement combination as one SKU.
CREATE TYPE "ProductKind" AS ENUM ('STANDARD', 'PERSONALIZED');

ALTER TABLE "Product"
ADD COLUMN "kind" "ProductKind" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN "material" TEXT,
ADD COLUMN "measurement" TEXT;

CREATE INDEX "Product_tenantId_kind_status_idx"
ON "Product"("tenantId", "kind", "status");
