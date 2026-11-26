-- Return request workflow for cashier-submitted refunds approved by admins.
CREATE TYPE "ReturnRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED');

ALTER TYPE "EmployeeLogAction" ADD VALUE IF NOT EXISTS 'REQUEST_RETURN';
ALTER TYPE "EmployeeLogAction" ADD VALUE IF NOT EXISTS 'APPROVE_RETURN';
ALTER TYPE "EmployeeLogAction" ADD VALUE IF NOT EXISTS 'REJECT_RETURN';
ALTER TYPE "EmployeeLogAction" ADD VALUE IF NOT EXISTS 'COMPLETE_RETURN';

CREATE TABLE "ReturnRequest" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "approvedById" TEXT,
  "rejectedById" TEXT,
  "cashSessionId" TEXT,
  "status" "ReturnRequestStatus" NOT NULL DEFAULT 'REQUESTED',
  "reason" TEXT NOT NULL,
  "adminNote" TEXT,
  "refundMethod" "PaymentMethod",
  "refundAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "approvedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReturnRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReturnRequestItem" (
  "id" TEXT NOT NULL,
  "returnRequestId" TEXT NOT NULL,
  "invoiceItemId" TEXT NOT NULL,
  "productId" TEXT,
  "description" TEXT NOT NULL,
  "quantity" DECIMAL(12,2) NOT NULL,
  "unitPrice" DECIMAL(12,2) NOT NULL,
  "discountTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "taxRate" DECIMAL(5,4) NOT NULL,
  "taxTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "subtotal" DECIMAL(12,2) NOT NULL,
  "total" DECIMAL(12,2) NOT NULL,
  "restock" BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT "ReturnRequestItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReturnRequest_tenantId_idx" ON "ReturnRequest"("tenantId");
CREATE INDEX "ReturnRequest_tenantId_status_idx" ON "ReturnRequest"("tenantId", "status");
CREATE INDEX "ReturnRequest_invoiceId_idx" ON "ReturnRequest"("invoiceId");
CREATE INDEX "ReturnRequest_requestedById_idx" ON "ReturnRequest"("requestedById");
CREATE INDEX "ReturnRequest_approvedById_idx" ON "ReturnRequest"("approvedById");
CREATE INDEX "ReturnRequest_rejectedById_idx" ON "ReturnRequest"("rejectedById");
CREATE INDEX "ReturnRequest_cashSessionId_idx" ON "ReturnRequest"("cashSessionId");
CREATE INDEX "ReturnRequest_createdAt_idx" ON "ReturnRequest"("createdAt");

CREATE INDEX "ReturnRequestItem_returnRequestId_idx" ON "ReturnRequestItem"("returnRequestId");
CREATE INDEX "ReturnRequestItem_invoiceItemId_idx" ON "ReturnRequestItem"("invoiceItemId");
CREATE INDEX "ReturnRequestItem_productId_idx" ON "ReturnRequestItem"("productId");

ALTER TABLE "ReturnRequest"
ADD CONSTRAINT "ReturnRequest_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReturnRequest"
ADD CONSTRAINT "ReturnRequest_invoiceId_fkey"
FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReturnRequest"
ADD CONSTRAINT "ReturnRequest_requestedById_fkey"
FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReturnRequest"
ADD CONSTRAINT "ReturnRequest_approvedById_fkey"
FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ReturnRequest"
ADD CONSTRAINT "ReturnRequest_rejectedById_fkey"
FOREIGN KEY ("rejectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ReturnRequest"
ADD CONSTRAINT "ReturnRequest_cashSessionId_fkey"
FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ReturnRequestItem"
ADD CONSTRAINT "ReturnRequestItem_returnRequestId_fkey"
FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReturnRequestItem"
ADD CONSTRAINT "ReturnRequestItem_invoiceItemId_fkey"
FOREIGN KEY ("invoiceItemId") REFERENCES "InvoiceItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReturnRequestItem"
ADD CONSTRAINT "ReturnRequestItem_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
