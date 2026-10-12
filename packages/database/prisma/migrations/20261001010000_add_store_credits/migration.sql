ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'CREDIT';

CREATE TABLE "StoreCredit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceInvoiceId" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "issuedById" TEXT NOT NULL,
    "originalAmount" DECIMAL(12,2) NOT NULL,
    "remainingAmount" DECIMAL(12,2) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreCredit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreCredit_amount_check" CHECK (
      "originalAmount" > 0 AND
      "remainingAmount" >= 0 AND
      "remainingAmount" <= "originalAmount"
    )
);

CREATE TABLE "StoreCreditRedemption" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeCreditId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "redeemedById" TEXT NOT NULL,
    "cashSessionId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreCreditRedemption_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreCreditRedemption_amount_check" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "StoreCredit_returnRequestId_key" ON "StoreCredit"("returnRequestId");
CREATE INDEX "StoreCredit_tenantId_idx" ON "StoreCredit"("tenantId");
CREATE INDEX "StoreCredit_tenantId_sourceInvoiceId_idx" ON "StoreCredit"("tenantId", "sourceInvoiceId");
CREATE INDEX "StoreCredit_tenantId_expiresAt_idx" ON "StoreCredit"("tenantId", "expiresAt");

CREATE INDEX "StoreCreditRedemption_tenantId_idx" ON "StoreCreditRedemption"("tenantId");
CREATE INDEX "StoreCreditRedemption_storeCreditId_idx" ON "StoreCreditRedemption"("storeCreditId");
CREATE UNIQUE INDEX "StoreCreditRedemption_storeCreditId_invoiceId_key" ON "StoreCreditRedemption"("storeCreditId", "invoiceId");
CREATE INDEX "StoreCreditRedemption_redeemedById_idx" ON "StoreCreditRedemption"("redeemedById");
CREATE INDEX "StoreCreditRedemption_cashSessionId_idx" ON "StoreCreditRedemption"("cashSessionId");
CREATE INDEX "StoreCreditRedemption_createdAt_idx" ON "StoreCreditRedemption"("createdAt");

ALTER TABLE "StoreCredit" ADD CONSTRAINT "StoreCredit_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreCredit" ADD CONSTRAINT "StoreCredit_sourceInvoiceId_fkey"
  FOREIGN KEY ("sourceInvoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreCredit" ADD CONSTRAINT "StoreCredit_returnRequestId_fkey"
  FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreCredit" ADD CONSTRAINT "StoreCredit_issuedById_fkey"
  FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StoreCreditRedemption" ADD CONSTRAINT "StoreCreditRedemption_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreCreditRedemption" ADD CONSTRAINT "StoreCreditRedemption_storeCreditId_fkey"
  FOREIGN KEY ("storeCreditId") REFERENCES "StoreCredit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreCreditRedemption" ADD CONSTRAINT "StoreCreditRedemption_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreCreditRedemption" ADD CONSTRAINT "StoreCreditRedemption_redeemedById_fkey"
  FOREIGN KEY ("redeemedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreCreditRedemption" ADD CONSTRAINT "StoreCreditRedemption_cashSessionId_fkey"
  FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
