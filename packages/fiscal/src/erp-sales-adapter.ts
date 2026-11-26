import type { FiscalScope } from './catalog.ts';
import { assertScope } from './catalog.ts';
import { deepFreeze, FiscalContractError, requireFiscal } from './contract.ts';
import type { FiscalRequestV1 } from './contract.ts';
import { fixedDecimal, roundRatio, scaledDecimal } from './decimal.ts';
import { analyzeFiscalRequest } from './mapper.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

/** Explicit projection of a sales draft, NOT a raw Prisma object or public HTTP input.
 * Decimal fields must be serialized without Number(); kind/originalUnitPrice must
 * come from persisted evidence, never from today's mutable product catalogue.
 */
export type ErpSalesSnapshot = Readonly<{
  id: string;
  revision: string;
  tenantId: string;
  operationId: string;
  pricingProfile: 'ERP_NET_UNIT_PRICE_V1';
  status: 'DRAFT';
  fiscalStatus: 'NOT_APPLICABLE';
  ncf: null;
  eNcf: null;
  documentType: 'FISCAL_CREDIT_ELECTRONIC_31' | 'CONSUMER_ELECTRONIC_32';
  issuedOn: string;
  incomeType: FiscalRequestV1['incomeType'];
  paymentMode: 'CASH' | 'CREDIT';
  dueOn: string | null;
  issuer: Readonly<{ rnc: string; legalName: string; address: string }>;
  customer: Readonly<{
    documentType: 'RNC' | 'CEDULA' | 'PASSPORT';
    documentNumber: string;
    name: string;
  }> | null;
  items: readonly Readonly<{
    id: string;
    description: string;
    kind: 'GOOD' | 'SERVICE';
    quantity: string;
    unitPrice: string;
    originalUnitPrice?: string;
    discountTotal: string;
    taxCategory: 'ITBIS_18' | 'ITBIS_16' | 'EXEMPT';
    taxRate: string;
    subtotal: string;
    taxTotal: string;
    total: string;
  }>[];
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
}>;

function exactObject(value: unknown, keys: string[], field: string): void {
  requireFiscal(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    'INVALID_ERP_SNAPSHOT',
    field,
  );
  requireFiscal(
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === 'string' &&
        keys.includes(key) &&
        'value' in Object.getOwnPropertyDescriptor(value, key)!,
    ),
    'UNSUPPORTED_ERP_FIELD',
    field,
  );
}

const cents = (value: string) => scaledDecimal(value, 2);
const money = (value: bigint) => fixedDecimal(value, 2);

/** Read-only reconciliation. Does not reserve, reprice, persist, sign or send. */
export function adaptErpSalesSnapshot(scope: FiscalScope, snapshot: ErpSalesSnapshot) {
  assertScope(scope);
  try {
    assertFiscalEnvironmentEnabled(scope);
  } catch {
    throw new FiscalContractError('PRODUCTION_DISABLED', 'scope.environment');
  }
  exactObject(
    snapshot,
    [
      'id',
      'revision',
      'tenantId',
      'operationId',
      'pricingProfile',
      'status',
      'fiscalStatus',
      'ncf',
      'eNcf',
      'documentType',
      'issuedOn',
      'incomeType',
      'paymentMode',
      'dueOn',
      'issuer',
      'customer',
      'items',
      'subtotal',
      'discountTotal',
      'taxTotal',
      'total',
    ],
    'snapshot',
  );
  requireFiscal(snapshot.tenantId === scope.tenantId, 'ERP_TENANT_MISMATCH', 'tenantId');
  requireFiscal(
    snapshot.pricingProfile === 'ERP_NET_UNIT_PRICE_V1',
    'UNSUPPORTED_PRICING_PROFILE',
    'pricingProfile',
  );
  requireFiscal(
    snapshot.status === 'DRAFT' &&
      snapshot.fiscalStatus === 'NOT_APPLICABLE' &&
      snapshot.ncf === null &&
      snapshot.eNcf === null,
    'ERP_ALREADY_ISSUED_OR_NOT_DRAFT',
    'status',
  );
  requireFiscal(
    ['FISCAL_CREDIT_ELECTRONIC_31', 'CONSUMER_ELECTRONIC_32'].includes(snapshot.documentType),
    'UNSUPPORTED_ERP_DOCUMENT',
    'documentType',
  );
  requireFiscal(
    ['CASH', 'CREDIT'].includes(snapshot.paymentMode),
    'UNSUPPORTED_ERP_PAYMENT',
    'paymentMode',
  );
  requireFiscal(
    snapshot.paymentMode === 'CREDIT' || snapshot.dueOn === null,
    'CASH_DUE_DATE_NOT_APPLICABLE',
    'dueOn',
  );
  exactObject(snapshot.issuer, ['rnc', 'legalName', 'address'], 'issuer');
  if (snapshot.customer !== null) {
    exactObject(snapshot.customer, ['documentType', 'documentNumber', 'name'], 'customer');
    requireFiscal(
      ['RNC', 'CEDULA', 'PASSPORT'].includes(snapshot.customer.documentType),
      'UNSUPPORTED_ERP_IDENTITY',
      'customer.documentType',
    );
    if (snapshot.customer.documentType !== 'PASSPORT') {
      requireFiscal(
        typeof snapshot.customer.documentNumber === 'string' &&
          (snapshot.customer.documentType === 'RNC' ? /^\d{9}$/ : /^\d{11}$/).test(
            snapshot.customer.documentNumber,
          ),
        'INVALID_ERP_DOCUMENT_FORMAT',
        'customer.documentNumber',
      );
    }
  }
  requireFiscal(
    Array.isArray(snapshot.items) && snapshot.items.length > 0 && snapshot.items.length <= 1000,
    'INVALID_LINE_COUNT',
    'items',
  );
  let net = 0n,
    discount = 0n,
    tax = 0n,
    total = 0n;
  const bases = [0n, 0n, 0n];
  const lineTaxes = [0n, 0n, 0n];
  const rates = [18n, 16n, 0n];
  const evidence: {
    sourceLineId: string;
    originalUnitPrice: string | null;
    netUnitPrice: string;
    discount: string;
  }[] = [];
  const lines = Array.from(snapshot.items, (item, index) => {
    const field = `items[${index}]`;
    exactObject(
      item,
      [
        'id',
        'description',
        'kind',
        'quantity',
        'unitPrice',
        'originalUnitPrice',
        'discountTotal',
        'taxCategory',
        'taxRate',
        'subtotal',
        'taxTotal',
        'total',
      ],
      field,
    );
    const bucket = ['ITBIS_18', 'ITBIS_16', 'EXEMPT'].indexOf(item.taxCategory);
    requireFiscal(bucket !== -1, 'UNSUPPORTED_ERP_TAX_CATEGORY', `${field}.taxCategory`);
    requireFiscal(
      scaledDecimal(item.taxRate, 4) === rates[bucket] * 100n,
      'ERP_TAX_RATE_MISMATCH',
      `${field}.taxRate`,
    );
    const quantity = scaledDecimal(item.quantity, 2);
    const price = scaledDecimal(item.unitPrice, 4);
    const lineNet = cents(item.subtotal);
    const lineDiscount = cents(item.discountTotal);
    const lineTax = cents(item.taxTotal);
    const lineTotal = cents(item.total);
    requireFiscal(quantity > 0n, 'NONPOSITIVE_QUANTITY', `${field}.quantity`);
    requireFiscal(
      roundRatio(quantity * price, 10_000n) === lineNet,
      'ERP_NET_PRICE_MISMATCH',
      `${field}.subtotal`,
    );
    requireFiscal(
      roundRatio(lineNet * rates[bucket], 100n) === lineTax,
      'ERP_LINE_TAX_MISMATCH',
      `${field}.taxTotal`,
    );
    requireFiscal(lineNet + lineTax === lineTotal, 'ERP_LINE_TOTAL_MISMATCH', `${field}.total`);
    // Never derive a supposed original price by dividing (subtotal + discount) by
    // quantity: the ERP has already rounded both prices and line amounts.
    requireFiscal(
      lineDiscount === 0n || item.originalUnitPrice !== undefined,
      'ORIGINAL_PRICE_EVIDENCE_REQUIRED',
      `${field}.originalUnitPrice`,
    );
    const original =
      item.originalUnitPrice === undefined ? price : scaledDecimal(item.originalUnitPrice, 4);
    requireFiscal(
      original >= price &&
        quantity * original >= lineDiscount * 10_000n &&
        roundRatio(quantity * original - lineDiscount * 10_000n, 10_000n) === lineNet,
      'ERP_DISCOUNT_EVIDENCE_MISMATCH',
      field,
    );
    net += lineNet;
    discount += lineDiscount;
    tax += lineTax;
    total += lineTotal;
    bases[bucket] += lineNet;
    lineTaxes[bucket] += lineTax;
    evidence.push({
      sourceLineId: item.id,
      originalUnitPrice: item.originalUnitPrice === undefined ? null : fixedDecimal(original, 4),
      netUnitPrice: fixedDecimal(price, 4),
      discount: money(lineDiscount),
    });
    return {
      sourceLineId: item.id,
      description: item.description,
      kind: item.kind,
      quantity: fixedDecimal(quantity, 2),
      unitPrice: fixedDecimal(original, 4),
      discount: money(lineDiscount),
      billingIndicator: ([1, 2, 4] as const)[bucket],
    };
  });
  for (const [key, amount] of Object.entries({
    subtotal: net,
    discountTotal: discount,
    taxTotal: tax,
    total,
  })) {
    requireFiscal(
      cents(snapshot[key as 'subtotal' | 'discountTotal' | 'taxTotal' | 'total']) === amount,
      'ERP_HEADER_TOTAL_MISMATCH',
      key,
    );
  }
  requireFiscal(
    bases.every((base, index) => roundRatio(base * rates[index], 100n) === lineTaxes[index]),
    'ERP_TAX_ROUNDING_MISMATCH',
    'taxTotal',
  );
  const request = {
    version: '1',
    operationId: snapshot.operationId,
    source: { documentId: snapshot.id, revision: snapshot.revision },
    type: snapshot.documentType === 'FISCAL_CREDIT_ELECTRONIC_31' ? 31 : 32,
    issuedOn: snapshot.issuedOn,
    currency: 'DOP',
    pricesIncludeTax: false,
    issuer: {
      rnc: snapshot.issuer.rnc,
      fiscalName: snapshot.issuer.legalName,
      address: snapshot.issuer.address,
    },
    ...(snapshot.customer
      ? {
          buyer: {
            kind: snapshot.customer.documentType === 'PASSPORT' ? 'FOREIGN' : 'DOMESTIC',
            identifier: snapshot.customer.documentNumber,
            fiscalName: snapshot.customer.name,
          },
        }
      : {}),
    incomeType: snapshot.incomeType,
    payment: {
      type: snapshot.paymentMode === 'CASH' ? 1 : 2,
      ...(snapshot.paymentMode === 'CREDIT' ? { dueOn: snapshot.dueOn } : {}),
    },
    lines,
    expectedTotals: {
      net: money(net),
      itbis: money(tax),
      total: money(total),
      itbisWithheld: '0.00',
      isrWithheld: '0.00',
    },
  };
  const analysis = analyzeFiscalRequest(scope, request);
  return deepFreeze({
    ...analysis,
    adapterProfile: 'ERP_NET_UNIT_PRICE_V1' as const,
    reconciliation: {
      originalDiscountTotal: money(discount),
      lineEvidence: evidence,
      policy: 'EXACT_NO_ADJUSTMENT' as const,
    },
  });
}
