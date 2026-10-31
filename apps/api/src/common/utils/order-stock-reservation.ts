import { BadRequestException } from '@nestjs/common';
import { Prisma, ProductInventoryDestination } from '@qorvex/database';

export type OrderStockReservationItem = {
  productId: string | null;
  description: string;
  quantity: number;
  trackInventory: boolean;
};

/** Product is the common lock for warehouse reservations and stock reductions. */
export async function lockWarehouseProduct(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productId: string,
) {
  const locked = await tx.$queryRaw<Array<{ reservedStock: number }>>`
    SELECT "reservedStock"
    FROM "Product"
    WHERE "id" = ${productId}
      AND "tenantId" = ${tenantId}
      AND "inventoryDestination" = 'WAREHOUSE'::"ProductInventoryDestination"
    FOR UPDATE
  `;
  if (locked.length !== 1) {
    throw new BadRequestException('Warehouse product is unavailable.');
  }
  return locked[0].reservedStock;
}

/** Reserve each product in a stable order so concurrent orders cannot promise the same stock. */
export async function reserveOrderStock(
  tx: Prisma.TransactionClient,
  tenantId: string,
  inventorySource: ProductInventoryDestination,
  items: OrderStockReservationItem[],
) {
  for (const item of [...items].sort((left, right) =>
    (left.productId ?? '').localeCompare(right.productId ?? ''),
  )) {
    if (!item.productId || item.quantity <= 0) continue;

    if (inventorySource === ProductInventoryDestination.WAREHOUSE) {
      const reservedStock = await lockWarehouseProduct(tx, tenantId, item.productId);
      const stock = await tx.warehouseStock.findUnique({
        where: { tenantId_productId: { tenantId, productId: item.productId } },
        select: { quantity: true },
      });
      if ((stock?.quantity ?? 0) - reservedStock + 1e-9 < item.quantity) {
        throw new BadRequestException(`Insufficient available stock for ${item.description}.`);
      }
      await tx.product.update({
        where: { id: item.productId },
        data: { reservedStock: { increment: item.quantity } },
        select: { id: true },
      });
      continue;
    }

    if (!item.trackInventory) continue;
    const updated = await tx.$executeRaw`
      UPDATE "Product"
      SET "reservedStock" = "reservedStock" + ${item.quantity}
      WHERE "id" = ${item.productId}
        AND "tenantId" = ${tenantId}
        AND "trackInventory" = TRUE
        AND ("stock" - "reservedStock") >= ${item.quantity}
    `;
    if (updated !== 1) {
      throw new BadRequestException(`Insufficient available stock for ${item.description}.`);
    }
  }
}
