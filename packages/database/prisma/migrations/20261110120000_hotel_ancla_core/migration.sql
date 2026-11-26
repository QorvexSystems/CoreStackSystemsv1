CREATE TYPE "HotelRoomStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'OCCUPIED', 'CLEANING', 'MAINTENANCE', 'OUT_OF_SERVICE');
CREATE TYPE "HousekeepingStatus" AS ENUM ('CLEAN', 'DIRTY', 'INSPECTING', 'IN_PROGRESS');
CREATE TYPE "HotelReservationStatus" AS ENUM ('PENDING_REVIEW', 'CONFIRMED', 'ASSIGNED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW');
CREATE TYPE "HotelPaymentStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID', 'REFUNDED');
CREATE TYPE "HotelChannelType" AS ENUM ('DIRECT_WEB', 'WHATSAPP', 'BOOKING', 'EXPEDIA', 'AIRBNB', 'WALK_IN', 'PHONE', 'OTHER');

CREATE TABLE "HotelRoomType" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "capacityAdults" INTEGER NOT NULL DEFAULT 2,
  "capacityChildren" INTEGER NOT NULL DEFAULT 0,
  "baseRate" DECIMAL(14,2) NOT NULL,
  "amenities" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HotelRoomType_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HotelRoom" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "roomTypeId" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "floor" INTEGER,
  "status" "HotelRoomStatus" NOT NULL DEFAULT 'AVAILABLE',
  "housekeepingStatus" "HousekeepingStatus" NOT NULL DEFAULT 'CLEAN',
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HotelRoom_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HotelGuest" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "documentType" "DocumentType",
  "documentNumber" TEXT,
  "nationality" TEXT,
  "birthDate" TIMESTAMP(3),
  "preferences" JSONB,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HotelGuest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HotelChannel" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "type" "HotelChannelType" NOT NULL,
  "name" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "externalId" TEXT,
  "settings" JSONB,
  "lastSyncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HotelChannel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HotelReservation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "guestId" TEXT NOT NULL,
  "roomTypeId" TEXT NOT NULL,
  "roomId" TEXT,
  "channelId" TEXT,
  "status" "HotelReservationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "paymentStatus" "HotelPaymentStatus" NOT NULL DEFAULT 'PENDING',
  "checkIn" TIMESTAMP(3) NOT NULL,
  "checkOut" TIMESTAMP(3) NOT NULL,
  "adults" INTEGER NOT NULL DEFAULT 1,
  "children" INTEGER NOT NULL DEFAULT 0,
  "totalAmount" DECIMAL(14,2) NOT NULL,
  "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "arrivalTime" TEXT,
  "specialRequests" TEXT,
  "sourceReference" TEXT,
  "checkedInAt" TIMESTAMP(3),
  "checkedOutAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HotelReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HotelRoomType_tenantId_name_key" ON "HotelRoomType"("tenantId", "name");
CREATE INDEX "HotelRoomType_tenantId_idx" ON "HotelRoomType"("tenantId");
CREATE UNIQUE INDEX "HotelRoom_tenantId_number_key" ON "HotelRoom"("tenantId", "number");
CREATE INDEX "HotelRoom_tenantId_status_idx" ON "HotelRoom"("tenantId", "status");
CREATE INDEX "HotelRoom_roomTypeId_idx" ON "HotelRoom"("roomTypeId");
CREATE UNIQUE INDEX "HotelGuest_tenantId_documentType_documentNumber_key" ON "HotelGuest"("tenantId", "documentType", "documentNumber");
CREATE INDEX "HotelGuest_tenantId_lastName_firstName_idx" ON "HotelGuest"("tenantId", "lastName", "firstName");
CREATE INDEX "HotelGuest_tenantId_email_idx" ON "HotelGuest"("tenantId", "email");
CREATE UNIQUE INDEX "HotelChannel_tenantId_type_name_key" ON "HotelChannel"("tenantId", "type", "name");
CREATE INDEX "HotelChannel_tenantId_active_idx" ON "HotelChannel"("tenantId", "active");
CREATE UNIQUE INDEX "HotelReservation_tenantId_code_key" ON "HotelReservation"("tenantId", "code");
CREATE INDEX "HotelReservation_tenantId_status_checkIn_idx" ON "HotelReservation"("tenantId", "status", "checkIn");
CREATE INDEX "HotelReservation_tenantId_checkOut_idx" ON "HotelReservation"("tenantId", "checkOut");
CREATE INDEX "HotelReservation_guestId_idx" ON "HotelReservation"("guestId");
CREATE INDEX "HotelReservation_roomId_idx" ON "HotelReservation"("roomId");
CREATE INDEX "HotelReservation_channelId_idx" ON "HotelReservation"("channelId");

ALTER TABLE "HotelRoomType" ADD CONSTRAINT "HotelRoomType_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HotelRoom" ADD CONSTRAINT "HotelRoom_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HotelRoom" ADD CONSTRAINT "HotelRoom_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "HotelRoomType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HotelGuest" ADD CONSTRAINT "HotelGuest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HotelChannel" ADD CONSTRAINT "HotelChannel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HotelReservation" ADD CONSTRAINT "HotelReservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HotelReservation" ADD CONSTRAINT "HotelReservation_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "HotelGuest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HotelReservation" ADD CONSTRAINT "HotelReservation_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "HotelRoomType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HotelReservation" ADD CONSTRAINT "HotelReservation_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "HotelRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HotelReservation" ADD CONSTRAINT "HotelReservation_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "HotelChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
