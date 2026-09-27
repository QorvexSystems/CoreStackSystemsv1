CREATE INDEX IF NOT EXISTS "SalesOrder_tenantId_status_claimExpiresAt_idx"
ON "SalesOrder"("tenantId", "status", "claimExpiresAt");

CREATE INDEX IF NOT EXISTS "CashSession_tenantId_openedById_status_openedAt_idx"
ON "CashSession"("tenantId", "openedById", "status", "openedAt");
