import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptErpSalesSnapshot } from '../src/erp-sales-adapter.ts';
import type { ErpSalesSnapshot } from '../src/erp-sales-adapter.ts';
import { prepareMappedEcfDraft } from '../src/mapper.ts';
import { XmllintDraftValidator } from '../src/xsd-validator.ts';
import { scope } from './fixtures.ts';

function snapshot(): ErpSalesSnapshot {
  return {
    id: 'synthetic-erp-invoice',
    revision: '1',
    tenantId: scope.tenantId,
    operationId: 'synthetic-operation',
    pricingProfile: 'ERP_NET_UNIT_PRICE_V1',
    status: 'DRAFT',
    fiscalStatus: 'NOT_APPLICABLE',
    ncf: null,
    eNcf: null,
    documentType: 'FISCAL_CREDIT_ELECTRONIC_31',
    issuedOn: '2026-09-20',
    incomeType: '01',
    paymentMode: 'CASH',
    dueOn: null,
    issuer: {
      rnc: scope.issuerRnc,
      legalName: 'RAZON SOCIAL EMISOR',
      address: 'Dirección sintética',
    },
    customer: { documentType: 'RNC', documentNumber: '101010641', name: 'RAZON SOCIAL COMPRADOR' },
    items: [
      {
        id: 'line-1',
        description: 'Producto sintético',
        kind: 'GOOD',
        quantity: '1',
        unitPrice: '100',
        discountTotal: '0',
        taxCategory: 'ITBIS_18',
        taxRate: '0.18',
        subtotal: '100',
        taxTotal: '18',
        total: '118',
      },
    ],
    subtotal: '100',
    discountTotal: '0',
    taxTotal: '18',
    total: '118',
  };
}

function discounted(): ErpSalesSnapshot {
  const input = snapshot();
  return {
    ...input,
    items: [
      {
        ...input.items[0],
        quantity: '2',
        unitPrice: '95',
        originalUnitPrice: '100',
        discountTotal: '10',
        subtotal: '190',
        taxTotal: '34.20',
        total: '224.20',
      },
    ],
    subtotal: '190',
    discountTotal: '10',
    taxTotal: '34.20',
    total: '224.20',
  };
}

async function draft(input: ErpSalesSnapshot) {
  const adapted = adaptErpSalesSnapshot(scope, input);
  return prepareMappedEcfDraft(
    scope,
    adapted.request,
    {
      scope,
      operationId: input.operationId,
      payloadSha256: adapted.payloadSha256,
      encf: `E${adapted.request.type}0000000001`,
      businessDate: input.issuedOn,
      validUntil: '2027-12-31',
    },
    '2026-09-20T10:00:00-04:00',
    new XmllintDraftValidator(),
  );
}

test('ERP E31/E32 sales projections map to real XSD without mutating their source', async () => {
  for (const type of ['FISCAL_CREDIT_ELECTRONIC_31', 'CONSUMER_ELECTRONIC_32'] as const) {
    const input = {
      ...snapshot(),
      documentType: type,
      customer: type === 'CONSUMER_ELECTRONIC_32' ? null : snapshot().customer,
    };
    const before = structuredClone(input);
    const result = await draft(input);
    assert.equal(result.sendable, false);
    assert.ok(result.xml.includes('<MontoTotal>118.00</MontoTotal>'));
    assert.deepEqual(input, before);
  }
});

test('net price plus original-price evidence maps the discount exactly once', async () => {
  const input = discounted();
  const adapted = adaptErpSalesSnapshot(scope, input);
  assert.equal(adapted.request.lines[0].unitPrice, '100.0000');
  assert.equal(adapted.request.lines[0].discount, '10.00');
  assert.equal(adapted.amounts.totals.net, '190.00');
  assert.equal(adapted.reconciliation.lineEvidence[0].netUnitPrice, '95.0000');
  assert.equal(adapted.reconciliation.policy, 'EXACT_NO_ADJUSTMENT');
  const xml = (await draft(input)).xml;
  assert.ok(xml.includes('<MontoItem>190.00</MontoItem>'));
  assert.ok(xml.includes('<MontoTotal>224.20</MontoTotal>'));
});

test('missing or inconsistent original-price evidence is rejected, not reconstructed', () => {
  const input = discounted();
  const { originalUnitPrice: _unused, ...line } = input.items[0];
  assert.throws(
    () => adaptErpSalesSnapshot(scope, { ...input, items: [line] }),
    /ORIGINAL_PRICE_EVIDENCE_REQUIRED/,
  );
  for (const originalUnitPrice of ['94', '99', '101']) {
    assert.throws(
      () => adaptErpSalesSnapshot(scope, { ...input, items: [{ ...line, originalUnitPrice }] }),
      /ERP_DISCOUNT_EVIDENCE_MISMATCH/,
    );
  }
});

test('per-line and aggregate rounding differences stop conversion without changing totals', () => {
  const input = snapshot();
  const changed: ErpSalesSnapshot = {
    ...input,
    items: ['a', 'b'].map((id) => ({
      ...input.items[0],
      id,
      unitPrice: '0.03',
      subtotal: '0.03',
      taxTotal: '0.01',
      total: '0.04',
    })),
    subtotal: '0.06',
    taxTotal: '0.02',
    total: '0.08',
  };
  const before = structuredClone(changed);
  assert.throws(() => adaptErpSalesSnapshot(scope, changed), /ERP_TAX_ROUNDING_MISMATCH/);
  assert.deepEqual(changed, before);
});

test('offsetting rounding differences between tax buckets are also rejected', () => {
  const input = snapshot();
  const changed: ErpSalesSnapshot = {
    ...input,
    items: [
      ...['a', 'b'].map((id) => ({
        ...input.items[0],
        id,
        unitPrice: '0.03',
        subtotal: '0.03',
        taxTotal: '0.01',
        total: '0.04',
      })),
      ...['c', 'd'].map((id) => ({
        ...input.items[0],
        id,
        unitPrice: '0.02',
        taxCategory: 'ITBIS_16' as const,
        taxRate: '0.16',
        subtotal: '0.02',
        taxTotal: '0.00',
        total: '0.02',
      })),
    ],
    subtotal: '0.10',
    taxTotal: '0.02',
    total: '0.12',
  };
  assert.throws(() => adaptErpSalesSnapshot(scope, changed), /ERP_TAX_ROUNDING_MISMATCH/);
});

test('line arithmetic, rates and all stored header totals must reconcile', () => {
  const input = snapshot();
  for (const [changes, code] of [
    [{ unitPrice: '99' }, 'ERP_NET_PRICE_MISMATCH'],
    [{ taxRate: '0.16' }, 'ERP_TAX_RATE_MISMATCH'],
    [{ taxTotal: '17' }, 'ERP_LINE_TAX_MISMATCH'],
    [{ total: '117' }, 'ERP_LINE_TOTAL_MISMATCH'],
  ] as const) {
    assert.throws(
      () => adaptErpSalesSnapshot(scope, { ...input, items: [{ ...input.items[0], ...changes }] }),
      new RegExp(code),
    );
  }
  for (const field of ['subtotal', 'discountTotal', 'taxTotal', 'total']) {
    assert.throws(
      () => adaptErpSalesSnapshot(scope, { ...input, [field]: '999' }),
      /ERP_HEADER_TOTAL_MISMATCH/,
    );
  }
});

test('different tenants, production, issued invoices and local NCF cannot be converted', () => {
  const input = snapshot();
  assert.throws(
    () => adaptErpSalesSnapshot({ ...scope, environment: 'production' }, input),
    /PRODUCTION_DISABLED/,
  );
  assert.throws(
    () => adaptErpSalesSnapshot(scope, { ...input, tenantId: 'other' }),
    /ERP_TENANT_MISMATCH/,
  );
  for (const change of [
    { status: 'PAID' },
    { fiscalStatus: 'LOCAL_ISSUED' },
    { ncf: 'B0100000001' },
    { eNcf: 'E310000000001' },
  ]) {
    assert.throws(
      () => adaptErpSalesSnapshot(scope, { ...input, ...change } as ErpSalesSnapshot),
      /ERP_ALREADY_ISSUED_OR_NOT_DRAFT/,
    );
  }
  assert.throws(
    () =>
      adaptErpSalesSnapshot(scope, {
        ...input,
        documentType: 'FISCAL_CREDIT_01',
      } as unknown as ErpSalesSnapshot),
    /UNSUPPORTED_ERP_DOCUMENT/,
  );
});

test('adapter rejects unsupported fields, numbers and unnormalized identities', () => {
  const input = snapshot();
  assert.throws(
    () => adaptErpSalesSnapshot(scope, { ...input, globalDiscount: '1' } as ErpSalesSnapshot),
    /UNSUPPORTED_ERP_FIELD/,
  );
  assert.throws(
    () =>
      adaptErpSalesSnapshot(scope, {
        ...input,
        items: [{ ...input.items[0], unitPrice: 100 }],
      } as unknown as ErpSalesSnapshot),
    /decimal string/,
  );
  assert.throws(
    () =>
      adaptErpSalesSnapshot(scope, {
        ...input,
        customer: { ...input.customer!, documentNumber: '1-01-01064-1' },
      }),
    /INVALID_ERP_DOCUMENT_FORMAT/,
  );
  assert.throws(
    () =>
      adaptErpSalesSnapshot(scope, {
        ...input,
        customer: { ...input.customer!, documentType: 'CEDULA' },
      }),
    /INVALID_ERP_DOCUMENT_FORMAT/,
  );
  assert.throws(
    () =>
      adaptErpSalesSnapshot(scope, {
        ...input,
        items: [input.items[0], input.items[0]],
        subtotal: '200',
        taxTotal: '36',
        total: '236',
      }),
    /DUPLICATE_LINE/,
  );
});

test('credit, exempt and 16 percent cases preserve stored amounts', async () => {
  for (const [taxCategory, taxRate, taxTotal, total] of [
    ['EXEMPT', '0', '0', '100'],
    ['ITBIS_16', '0.16', '16', '116'],
  ] as const) {
    const input: ErpSalesSnapshot = {
      ...snapshot(),
      paymentMode: 'CREDIT',
      dueOn: '2026-10-20',
      items: [{ ...snapshot().items[0], taxCategory, taxRate, taxTotal, total }],
      taxTotal,
      total,
    };
    assert.ok((await draft(input)).xml.includes('<FechaLimitePago>20-10-2026</FechaLimitePago>'));
  }
});

test('request, reconciliation evidence and source revision are detached and frozen', () => {
  const input = discounted();
  const result = adaptErpSalesSnapshot(scope, input);
  assert.ok(Object.isFrozen(result.reconciliation.lineEvidence[0]));
  assert.ok(Object.isFrozen(result.request.lines[0]));
  assert.notEqual(
    result.payloadSha256,
    adaptErpSalesSnapshot(scope, { ...input, revision: '2' }).payloadSha256,
  );
  assert.throws(
    () => adaptErpSalesSnapshot(scope, { ...input, issuer: { ...input.issuer, rnc: '101010641' } }),
    /ISSUER_SCOPE_MISMATCH/,
  );
});
