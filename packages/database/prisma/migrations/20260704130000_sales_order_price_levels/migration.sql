-- Add sales order price levels for consumer discounts and preferred customers.
CREATE TYPE "SalesOrderPriceLevel" AS ENUM ('REGULAR', 'DISCOUNT_10', 'PREFERRED_18');

ALTER TABLE "SalesOrder"
ADD COLUMN "priceLevel" "SalesOrderPriceLevel" NOT NULL DEFAULT 'REGULAR',
ADD COLUMN "discountRate" DECIMAL(5, 4) NOT NULL DEFAULT 0,
ADD COLUMN "discountTotal" DECIMAL(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE "SalesOrderItem"
ADD COLUMN "discountTotal" DECIMAL(12, 2) NOT NULL DEFAULT 0;
