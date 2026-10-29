CREATE TYPE "OrderSource" AS ENUM ('STORE', 'SHOPIFY');
CREATE TYPE "ProductionStage" AS ENUM ('WAITING', 'FACTORY', 'READY', 'DELIVERED');
CREATE TYPE "OrderExceptionStatus" AS ENUM ('NONE', 'PAUSED', 'PROBLEM', 'CANCELLED');
CREATE TYPE "OrderPriority" AS ENUM ('NORMAL', 'URGENT');

ALTER TABLE "SalesOrder"
ADD COLUMN "source" "OrderSource" NOT NULL DEFAULT 'STORE',
ADD COLUMN "externalOrderId" TEXT,
ADD COLUMN "productionStage" "ProductionStage" NOT NULL DEFAULT 'WAITING',
ADD COLUMN "exceptionStatus" "OrderExceptionStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN "priority" "OrderPriority" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN "promisedAt" TIMESTAMP(3),
ADD COLUMN "requiresProduction" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "designApprovedAt" TIMESTAMP(3),
ADD COLUMN "designApprovedById" TEXT,
ADD COLUMN "qualityApprovedAt" TIMESTAMP(3),
ADD COLUMN "qualityApprovedById" TEXT,
ADD COLUMN "productionNotes" TEXT,
ADD COLUMN "deliveredAt" TIMESTAMP(3),
ADD COLUMN "deliveredById" TEXT;

UPDATE "SalesOrder"
SET "productionStage" = CASE
  WHEN "status" = 'COMPLETED' THEN 'DELIVERED'::"ProductionStage"
  ELSE 'WAITING'::"ProductionStage"
END,
"deliveredAt" = CASE WHEN "status" = 'COMPLETED' THEN "completedAt" ELSE NULL END,
"exceptionStatus" = CASE
  WHEN "status" = 'CANCELLED' THEN 'CANCELLED'::"OrderExceptionStatus"
  ELSE 'NONE'::"OrderExceptionStatus"
END;

ALTER TABLE "SalesOrder"
ADD CONSTRAINT "SalesOrder_designApprovedById_fkey" FOREIGN KEY ("designApprovedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "SalesOrder_qualityApprovedById_fkey" FOREIGN KEY ("qualityApprovedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "SalesOrder_deliveredById_fkey" FOREIGN KEY ("deliveredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "SalesOrder_tenantId_source_externalOrderId_key" ON "SalesOrder"("tenantId", "source", "externalOrderId");
CREATE INDEX "SalesOrder_tenantId_productionStage_exceptionStatus_idx" ON "SalesOrder"("tenantId", "productionStage", "exceptionStatus");
CREATE INDEX "SalesOrder_tenantId_promisedAt_idx" ON "SalesOrder"("tenantId", "promisedAt");

CREATE TABLE "OrderWorkflowEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "salesOrderId" TEXT NOT NULL,
  "fromStage" "ProductionStage",
  "toStage" "ProductionStage" NOT NULL,
  "exceptionStatus" "OrderExceptionStatus" NOT NULL DEFAULT 'NONE',
  "note" TEXT,
  "changedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderWorkflowEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OrderWorkflowEvent"
ADD CONSTRAINT "OrderWorkflowEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "OrderWorkflowEvent_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "OrderWorkflowEvent_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "OrderWorkflowEvent_tenantId_createdAt_idx" ON "OrderWorkflowEvent"("tenantId", "createdAt");
CREATE INDEX "OrderWorkflowEvent_salesOrderId_createdAt_idx" ON "OrderWorkflowEvent"("salesOrderId", "createdAt");
CREATE INDEX "OrderWorkflowEvent_changedById_idx" ON "OrderWorkflowEvent"("changedById");
