CREATE TYPE "CorporateUnitStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED');

ALTER TABLE "SalesOrder"
ADD COLUMN "isCorporate" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "CorporateOrderUnit" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "salesOrderId" TEXT NOT NULL,
  "recipientName" TEXT NOT NULL,
  "message" TEXT,
  "personalization" JSONB,
  "status" "CorporateUnitStatus" NOT NULL DEFAULT 'PENDING',
  "updatedById" TEXT,
  "deliveredAt" TIMESTAMP(3),
  "deliveredById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CorporateOrderUnit_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CorporateOrderUnit"
ADD CONSTRAINT "CorporateOrderUnit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "CorporateOrderUnit_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "CorporateOrderUnit_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "CorporateOrderUnit_deliveredById_fkey" FOREIGN KEY ("deliveredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "CorporateOrderUnit_tenantId_status_idx" ON "CorporateOrderUnit"("tenantId", "status");
CREATE INDEX "CorporateOrderUnit_salesOrderId_status_idx" ON "CorporateOrderUnit"("salesOrderId", "status");
CREATE INDEX "CorporateOrderUnit_updatedById_idx" ON "CorporateOrderUnit"("updatedById");
CREATE INDEX "CorporateOrderUnit_deliveredById_idx" ON "CorporateOrderUnit"("deliveredById");
