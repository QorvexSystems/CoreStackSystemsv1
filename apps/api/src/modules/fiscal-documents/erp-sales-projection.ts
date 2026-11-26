import { BadRequestException } from '@nestjs/common';
import {
  InvoiceDocumentType,
  InvoiceFiscalStatus,
  InvoiceStatus,
  Prisma,
  SalePaymentMode,
} from '@qorvex/database';
import type { Invoice, InvoiceItem } from '@qorvex/database';
import { businessDateKey } from '../../common/utils/business-date';
import { summarizeFiscalTax } from '../../common/utils/fiscal-tax-allocation';
import { readFiscalCustomerSnapshot } from './fiscal-document';
import { electronicSalesDigest, validateElectronicSalesRequest } from './electronic-sales-guard';

type PersistedDraft = Pick<
  Invoice,
  | 'id'
  | 'tenantId'
  | 'updatedAt'
  | 'documentType'
  | 'status'
  | 'fiscalStatus'
  | 'ncf'
  | 'eNcf'
  | 'issuedAt'
  | 'paymentMode'
  | 'dueDate'
  | 'fiscalIssuerSnapshot'
  | 'fiscalCustomerSnapshot'
  | 'subtotal'
  | 'discountTotal'
  | 'taxTotal'
  | 'total'
> & { items: InvoiceItem[] };

/** Internal projection for the fiscal preflight transport. The caller MUST load
 * the draft under its authenticated tenant and transaction, check fiscal identity
 * freshness/overrides, and persist the immutable request before any reservation.
 * This helper is not an authorization gate and never converts a local invoice.
 */
export function projectPersistedElectronicSalesDraft(
  draft: PersistedDraft,
  context: {
    tenantId: string;
    operationId: string;
    issuedOn: string;
    incomeType: '01' | '02' | '03' | '04' | '05' | '06';
  },
) {
  if (draft.tenantId !== context.tenantId) throw new BadRequestException('ERP_TENANT_MISMATCH');
  const documentType = draft.documentType;
  if (
    documentType !== InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31 &&
    documentType !== InvoiceDocumentType.CONSUMER_ELECTRONIC_32
  ) {
    throw new BadRequestException('UNSUPPORTED_ERP_DOCUMENT');
  }
  if (
    draft.status !== InvoiceStatus.DRAFT ||
    draft.fiscalStatus !== InvoiceFiscalStatus.NOT_APPLICABLE ||
    draft.ncf !== null ||
    draft.eNcf !== null ||
    draft.issuedAt !== null
  ) {
    throw new BadRequestException('ERP_ALREADY_ISSUED_OR_NOT_DRAFT');
  }
  const issuer = draft.fiscalIssuerSnapshot;
  if (
    !issuer ||
    typeof issuer !== 'object' ||
    Array.isArray(issuer) ||
    typeof issuer.rnc !== 'string' ||
    typeof issuer.legalName !== 'string' ||
    typeof issuer.address !== 'string'
  ) {
    throw new BadRequestException('MISSING_PERSISTED_ISSUER');
  }
  const customer = readFiscalCustomerSnapshot(draft.fiscalCustomerSnapshot);
  if (draft.fiscalCustomerSnapshot !== null && !customer) {
    throw new BadRequestException('INVALID_PERSISTED_CUSTOMER');
  }
  if (documentType === InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31 && !customer) {
    throw new BadRequestException('MISSING_PERSISTED_CUSTOMER');
  }
  if (draft.paymentMode === SalePaymentMode.CASH && draft.dueDate !== null) {
    throw new BadRequestException('CASH_DUE_DATE_NOT_APPLICABLE');
  }
  // Decimal strings only, no Number conversion, no fresh catalogue lookup.
  // Stable ordering for repeated reads; issued XML line ordering will be frozen
  // with the immutable request by the future transactional producer.
  const items = [...draft.items]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => {
      if (item.invoiceId !== draft.id) throw new BadRequestException('ERP_LINE_DOCUMENT_MISMATCH');
      if (item.fiscalItemKind !== 'GOOD' && item.fiscalItemKind !== 'SERVICE') {
        throw new BadRequestException('MISSING_PERSISTED_ITEM_KIND');
      }
      return {
        id: item.id,
        description: item.description,
        kind: item.fiscalItemKind,
        quantity: item.quantity.toString(),
        unitPrice: item.unitPrice.toString(),
        ...(item.originalUnitPrice === null
          ? {}
          : { originalUnitPrice: item.originalUnitPrice.toString() }),
        discountTotal: item.discountTotal.toString(),
        taxCategory: item.taxCategory,
        taxRate: item.taxRate.toString(),
        subtotal: item.subtotal.toString(),
        taxTotal: item.taxTotal.toString(),
        total: item.total.toString(),
      };
    });
  return {
    id: draft.id,
    revision: draft.updatedAt.toISOString(),
    tenantId: draft.tenantId,
    operationId: context.operationId,
    pricingProfile: 'ERP_NET_UNIT_PRICE_V1' as const,
    status: 'DRAFT' as const,
    fiscalStatus: 'NOT_APPLICABLE' as const,
    ncf: null,
    eNcf: null,
    documentType,
    issuedOn: context.issuedOn,
    incomeType: context.incomeType,
    paymentMode: draft.paymentMode,
    dueOn: draft.dueDate ? businessDateKey(draft.dueDate) : null,
    issuer: { rnc: issuer.rnc, legalName: issuer.legalName, address: issuer.address },
    customer: customer
      ? {
          documentType: customer.documentType,
          documentNumber: customer.documentNumber,
          name: customer.name,
        }
      : null,
    items,
    subtotal: draft.subtotal.toString(),
    discountTotal: draft.discountTotal.toString(),
    taxTotal: draft.taxTotal.toString(),
    total: draft.total.toString(),
  };
}

/** Produces the strict immutable request consumed by the isolated fiscal core.
 * It only transforms the already-persisted draft; VM4 validates the contract
 * again before atomically reserving an e-NCF.
 */
export function buildElectronicFiscalDispatch(
  draft: PersistedDraft,
  context: {
    tenantId: string;
    issuerRnc: string;
    operationId: string;
    issuedOn: string;
    incomeType: '01' | '02' | '03' | '04' | '05' | '06';
  },
) {
  const snapshot = projectPersistedElectronicSalesDraft(draft, context);
  const fiscalTotals = summarizeFiscalTax(
    snapshot.items.map((item) => ({
      subtotal: new Prisma.Decimal(item.subtotal),
      taxRate: new Prisma.Decimal(item.taxRate),
    })),
  );
  if (
    !fiscalTotals.subtotal.eq(snapshot.subtotal) ||
    !fiscalTotals.taxTotal.eq(snapshot.taxTotal) ||
    !fiscalTotals.total.eq(snapshot.total)
  ) {
    throw new BadRequestException('Los totales de la venta no coinciden con el cálculo fiscal.');
  }
  const request = {
    version: '1' as const,
    operationId: snapshot.operationId.trim(),
    source: { documentId: snapshot.id.trim(), revision: snapshot.revision.trim() },
    type: snapshot.documentType === InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31 ? 31 : 32,
    issuedOn: snapshot.issuedOn,
    currency: 'DOP' as const,
    pricesIncludeTax: false as const,
    issuer: {
      rnc: snapshot.issuer.rnc,
      fiscalName: snapshot.issuer.legalName.trim(),
      address: snapshot.issuer.address.trim(),
    },
    ...(snapshot.customer
      ? {
          buyer: {
            kind: snapshot.customer.documentType === 'PASSPORT' ? ('FOREIGN' as const) : ('DOMESTIC' as const),
            identifier: snapshot.customer.documentType === 'PASSPORT'
              ? snapshot.customer.documentNumber.trim()
              : snapshot.customer.documentNumber,
            fiscalName: snapshot.customer.name.trim(),
          },
        }
      : {}),
    incomeType: context.incomeType,
    payment: {
      type: snapshot.paymentMode === SalePaymentMode.CASH ? (1 as const) : (2 as const),
      ...(snapshot.paymentMode === SalePaymentMode.CREDIT && snapshot.dueOn
        ? { dueOn: snapshot.dueOn }
        : {}),
    },
    lines: snapshot.items.map((item) => ({
      sourceLineId: item.id.trim(),
      // Match parseFiscalRequest BEFORE persisting/hashing the immutable
      // outbox. Otherwise VM4 reserves successfully but its normalized digest
      // differs and the ERP discards the acknowledgement on every retry.
      description: item.description.trim(),
      kind: item.kind,
      quantity: new Prisma.Decimal(item.quantity).toFixed(2),
      unitPrice: new Prisma.Decimal(item.originalUnitPrice ?? item.unitPrice).toFixed(4),
      discount: new Prisma.Decimal(item.discountTotal).toFixed(2),
      billingIndicator:
        item.taxCategory === 'ITBIS_18' ? (1 as const) : item.taxCategory === 'ITBIS_16' ? (2 as const) : (4 as const),
    })),
    expectedTotals: {
      net: fiscalTotals.subtotal.toFixed(2),
      itbis: fiscalTotals.taxTotal.toFixed(2),
      total: fiscalTotals.total.toFixed(2),
      itbisWithheld: '0.00',
      isrWithheld: '0.00',
    },
  };
  const scope = { tenantId: context.tenantId, issuerRnc: context.issuerRnc, environment: 'production' as const };
  validateElectronicSalesRequest(request, scope);
  const payloadSha256 = electronicSalesDigest(scope, request);
  return { request, requestText: JSON.stringify(request), payloadSha256 };
}
