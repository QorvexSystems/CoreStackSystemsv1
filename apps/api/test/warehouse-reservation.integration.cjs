const assert = require('node:assert/strict');
const { PrismaClient } = require('../../../packages/database/generated/client');
const { ProductInventoryDestination } = require('@qorvex/database');
const { reserveOrderStock } = require('../dist/common/utils/order-stock-reservation');
const { OrdersService } = require('../dist/modules/orders/orders.service');

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || new URL(testUrl).pathname !== '/reservation_test') {
  throw new Error('TEST_DATABASE_URL must point to an isolated reservation_test database.');
}

const prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
const tenantId = 'test-tenant';
const productId = 'test-product';
const item = { productId, description: 'Caja B2B', quantity: 2, trackInventory: false };

async function main() {
  await prisma.$executeRawUnsafe(`CREATE TYPE "ProductInventoryDestination" AS ENUM ('SALES_INVENTORY', 'WAREHOUSE')`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "Product" (
    "id" text PRIMARY KEY,
    "tenantId" text NOT NULL,
    "inventoryDestination" "ProductInventoryDestination" NOT NULL,
    "reservedStock" double precision NOT NULL DEFAULT 0,
    "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "WarehouseStock" (
    "id" text PRIMARY KEY,
    "tenantId" text NOT NULL,
    "productId" text NOT NULL,
    "quantity" double precision NOT NULL,
    UNIQUE ("tenantId", "productId")
  )`);
  await prisma.$executeRaw`
    INSERT INTO "Product" ("id", "tenantId", "inventoryDestination")
    VALUES (${productId}, ${tenantId}, 'WAREHOUSE'::"ProductInventoryDestination")
  `;
  await prisma.$executeRaw`
    INSERT INTO "WarehouseStock" ("id", "tenantId", "productId", "quantity")
    VALUES ('test-stock', ${tenantId}, ${productId}, 2)
  `;

  let firstReserved;
  const firstHasReserved = new Promise((resolve) => { firstReserved = resolve; });
  const first = prisma.$transaction(async (tx) => {
    await reserveOrderStock(tx, tenantId, ProductInventoryDestination.WAREHOUSE, [item]);
    firstReserved();
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  await firstHasReserved;
  const second = prisma.$transaction((tx) =>
    reserveOrderStock(tx, tenantId, ProductInventoryDestination.WAREHOUSE, [item]));
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /Insufficient available stock/);

  const reserved = await prisma.product.findUniqueOrThrow({
    where: { id: productId }, select: { reservedStock: true },
  });
  assert.equal(reserved.reservedStock, 2);
  const service = new OrdersService(prisma);
  await prisma.$transaction((tx) => service.releaseReservedStock(
    [{ productId, reservedQuantity: 2 }], tx));
  const released = await prisma.product.findUniqueOrThrow({
    where: { id: productId }, select: { reservedStock: true },
  });
  assert.equal(released.reservedStock, 0);
  await prisma.$transaction((tx) => reserveOrderStock(
    tx, tenantId, ProductInventoryDestination.WAREHOUSE, [item]));
  process.stdout.write('Concurrent reservation, rejection, release and reuse: OK\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
