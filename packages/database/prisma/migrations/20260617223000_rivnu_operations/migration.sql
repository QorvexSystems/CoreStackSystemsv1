-- CreateEnum
CREATE TYPE "InvoiceFiscalStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING_SEQUENCE', 'READY_TO_SEND', 'PENDING_SIGNATURE', 'SIGNED', 'SENT', 'ACCEPTED', 'REJECTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceDocumentType" AS ENUM ('CONSUMER_ELECTRONIC_32', 'FISCAL_CREDIT_ELECTRONIC_31', 'DEBIT_NOTE_ELECTRONIC_33', 'CREDIT_NOTE_ELECTRONIC_34');

-- CreateEnum
CREATE TYPE "BarcodeType" AS ENUM ('EAN13', 'UPC_A', 'CODE128', 'INTERNAL_CODE128', 'QR', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ProductUnit" AS ENUM ('UNIT', 'BOX', 'PACK', 'BAG', 'ROLL', 'METER', 'FOOT', 'POUND', 'GALLON', 'LITER', 'KILOGRAM', 'SERVICE');

-- CreateEnum
CREATE TYPE "TaxCategory" AS ENUM ('ITBIS_18', 'ITBIS_16', 'EXEMPT');

-- CreateEnum
CREATE TYPE "CashRegisterStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "CashSessionStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('OPENING', 'SALE_PAYMENT', 'CASH_IN', 'CASH_OUT', 'REFUND', 'CLOSING', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "EmployeeLogAction" AS ENUM ('OPEN_CASH_SESSION', 'CLOSE_CASH_SESSION', 'CREATE_SALE', 'CANCEL_SALE', 'ISSUE_INVOICE', 'CANCEL_INVOICE', 'APPLY_DISCOUNT', 'CHANGE_PRODUCT_PRICE', 'ADD_PRODUCT', 'UPDATE_PRODUCT', 'DELETE_PRODUCT', 'CHANGE_BARCODE', 'PRINT_RECEIPT', 'REPRINT_RECEIPT', 'CASH_IN', 'CASH_OUT', 'INVENTORY_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'BLOCKED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "FiscalSequenceStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'EXPIRED', 'EXHAUSTED');

-- CreateEnum
CREATE TYPE "ImportType" AS ENUM ('PRODUCTS', 'CATEGORIES', 'CUSTOMERS', 'INITIAL_INVENTORY', 'FISCAL_SEQUENCES', 'HISTORICAL_INVOICES', 'INVOICE_ITEMS', 'PAYMENTS');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('DRAFT', 'VALIDATING', 'READY', 'IMPORTED', 'FAILED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "ElectronicDocumentProvider" ADD VALUE 'DGII_DIRECT';

-- AlterEnum
ALTER TYPE "ElectronicDocumentStatus" ADD VALUE 'SIGNED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InventoryMovementType" ADD VALUE 'INITIAL_STOCK';
ALTER TYPE "InventoryMovementType" ADD VALUE 'PURCHASE';
ALTER TYPE "InventoryMovementType" ADD VALUE 'ADJUSTMENT_IN';
ALTER TYPE "InventoryMovementType" ADD VALUE 'ADJUSTMENT_OUT';
ALTER TYPE "InventoryMovementType" ADD VALUE 'DAMAGE';
ALTER TYPE "InventoryMovementType" ADD VALUE 'TRANSFER_IN';
ALTER TYPE "InventoryMovementType" ADD VALUE 'TRANSFER_OUT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InvoiceStatus" ADD VALUE 'PARTIALLY_PAID';
ALTER TYPE "InvoiceStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "InvoiceStatus" ADD VALUE 'VOIDED';
ALTER TYPE "InvoiceStatus" ADD VALUE 'CREDITED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MembershipStatus" ADD VALUE 'INACTIVE';
ALTER TYPE "MembershipStatus" ADD VALUE 'SUSPENDED';

-- AlterEnum
ALTER TYPE "ProductStatus" ADD VALUE 'DISCONTINUED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'SUPER_ADMIN';
ALTER TYPE "Role" ADD VALUE 'ADMIN';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserStatus" ADD VALUE 'INACTIVE';
ALTER TYPE "UserStatus" ADD VALUE 'BLOCKED';

-- AlterTable
ALTER TABLE "ElectronicDocument" ADD COLUMN     "requestPayload" JSONB,
ADD COLUMN     "responsePayload" JSONB,
ADD COLUMN     "trackId" TEXT;

-- AlterTable
ALTER TABLE "InventoryMovement" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "invoiceId" TEXT,
ADD COLUMN     "newStock" INTEGER,
ADD COLUMN     "previousStock" INTEGER,
ADD COLUMN     "unitCost" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "cashSessionId" TEXT,
ADD COLUMN     "documentType" "InvoiceDocumentType" NOT NULL DEFAULT 'CONSUMER_ELECTRONIC_32',
ADD COLUMN     "eNcf" TEXT,
ADD COLUMN     "fiscalStatus" "InvoiceFiscalStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
ADD COLUMN     "issuedById" TEXT,
ADD COLUMN     "ncf" TEXT,
ADD COLUMN     "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "paymentMethod" "PaymentMethod";

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "discountTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "sku" TEXT,
ADD COLUMN     "taxTotal" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "canAdjustInventory" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canApplyDiscount" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canCancelInvoice" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canCloseCashSession" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canManageEmployees" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canManageFiscalSequences" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canManageProducts" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canOpenCashSession" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canReprintReceipt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canUsePos" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canViewCashLogs" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canViewReports" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canVoidInvoice" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "cashSessionId" TEXT,
ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "barcodeCreatedById" TEXT,
ADD COLUMN     "barcodeLabelPrintCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "barcodeLabelPrintedAt" TIMESTAMP(3),
ADD COLUMN     "barcodeLastScannedAt" TIMESTAMP(3),
ADD COLUMN     "barcodeType" "BarcodeType",
ADD COLUMN     "brand" TEXT,
ADD COLUMN     "generatedBarcode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "margin" DECIMAL(8,4),
ADD COLUMN     "salePrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxCategory" "TaxCategory" NOT NULL DEFAULT 'ITBIS_18',
ADD COLUMN     "unit" "ProductUnit" NOT NULL DEFAULT 'UNIT';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "commercialName" TEXT,
ADD COLUMN     "legalName" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "phone" TEXT;

-- CreateTable
CREATE TABLE "EmployeeProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employeeCode" TEXT,
    "jobTitle" TEXT,
    "hireDate" TIMESTAMP(3),
    "documentType" "DocumentType",
    "documentNumber" TEXT,
    "address" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "notes" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashRegister" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "status" "CashRegisterStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashRegister_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cashRegisterId" TEXT NOT NULL,
    "openedById" TEXT NOT NULL,
    "closedById" TEXT,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'OPEN',
    "openingAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "closingAmount" DECIMAL(12,2),
    "expectedAmount" DECIMAL(12,2),
    "difference" DECIMAL(12,2),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "CashSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cashSessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod",
    "reason" TEXT,
    "reference" TEXT,
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeActivityLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cashSessionId" TEXT,
    "action" "EmployeeLogAction" NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "amount" DECIMAL(12,2),
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalSequence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentType" "InvoiceDocumentType" NOT NULL,
    "prefix" TEXT NOT NULL,
    "startNumber" INTEGER NOT NULL,
    "endNumber" INTEGER NOT NULL,
    "nextNumber" INTEGER NOT NULL,
    "validUntil" TIMESTAMP(3),
    "status" "FiscalSequenceStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "ImportType" NOT NULL,
    "filename" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'DRAFT',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRowError" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "field" TEXT,
    "message" TEXT NOT NULL,
    "rawData" JSONB,

    CONSTRAINT "ImportRowError_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeProfile_tenantId_status_idx" ON "EmployeeProfile"("tenantId", "status");

-- CreateIndex
CREATE INDEX "EmployeeProfile_userId_idx" ON "EmployeeProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeProfile_tenantId_userId_key" ON "EmployeeProfile"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeProfile_tenantId_employeeCode_key" ON "EmployeeProfile"("tenantId", "employeeCode");

-- CreateIndex
CREATE INDEX "CashRegister_tenantId_idx" ON "CashRegister"("tenantId");

-- CreateIndex
CREATE INDEX "CashRegister_tenantId_status_idx" ON "CashRegister"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CashSession_tenantId_idx" ON "CashSession"("tenantId");

-- CreateIndex
CREATE INDEX "CashSession_tenantId_status_idx" ON "CashSession"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CashSession_openedById_idx" ON "CashSession"("openedById");

-- CreateIndex
CREATE INDEX "CashSession_cashRegisterId_idx" ON "CashSession"("cashRegisterId");

-- CreateIndex
CREATE INDEX "CashMovement_tenantId_idx" ON "CashMovement"("tenantId");

-- CreateIndex
CREATE INDEX "CashMovement_cashSessionId_idx" ON "CashMovement"("cashSessionId");

-- CreateIndex
CREATE INDEX "CashMovement_userId_idx" ON "CashMovement"("userId");

-- CreateIndex
CREATE INDEX "CashMovement_invoiceId_idx" ON "CashMovement"("invoiceId");

-- CreateIndex
CREATE INDEX "CashMovement_tenantId_createdAt_idx" ON "CashMovement"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "EmployeeActivityLog_tenantId_idx" ON "EmployeeActivityLog"("tenantId");

-- CreateIndex
CREATE INDEX "EmployeeActivityLog_userId_idx" ON "EmployeeActivityLog"("userId");

-- CreateIndex
CREATE INDEX "EmployeeActivityLog_cashSessionId_idx" ON "EmployeeActivityLog"("cashSessionId");

-- CreateIndex
CREATE INDEX "EmployeeActivityLog_action_idx" ON "EmployeeActivityLog"("action");

-- CreateIndex
CREATE INDEX "EmployeeActivityLog_tenantId_createdAt_idx" ON "EmployeeActivityLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "FiscalSequence_tenantId_idx" ON "FiscalSequence"("tenantId");

-- CreateIndex
CREATE INDEX "FiscalSequence_tenantId_documentType_status_idx" ON "FiscalSequence"("tenantId", "documentType", "status");

-- CreateIndex
CREATE INDEX "ImportBatch_tenantId_idx" ON "ImportBatch"("tenantId");

-- CreateIndex
CREATE INDEX "ImportBatch_tenantId_type_status_idx" ON "ImportBatch"("tenantId", "type", "status");

-- CreateIndex
CREATE INDEX "ImportBatch_createdById_idx" ON "ImportBatch"("createdById");

-- CreateIndex
CREATE INDEX "ImportRowError_importBatchId_idx" ON "ImportRowError"("importBatchId");

-- CreateIndex
CREATE INDEX "ImportRowError_rowNumber_idx" ON "ImportRowError"("rowNumber");

-- CreateIndex
CREATE INDEX "InventoryMovement_invoiceId_idx" ON "InventoryMovement"("invoiceId");

-- CreateIndex
CREATE INDEX "InventoryMovement_createdById_idx" ON "InventoryMovement"("createdById");

-- CreateIndex
CREATE INDEX "Invoice_issuedById_idx" ON "Invoice"("issuedById");

-- CreateIndex
CREATE INDEX "Invoice_cashSessionId_idx" ON "Invoice"("cashSessionId");

-- CreateIndex
CREATE INDEX "Payment_userId_idx" ON "Payment"("userId");

-- CreateIndex
CREATE INDEX "Payment_cashSessionId_idx" ON "Payment"("cashSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_sku_key" ON "Product"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_barcode_key" ON "Product"("tenantId", "barcode");

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeProfile" ADD CONSTRAINT "EmployeeProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeProfile" ADD CONSTRAINT "EmployeeProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashRegister" ADD CONSTRAINT "CashRegister_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_cashRegisterId_fkey" FOREIGN KEY ("cashRegisterId") REFERENCES "CashRegister"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeActivityLog" ADD CONSTRAINT "EmployeeActivityLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeActivityLog" ADD CONSTRAINT "EmployeeActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeActivityLog" ADD CONSTRAINT "EmployeeActivityLog_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeActivityLog" ADD CONSTRAINT "EmployeeActivityLog_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalSequence" ADD CONSTRAINT "FiscalSequence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRowError" ADD CONSTRAINT "ImportRowError_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
