-- Reservaciones inasistidas (se marcan a las 9:00 PM y se borran 24 h después)
ALTER TABLE "HotelReservation" ADD COLUMN "noShowAt" TIMESTAMP(3),
ADD COLUMN "noShowRecoveredAt" TIMESTAMP(3);

-- Pago Express: facturas sin reservación
ALTER TABLE "HotelReservationPayment" ALTER COLUMN "reservationId" DROP NOT NULL,
ADD COLUMN "customerName" TEXT,
ADD COLUMN "customerPhone" TEXT,
ADD COLUMN "description" TEXT;
