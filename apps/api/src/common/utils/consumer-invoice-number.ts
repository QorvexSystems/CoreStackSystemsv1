import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@qorvex/database';
export async function consumerInvoiceNumber(tx: Prisma.TransactionClient, tenantId: string) {
  const sequences = await tx.$queryRaw<Array<{ id: string; prefix: string; nextNumber: number }>>`
    SELECT "id", "prefix", "nextNumber" FROM "FiscalSequence"
    WHERE "tenantId" = ${tenantId} AND "documentType" = 'CONSUMER_02'::"InvoiceDocumentType"
    AND "status" = 'ACTIVE'::"FiscalSequenceStatus" AND "nextNumber" <= "endNumber"
    AND ("validUntil" IS NULL OR "validUntil" >= NOW())
    ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE
  `;
  const sequence = sequences[0];
  if (!sequence)
    throw new BadRequestException(
      'Configura una secuencia B02 activa para facturar las órdenes Shopify.',
    );
  await tx.fiscalSequence.update({
    where: { id: sequence.id },
    data: { nextNumber: { increment: 1 } },
  });
  const ncf = sequence.prefix + String(sequence.nextNumber).padStart(8, '0');
  return { invoiceNumber: 'UP-' + ncf, ncf, documentType: 'CONSUMER_02' as const };
}
