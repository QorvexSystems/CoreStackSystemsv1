CREATE TYPE "HotelBillingDocumentType" AS ENUM ('SALE_NOTE', 'E31', 'E32');

CREATE TABLE "HotelReservationPayment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "billingDocumentType" "HotelBillingDocumentType" NOT NULL,
    "fiscalDocumentType" "DocumentType",
    "fiscalDocumentNumber" TEXT,
    "receiptNumber" TEXT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HotelReservationPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HotelReservationPayment_tenantId_receiptNumber_key"
ON "HotelReservationPayment"("tenantId", "receiptNumber");
CREATE INDEX "HotelReservationPayment_tenantId_createdAt_idx"
ON "HotelReservationPayment"("tenantId", "createdAt");
CREATE INDEX "HotelReservationPayment_reservationId_idx"
ON "HotelReservationPayment"("reservationId");
CREATE INDEX "HotelReservationPayment_recordedById_idx"
ON "HotelReservationPayment"("recordedById");

ALTER TABLE "HotelReservationPayment"
ADD CONSTRAINT "HotelReservationPayment_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HotelReservationPayment"
ADD CONSTRAINT "HotelReservationPayment_reservationId_fkey"
FOREIGN KEY ("reservationId") REFERENCES "HotelReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HotelReservationPayment"
ADD CONSTRAINT "HotelReservationPayment_recordedById_fkey"
FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
