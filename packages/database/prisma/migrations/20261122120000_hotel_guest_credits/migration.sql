-- CreateTable
CREATE TABLE "HotelGuestCredit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "sourceReservationId" TEXT,
    "nights" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "remainingAmount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HotelGuestCredit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HotelGuestCredit_tenantId_guestId_idx" ON "HotelGuestCredit"("tenantId", "guestId");

-- CreateIndex
CREATE INDEX "HotelGuestCredit_sourceReservationId_idx" ON "HotelGuestCredit"("sourceReservationId");

-- AddForeignKey
ALTER TABLE "HotelGuestCredit" ADD CONSTRAINT "HotelGuestCredit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelGuestCredit" ADD CONSTRAINT "HotelGuestCredit_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "HotelGuest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelGuestCredit" ADD CONSTRAINT "HotelGuestCredit_sourceReservationId_fkey" FOREIGN KEY ("sourceReservationId") REFERENCES "HotelReservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
