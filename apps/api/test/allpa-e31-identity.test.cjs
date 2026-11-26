const assert = require('node:assert/strict');
const test = require('node:test');
const { Prisma } = require('@qorvex/database');
const { DgiiRegistryService } = require('../dist/modules/dgii-registry/dgii-registry.service');
const { PosService } = require('../dist/modules/pos/pos.service');
const { buildEcfSimulation } = require('../dist/modules/pos/ecf-simulation');
const fixtures = [ ['RNC', '101850043', '1-01-85004-3'], ['CEDULA', '00113918205', '001-1391820-5'] ];

function registryHarness(options = {}) {
  const queries = [];
  const dataset = options.missing ? null : {
    sourceUpdatedAt: options.stale ? new Date('2000-01-01') : new Date(),
    records: options.notFound ? [] : [{ fiscalName: 'Contribuyente de prueba', registryStatus: options.inactive ? 'SUSPENDIDO' : 'ACTIVO', status: options.inactive ? 'SUSPENDED' : 'ACTIVE' }],
  };
  const db = { dgiiRegistryDataset: { findFirst: async args => { queries.push(args); return dataset; } } };
  const service = new DgiiRegistryService(db, { get: () => '216' });
  return { service, db, queries };
}

for (const [documentType, number, formatted] of fixtures) {
  test(`official registry matches the selected ${documentType} and preserves leading zeroes`, async () => {
    const { service, queries } = registryHarness();
    const result = await service.lookupIdentity(documentType, formatted);
    assert.equal(result.documentType, documentType);
    assert.equal(result.documentNumber, number);
    assert.equal(result.outcome, 'VERIFIED');
    assert.deepEqual(queries[0].select.records.where, { documentType, documentNumber: number });
  });
  for (const [option, expected] of [['missing', 'UNAVAILABLE'], ['stale', 'REGISTRY_STALE'], ['notFound', 'NOT_FOUND'], ['inactive', 'NON_ACTIVE']]) {
    test(`E31 blocks ${documentType} when registry is ${expected}`, async () => {
      const { service, db } = registryHarness({ [option]: true });
      assert.equal((await service.lookupIdentity(documentType, number)).outcome, expected);
      await assert.rejects(() => service.requireActiveIdentity(documentType, number, db));
    });
  }
}

for (const [type, number] of [['PASSPORT', '00113918205'], ['RNC', '00113918205'], ['CEDULA', '101850043'], ['CEDULA', '00113918200']]) {
  test(`invalid or mislabelled document fails before querying the registry: ${type}/${number}`, async () => {
    const { service, queries } = registryHarness();
    await assert.rejects(() => service.lookupIdentity(type, number));
    assert.equal(queries.length, 0);
  });
}

test('legacy RNC lookup still defaults to 9-digit RNC', async () => {
  const { service, db } = registryHarness();
  assert.equal((await service.lookupRnc('101850043')).documentType, 'RNC');
  assert.equal((await service.requireActiveRnc('101850043', db)).documentType, 'RNC');
});

function checkoutHarness(documentType, number, options = {}) {
  const registry = registryHarness(options);
  const writes = [], boundary = new Error('SYNTHETIC_STOP_BEFORE_NUMBERING');
  const linked = options.mismatch ? { id: 'linked', documentType: 'RNC', documentNumber: '101850043', status: 'ACTIVE' } : null;
  const tx = { ...registry.db,
    tenant: { findUniqueOrThrow: async () => ({ slug: 'allpa' }) },
    customer: {
      findFirst: async ({ where }) => where.id ? linked : null,
      findUnique: async ({ where }) => { assert.equal(where.tenantId_documentType_documentNumber.documentType, documentType); return null; },
      create: async ({ data }) => { writes.push(data); return { id: 'fiscal-customer', status: 'ACTIVE', ...data }; },
    },
  };
  const pos = new PosService({}, registry.service);
  pos.ensureCanUsePos = async () => ({ role: 'CASHIER' });
  pos.runSerializable = async fn => fn(tx);
  pos.findCashSessionForSale = async () => ({ id: 'cash' });
  pos.claimOrderForSale = async () => ({ total: new Prisma.Decimal(118), paymentMode: 'CASH', customerId: linked?.id, discountApproval: null });
  pos.computeSaleFromOrder = async () => ({ items: [{}], total: new Prisma.Decimal(118) });
  pos.lockOpenCashSession = async () => { throw boundary; };
  pos.reserveFiscalSequence = () => { throw new Error('Must never reserve a real number in this test'); };
  const dto = { orderId: 'order', cashSessionId: 'cash', documentType: 'FISCAL_CREDIT_ELECTRONIC_31',
    fiscalDocumentType: documentType, fiscalDocumentNumber: number, paymentMethod: 'CASH', amountReceived: 118 };
  return { pos, dto, writes, boundary, queries: registry.queries };
}

for (const [documentType, number, formatted] of fixtures) {
  test(`E31 checkout accepts verified ${documentType}, stores the selected type and reaches numbering boundary`, async () => {
    const h = checkoutHarness(documentType, formatted);
    await assert.rejects(() => h.pos.completeSale('tenant', {}, h.dto), error => error === h.boundary);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].documentType, documentType);
    assert.equal(h.writes[0].documentNumber, number);
    assert.equal(h.writes[0].name, 'Contribuyente de prueba');
  });
}

test('verified cédula cannot replace the debtor assigned to an order', async () => {
  const h = checkoutHarness('CEDULA', '00113918205', { mismatch: true });
  await assert.rejects(() => h.pos.completeSale('tenant', {}, h.dto), /no corresponde/);
  assert.equal(h.writes.length, 0);
});

test('unregistered cédula cannot create a customer, payment or sequence', async () => {
  const h = checkoutHarness('CEDULA', '00113918205', { notFound: true });
  await assert.rejects(() => h.pos.completeSale('tenant', {}, h.dto), /no figura activo/);
  assert.equal(h.writes.length, 0);
});

test('ALLPA XML puts the full 11-digit cédula in RNCComprador', () => {
  const d = value => new Prisma.Decimal(value);
  const result = buildEcfSimulation({
    documentType: 'FISCAL_CREDIT_ELECTRONIC_31', eNcf: 'E310000000001', invoiceNumber: 'TEST-ONLY',
    issuedAt: new Date('2026-11-12T12:00:00Z'), paymentMethod: 'CASH', paymentMode: 'CASH',
    tenant: { name: 'Prueba', rnc: '101010632', legalName: 'Prueba', commercialName: 'Prueba', address: 'Prueba', email: null, phone: null },
    customer: { name: 'Persona física de prueba', documentNumber: '00113918205', email: null },
    subtotal: d(100), taxTotal: d(18), total: d(118), items: [{ sku: null, barcode: null,
      description: 'Prueba', quantity: d(1), unitPrice: d(100), isService: false,
      taxCategory: 'ITBIS_18', taxRate: d('0.18'), subtotal: d(100), taxTotal: d(18), total: d(118) }],
  });
  assert.ok(JSON.stringify(result).includes('<RNCComprador>00113918205</RNCComprador>'));
});
