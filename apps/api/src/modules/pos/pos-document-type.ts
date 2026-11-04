import { BadRequestException } from '@nestjs/common';
import { InvoiceDocumentType, PaymentMethod } from '@qorvex/database';

type PaymentSelection = {
  documentType?: InvoiceDocumentType;
  paymentMethod?: PaymentMethod;
  payments?: Array<{ method: PaymentMethod }>;
};

export function resolvePosDocumentType(input: PaymentSelection) {
  const methods = input.payments?.length
    ? input.payments.map((payment) => payment.method)
    : [input.paymentMethod ?? PaymentMethod.CASH];
  const cashOnly = methods.every((method) => method === PaymentMethod.CASH);
  const allowed: InvoiceDocumentType[] = cashOnly
    ? [InvoiceDocumentType.SALE_NOTE, InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31]
    : [InvoiceDocumentType.CONSUMER_ELECTRONIC_32, InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31];
  const documentType =
    input.documentType ??
    (cashOnly ? InvoiceDocumentType.SALE_NOTE : InvoiceDocumentType.CONSUMER_ELECTRONIC_32);

  if (!allowed.includes(documentType)) {
    throw new BadRequestException(
      cashOnly
        ? 'Con pago en efectivo solo puedes emitir Nota de venta o Fiscal E31.'
        : 'Con tarjeta, transferencia o pago mixto solo puedes emitir Consumo E32 o Fiscal E31.',
    );
  }

  return documentType;
}

export function isElectronicPosDocument(documentType: InvoiceDocumentType) {
  return (
    documentType === InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31 ||
    documentType === InvoiceDocumentType.CONSUMER_ELECTRONIC_32
  );
}
