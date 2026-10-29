import { BadRequestException } from '@nestjs/common';
import { Prisma, SalePaymentMode } from '@qorvex/database';

export async function deliverOrder(
  tx: Prisma.TransactionClient,
  tenantId: string,
  id: string,
  userId: string,
  note?: string,
) {
  await tx.$queryRaw`SELECT "id" FROM "SalesOrder" WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const order = await tx.salesOrder.findFirstOrThrow({
    where: { id, tenantId },
    include: { invoice: true, corporateUnits: true },
  });
  if (
    order.status !== 'COMPLETED' ||
    order.productionStage !== 'READY' ||
    order.exceptionStatus !== 'NONE'
  ) {
    throw new BadRequestException(
      'La orden debe estar facturada, lista y sin incidencias para entregarse.',
    );
  }
  if (
    !order.invoice ||
    ['DRAFT', 'CANCELLED', 'VOID', 'VOIDED', 'CREDITED'].includes(order.invoice.status)
  )
    throw new BadRequestException('La orden no tiene una factura vigente para entregar.');
  if (order.requiresProduction && !order.qualityApprovedAt)
    throw new BadRequestException('Falta aprobar calidad.');
  if (order.paymentMode !== SalePaymentMode.CREDIT && order.invoice?.balance.gt(0))
    throw new BadRequestException('Completa el balance antes de entregar.');
  if (
    order.isCorporate &&
    (!order.corporateUnits.length || order.corporateUnits.some((unit) => !unit.deliveredAt))
  )
    throw new BadRequestException('Completa las entregas empresariales antes de cerrar la orden.');
  await tx.salesOrder.update({
    where: { id },
    data: { productionStage: 'DELIVERED', deliveredAt: new Date(), deliveredById: userId },
  });
  await tx.orderWorkflowEvent.create({
    data: {
      tenantId,
      salesOrderId: id,
      fromStage: 'READY',
      toStage: 'DELIVERED',
      changedById: userId,
      note: note ?? 'Entrega confirmada',
    },
  });
}
