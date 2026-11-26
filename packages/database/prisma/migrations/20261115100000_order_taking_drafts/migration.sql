CREATE TABLE "OrderTakingDraft" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderTakingDraft_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderTakingDraft_tenantId_updatedAt_idx" ON "OrderTakingDraft"("tenantId", "updatedAt");
CREATE INDEX "OrderTakingDraft_tenantId_createdById_idx" ON "OrderTakingDraft"("tenantId", "createdById");
ALTER TABLE "OrderTakingDraft" ADD CONSTRAINT "OrderTakingDraft_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderTakingDraft" ADD CONSTRAINT "OrderTakingDraft_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'allpa_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "OrderTakingDraft" TO allpa_runtime;
  END IF;
END $$;
