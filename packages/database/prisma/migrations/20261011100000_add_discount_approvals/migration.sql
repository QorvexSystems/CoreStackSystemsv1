CREATE TABLE "DiscountApproval" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "requestedRate" DECIMAL(5,4) NOT NULL,
    "status" "CreditApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestNote" TEXT,
    "decisionNote" TEXT,
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscountApproval_salesOrderId_key" ON "DiscountApproval"("salesOrderId");
CREATE INDEX "DiscountApproval_tenantId_status_idx" ON "DiscountApproval"("tenantId", "status");
CREATE INDEX "DiscountApproval_tenantId_dismissedAt_idx" ON "DiscountApproval"("tenantId", "dismissedAt");
CREATE INDEX "DiscountApproval_requestedById_idx" ON "DiscountApproval"("requestedById");
CREATE INDEX "DiscountApproval_decidedById_idx" ON "DiscountApproval"("decidedById");

ALTER TABLE "DiscountApproval"
ADD CONSTRAINT "DiscountApproval_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiscountApproval"
ADD CONSTRAINT "DiscountApproval_salesOrderId_fkey"
FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiscountApproval"
ADD CONSTRAINT "DiscountApproval_requestedById_fkey"
FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DiscountApproval"
ADD CONSTRAINT "DiscountApproval_decidedById_fkey"
FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
