-- CreateEnum
CREATE TYPE "WebAvailabilityPolicy" AS ENUM ('UNDECIDED', 'STOCKED', 'MADE_TO_ORDER');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "legacyEcommerceVariantId" TEXT,
ADD COLUMN     "legacyShopifyVariantId" TEXT,
ADD COLUMN     "originalSku" TEXT,
ADD COLUMN     "webAvailability" "WebAvailabilityPolicy",
ADD COLUMN     "webOptions" JSONB,
ADD COLUMN     "webProductId" TEXT;

-- CreateTable
CREATE TABLE "WebProduct" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legacyEcommerceId" TEXT NOT NULL,
    "legacyShopifyProductId" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "descriptionHtml" TEXT,
    "categoryLabel" TEXT,
    "options" JSONB NOT NULL,
    "personalizationOptions" JSONB,
    "imageUrl" TEXT,
    "imageManifest" JSONB,
    "publicationIntent" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "importSourceSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebProduct_tenantId_published_idx" ON "WebProduct"("tenantId", "published");

-- CreateIndex
CREATE UNIQUE INDEX "WebProduct_tenantId_id_key" ON "WebProduct"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WebProduct_tenantId_legacyEcommerceId_key" ON "WebProduct"("tenantId", "legacyEcommerceId");

-- CreateIndex
CREATE UNIQUE INDEX "WebProduct_tenantId_slug_key" ON "WebProduct"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "Product_tenantId_webProductId_idx" ON "Product"("tenantId", "webProductId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_legacyEcommerceVariantId_key" ON "Product"("tenantId", "legacyEcommerceVariantId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_webProductId_fkey" FOREIGN KEY ("tenantId", "webProductId") REFERENCES "WebProduct"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebProduct" ADD CONSTRAINT "WebProduct_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

