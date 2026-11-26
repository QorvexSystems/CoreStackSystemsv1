import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Prisma } from '@qorvex/database';
import {
  buildElectronicFiscalDispatch,
  projectPersistedElectronicSalesDraft,
} from '../src/modules/fiscal-documents/erp-sales-projection';
import { adaptErpSalesSnapshot } from '../../../packages/fiscal/src/erp-sales-adapter.ts';
import { parseFiscalRequest, serializeFiscalSnapshot } from '../../../packages/fiscal/src/contract.ts';

const scope = {
  tenantId: 'synthetic-rivnu',
  issuerRnc: '101010632',
  environment: 'certification' as const,
};
const context = {
  tenantId: scope.tenantId,
  operationId: 'op-1',
  issuedOn: '2026-09-20',
  incomeType: '01' as const,
};
const d = (value: string) => new Prisma.Decimal(value);
function draft() {
  return {
    id: 'draft-1',
    tenantId: scope.tenantId,
    updatedAt: new Date('2026-09-20T12:00:00Z'),
    documentType: 'CONSUMER_ELECTRONIC_32' as const,
    status: 'DRAFT' as const,
    fiscalStatus: 'NOT_APPLICABLE' as const,
    ncf: null,
    eNcf: null,
    issuedAt: null,
    paymentMode: 'CASH' as const,
    dueDate: null,
    fiscalIssuerSnapshot: {
      rnc: scope.issuerRnc,
      legalName: 'Synthetic issuer',
      address: 'Synthetic address',
    },
    fiscalCustomerSnapshot: null,
    subtotal: d('190'),
    discountTotal: d('10'),
    taxTotal: d('34.20'),
    total: d('224.20'),
    items: [
      {
        id: 'line-1',
        invoiceId: 'draft-1',
        productId: null,
        sku: null,
        barcode: null,
        description: 'Synthetic goods',
        quantity: d('2'),
        unit: 'UNIT' as const,
        originalUnitPrice: d('100'),
        unitPrice: d('95'),
        fiscalItemKind: 'GOOD' as const,
        discountTotal: d('10'),
        taxCategory: 'ITBIS_18' as const,
        taxRate: d('0.18'),
        taxTotal: d('34.20'),
        subtotal: d('190'),
        total: d('224.20'),
      },
    ],
  };
}
test('persisted Decimal draft projects directly into the fiscal adapter without numeric conversion', () => {
  const source = draft();
  const projection = projectPersistedElectronicSalesDraft(source, context);
  const result = adaptErpSalesSnapshot(scope, projection);
  assert.equal(result.request.lines[0].unitPrice, '100.0000');
  assert.equal(result.request.lines[0].discount, '10.00');
  assert.equal(result.request.expectedTotals.total, '224.20');
  assert.equal(source.items[0].unitPrice.toString(), '95');
});

test('E31 dispatch preserves a physical-person cédula as an 11-digit domestic buyer identifier', () => {
  const source = {
    ...draft(),
    documentType: 'FISCAL_CREDIT_ELECTRONIC_31' as const,
    fiscalCustomerSnapshot: { id: null, name: 'Persona física de prueba', documentType: 'CEDULA', documentNumber: '00113918205' },
  };
  const result = buildElectronicFiscalDispatch(source, { ...context, issuerRnc: scope.issuerRnc });
  assert.equal(result.request.type, 31);
  assert.equal(result.request.buyer?.kind, 'DOMESTIC');
  assert.equal(result.request.buyer?.identifier, '00113918205');
});

for (const documentType of ['FISCAL_CREDIT_ELECTRONIC_31', 'CONSUMER_ELECTRONIC_32'] as const) {
  test(`${documentType}: text normalization and payload digest match the isolated core`, () => {
    const source = {
      ...draft(),
      documentType,
      fiscalIssuerSnapshot: { rnc: scope.issuerRnc, legalName: '  Synthetic issuer\t', address: '\u00a0Synthetic address  ' },
      fiscalCustomerSnapshot: { id: null, name: ' Buyer  with internal spaces\n', documentType: 'RNC', documentNumber: '101010632' },
    };
    source.items[0]!.description = '\t Synthetic  goods \r\n';
    const original = source.items[0]!.description;
    const result = buildElectronicFiscalDispatch(source, { ...context, issuerRnc: scope.issuerRnc });
    assert.deepEqual(result.request, parseFiscalRequest(result.request));
    assert.equal(result.request.lines[0]!.description, 'Synthetic  goods');
    assert.equal(source.items[0]!.description, original, 'historical ERP evidence is not edited');
    // Use the real core serializer in a synthetic certification scope; only
    // the digest's scope changes to the production value built by the ERP.
    const canonicalCore = serializeFiscalSnapshot(scope, result.request)
      .replace('"environment":"certification"', '"environment":"production"');
    assert.equal(result.payloadSha256, createHash('sha256').update(canonicalCore).digest('hex'));
    const repeated = buildElectronicFiscalDispatch(source, { ...context, issuerRnc: scope.issuerRnc });
    assert.equal(repeated.requestText, result.requestText);
    assert.equal(repeated.payloadSha256, result.payloadSha256);
  });
}
test('projection does not promote issued/local documents, another tenant, or malformed snapshots to electronic drafts', () => {
  for (const change of [
    { tenantId: 'another' },
    { status: 'PAID' },
    { fiscalStatus: 'LOCAL_ISSUED' },
    { documentType: 'CONSUMER_02' },
    { ncf: 'B0200000001' },
    { eNcf: 'E320000000001' },
    { issuedAt: new Date() },
    { fiscalIssuerSnapshot: null },
    { fiscalCustomerSnapshot: {} },
    { dueDate: new Date() },
  ]) {
    assert.throws(() =>
      projectPersistedElectronicSalesDraft({ ...draft(), ...change } as never, context),
    );
  }
});
test('missing historical classification/discount evidence and foreign line ownership fail closed', () => {
  for (const change of [{ fiscalItemKind: null }, { invoiceId: 'different-document' }]) {
    const source = draft();
    assert.throws(() =>
      projectPersistedElectronicSalesDraft(
        { ...source, items: [{ ...source.items[0], ...change }] } as never,
        context,
      ),
    );
  }
  const source = draft();
  const projection = projectPersistedElectronicSalesDraft(
    { ...source, items: [{ ...source.items[0], originalUnitPrice: null }] },
    context,
  );
  assert.throws(() => adaptErpSalesSnapshot(scope, projection), /ORIGINAL_PRICE_EVIDENCE_REQUIRED/);
});

test('dispatch rejects an ERP draft whose line-rounded ITBIS differs from DGII aggregate tax', () => {
  const source = draft();
  source.subtotal = d('0.06');
  source.taxTotal = d('0.02');
  source.total = d('0.08');
  source.items = [1, 2].map((index) => ({
    ...source.items[0]!,
    id: `line-${index}`,
    quantity: d('1'),
    originalUnitPrice: d('0.03'),
    unitPrice: d('0.03'),
    discountTotal: d('0'),
    subtotal: d('0.03'),
    taxTotal: d('0.01'),
    total: d('0.04'),
  }));

  assert.throws(
    () =>
      buildElectronicFiscalDispatch(source, {
        ...context,
        issuerRnc: scope.issuerRnc,
      }),
    /totales de la venta no coinciden/i,
  );
});
