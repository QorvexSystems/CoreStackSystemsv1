import { BadRequestException } from '@nestjs/common';
import { Prisma, ProductInventoryDestination } from '@qorvex/database';

export async function markInventoryChanged(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productId: string,
) {
  await tx.inventorySyncJob.upsert({
    where: { tenantId_productId: { tenantId, productId } },
    create: { tenantId, productId },
    update: { pending: true, revision: { increment: 1 }, error: null },
  });
}

export async function changeReservation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productId: string,
  source: ProductInventoryDestination,
  quantity: number,
) {
  if (source !== ProductInventoryDestination.SALES_INVENTORY) {
    throw new BadRequestException('El inventario físico de Fábrica ya no está disponible.');
  }
  const changed = await tx.$executeRaw`
      UPDATE "Product" SET "reservedStock" = "reservedStock" + ${quantity}
      WHERE "tenantId" = ${tenantId} AND "id" = ${productId}
      AND "reservedStock" + ${quantity} >= 0 AND "stock" >= "reservedStock" + ${quantity}
    `;
  if (changed !== 1)
    throw new BadRequestException(
      'No hay existencia disponible suficiente en la ubicación seleccionada.',
    );
  await markInventoryChanged(tx, tenantId, productId);
}
