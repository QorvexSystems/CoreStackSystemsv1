import { PrismaClient, ProductInventoryDestination } from '../generated/client';

const prisma = new PrismaClient();

async function main() {
  const products = await prisma.product.findMany({
    where: { inventoryDestination: ProductInventoryDestination.WAREHOUSE },
    select: { id: true, tenantId: true, cost: true, warehouseStocks: { select: { id: true } } },
  });
  const missing = products.filter((product) => product.warehouseStocks.length === 0);
  if (missing.length) {
    await prisma.warehouseStock.createMany({
      data: missing.map((product) => ({
        tenantId: product.tenantId,
        productId: product.id,
        quantity: 0,
        unitCost: product.cost,
      })),
      skipDuplicates: true,
    });
  }
  console.log(`Filas de existencia reparadas: ${missing.length}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
