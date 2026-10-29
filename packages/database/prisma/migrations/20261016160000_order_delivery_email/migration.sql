CREATE TYPE "DeliveryMethod" AS ENUM ('PICKUP', 'DELIVERY', 'PROVINCE_SHIPPING');
CREATE TYPE "DispatchLocation" AS ENUM ('STORE', 'FACTORY');

ALTER TABLE "SalesOrder"
ADD COLUMN "deliveryMethod" "DeliveryMethod" NOT NULL DEFAULT 'PICKUP',
ADD COLUMN "dispatchLocation" "DispatchLocation" NOT NULL DEFAULT 'STORE',
ADD COLUMN "deliveryAddress" TEXT,
ADD COLUMN "deliveryPhone" TEXT,
ADD COLUMN "notificationEmail" TEXT,
ADD COLUMN "readyNotifiedAt" TIMESTAMP(3),
ADD COLUMN "readyNotificationId" TEXT,
ADD COLUMN "readyNotificationError" TEXT;
