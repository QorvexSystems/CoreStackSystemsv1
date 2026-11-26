CREATE TABLE "WorkshopReadyNotification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "messageId" TEXT,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkshopReadyNotification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkshopReadyNotification_ticketId_key" ON "WorkshopReadyNotification"("ticketId");
CREATE UNIQUE INDEX "WorkshopReadyNotification_tenantId_ticketId_key" ON "WorkshopReadyNotification"("tenantId", "ticketId");
CREATE INDEX "WorkshopReadyNotification_tenantId_status_idx" ON "WorkshopReadyNotification"("tenantId", "status");
CREATE INDEX "WorkshopReadyNotification_status_nextAttemptAt_idx" ON "WorkshopReadyNotification"("status", "nextAttemptAt");
ALTER TABLE "WorkshopReadyNotification" ADD CONSTRAINT "WorkshopReadyNotification_tenantId_ticketId_fkey" FOREIGN KEY ("tenantId", "ticketId") REFERENCES "WorkshopTicket"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
