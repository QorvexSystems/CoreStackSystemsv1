-- CreateEnum
CREATE TYPE "SalesOrderDestination" AS ENUM ('CASH_SALE', 'QUOTATION');

-- AlterEnum
ALTER TYPE "SalesOrderStatus" ADD VALUE 'QUOTATION';

-- AlterTable
ALTER TABLE "SalesOrder"
ADD COLUMN "destination" "SalesOrderDestination" NOT NULL DEFAULT 'CASH_SALE',
ADD COLUMN "clientName" TEXT,
ADD COLUMN "quotationDocumentType" "DocumentType",
ADD COLUMN "quotationDocumentNumber" TEXT;

-- CreateIndex
CREATE INDEX "SalesOrder_tenantId_destination_status_idx" ON "SalesOrder"("tenantId", "destination", "status");
