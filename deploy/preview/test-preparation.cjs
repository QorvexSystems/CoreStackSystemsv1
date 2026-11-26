const assert = require('node:assert/strict');
const { assertSyntheticPreview, prepareSyntheticSnapshot } = require('/app/apps/api/dist/modules/fiscal-documents/preview-preparation.js');

async function main() {
  const saved = { ...process.env };
  process.env.NODE_ENV = 'development';
  process.env.RIVNU_PREVIEW_GUARD = 'RIVNU_DGII_PREVIEW_ONLY';
  const url = 'postgresql://rivnu_preview:synthetic@rivnu-dgii-preview-db:5432/rivnu_dgii_preview';
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  assertSyntheticPreview();
  for (const [key, value] of [
    ['NODE_ENV', 'production'], ['RIVNU_PREVIEW_GUARD', ''],
    ['DATABASE_URL', url.replace('rivnu-dgii-preview-db', '10.0.0.4')],
    ['DIRECT_URL', url.replace('/rivnu_dgii_preview', '/rivnu_production')],
  ]) {
    const previous = process.env[key];
    process.env[key] = value;
    assert.throws(assertSyntheticPreview);
    process.env[key] = previous;
  }
  const snapshot = {
    id: 'synthetic-order', revision: '1', tenantId: 'synthetic-tenant',
    operationId: 'synthetic-operation', pricingProfile: 'ERP_NET_UNIT_PRICE_V1',
    status: 'DRAFT', fiscalStatus: 'NOT_APPLICABLE', ncf: null, eNcf: null,
    documentType: 'CONSUMER_ELECTRONIC_32', issuedOn: '2026-09-22',
    incomeType: '01', paymentMode: 'CASH', dueOn: null,
    issuer: { rnc: '101010641', legalName: 'PRUEBA SIN VALIDEZ', address: 'Direccion sintetica' },
    customer: null,
    items: [{ id: 'line-1', description: 'Producto sintetico', kind: 'GOOD',
      quantity: '1', unitPrice: '100', originalUnitPrice: '100', discountTotal: '0',
      taxCategory: 'ITBIS_18', taxRate: '0.18', subtotal: '100', taxTotal: '18', total: '118' }],
    subtotal: '100', discountTotal: '0', taxTotal: '18', total: '118',
  };
  const writes = [];
  const db = { $executeRawUnsafe: async (...args) => { writes.push(args); return 1; } };
  const row = { id: '1', snapshot, revision: '1', state: 'PENDING', result: null,
    error_code: null, planned_at: '2026-09-22T10:00:00-04:00' };
  const result = await prepareSyntheticSnapshot(db, row, snapshot.tenantId);
  assert.equal(result.state, 'DONE', JSON.stringify(result));
  assert.equal(result.result.sendable, false);
  assert.equal(result.result.signed, false);
  assert.match(result.result.xml, /<MontoTotal>118.00<\/MontoTotal>/);
  assert.match(result.result.xml, /E320000000001/);
  assert.equal(writes.length, 1);
  await prepareSyntheticSnapshot(db, { ...row, state: 'DONE', result: result.result }, snapshot.tenantId);
  assert.equal(writes.length, 1, 'terminal preparation must not be rewritten');
  const failed = await prepareSyntheticSnapshot(db, {
    ...row, snapshot: { ...snapshot, total: '119' },
  }, snapshot.tenantId);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.sendable, false);
  process.env = saved;
  console.log('PASS: preview guards, real E32 unsigned XSD, terminal idempotency, mismatched totals rejected');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
