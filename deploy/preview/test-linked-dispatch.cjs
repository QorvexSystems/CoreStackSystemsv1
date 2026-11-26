// Run via stdin inside the isolated preview API, after test-order-flow.cjs.
// No credentials are printed. Fault injection occurs before any remote call.
const assert = require('node:assert/strict');
require('/app/apps/api/node_modules/reflect-metadata');
const { PrismaClient } = require('/app/apps/api/node_modules/@qorvex/database');
const { PosService } = require('/app/apps/api/dist/modules/pos/pos.service');
const { assertSyntheticPreview } = require('/app/apps/api/dist/modules/fiscal-documents/preview-preparation');
assertSyntheticPreview();
assert.equal(process.env.RIVNU_PREVIEW_REMOTE_FISCAL, 'true');
const db = new PrismaClient();
const tenant = 'cmt397emm0002nm0ogb50l2q6';
let phase = 'linked-evidence';
async function main() {
  const linked = await db.$queryRawUnsafe(`
    SELECT p.order_id, p.snapshot->>'id' AS invoice_id, d.state, d.document_id,
      d.encf, d.payload_sha256, p.remote_ack, p.state AS preparation_state
    FROM corestack_preview_ecf.preparation p
    JOIN corestack_erp_fiscal.dispatch d ON d.invoice_id=p.snapshot->>'id'
      AND d.tenant_id=p.tenant_id AND d.operation_id=p.snapshot->>'operationId'
    WHERE p.tenant_id=$1 ORDER BY p.id DESC LIMIT 1`, tenant);
  assert.equal(linked.length, 1);
  const link = linked[0];
  assert.equal(link.state, 'REGISTERED');
  assert.equal(link.preparation_state, 'DONE');
  assert.equal(link.document_id, link.remote_ack.documentId);
  assert.equal(link.encf, link.remote_ack.encf);
  assert.equal(link.payload_sha256, link.remote_ack.payloadSha256);
  const invoice = await db.invoice.findUniqueOrThrow({ where: { id: link.invoice_id },
    include: { payments: true, inventoryMovements: true, cashMovements: true } });
  assert.equal(invoice.status, 'DRAFT');
  assert.equal(invoice.fiscalStatus, 'NOT_APPLICABLE');
  for (const key of ['ncf', 'eNcf', 'issuedAt']) assert.equal(invoice[key], null);
  for (const key of ['paidAmount', 'amountReceived', 'balance']) assert.equal(invoice[key].toString(), '0');
  for (const key of ['payments', 'inventoryMovements', 'cashMovements']) assert.equal(invoice[key].length, 0);
  const counts = await db.$queryRawUnsafe(`SELECT count(*)::int AS count
    FROM corestack_preview_ecf.preparation WHERE tenant_id=$1 AND order_id=$2`, tenant, link.order_id);
  assert.equal(counts[0].count, 1, 'Concurrent HTTP retries must produce one preparation');
  const template = await db.salesOrder.findUniqueOrThrow({ where: { id: link.order_id }, include: { items: true } });
  assert.equal(await db.invoice.count({ where: { tenantId: tenant,
    invoiceNumber: { startsWith: `SYNTHETIC-${template.id}-` } } }), 1);

  // Keep an explicitly labelled test order; failed creation must leave no invoice/outbox.
  const order = await db.salesOrder.create({ data: {
    tenantId: tenant, orderNumber: `ROLLBACK-ONLY-${Date.now()}`,
    clientName: 'PRUEBA DE ROLLBACK SIN VALIDEZ', createdById: template.createdById,
    status: 'IN_CASHIER', fiscalDocumentTypeSnapshot: 'CONSUMER_ELECTRONIC_32',
    claimedById: template.claimedById, claimedCashSessionId: template.claimedCashSessionId,
    claimExpiresAt: new Date(Date.now() + 60000),
    subtotal: template.subtotal, taxTotal: template.taxTotal,
    discountTotal: template.discountTotal, total: template.total,
    items: { create: template.items.map(({ id, salesOrderId, ...item }) => item) },
  } });
  phase = 'rollback-injection';
  const injected = new Error('EXPECTED_OUTBOX_FAILURE');
  let sawInvoice = false;
  const instrumented = new Proxy(db, { get(target, key) {
    if (key !== '$transaction') return Reflect.get(target, key);
    return (callback, options) => db.$transaction(tx => callback(new Proxy(tx, {
      get(targetTx, txKey) {
        if (txKey !== '$queryRawUnsafe') return Reflect.get(targetTx, txKey);
        return async (sql, ...values) => {
          if (sql.includes('INSERT INTO corestack_erp_fiscal.dispatch')) {
            sawInvoice = await tx.invoice.count({ where: { tenantId: tenant,
              invoiceNumber: { startsWith: `SYNTHETIC-${order.id}-` } } }) === 1;
            throw injected;
          }
          return tx.$queryRawUnsafe(sql, ...values);
        };
      },
    })), options);
  } });
  const service = new PosService(instrumented, {}, {});
  await assert.rejects(service.prepareSyntheticOrder(tenant, {
    id: template.claimedById,
    memberships: [{ tenantId: tenant, role: 'CASHIER', canUsePos: true }],
  }, order.id), error => error === injected);
  assert.equal(sawInvoice, true, 'Failure must occur after draft creation');
  phase = 'rollback-verification';
  assert.equal(await db.invoice.count({ where: { tenantId: tenant,
    invoiceNumber: { startsWith: `SYNTHETIC-${order.id}-` } } }), 0);
  const remaining = await db.$queryRawUnsafe(`SELECT count(*)::int AS count
    FROM corestack_preview_ecf.preparation WHERE tenant_id=$1 AND order_id=$2`, tenant, order.id);
  assert.equal(remaining[0].count, 0);
  const jobs = await db.$queryRawUnsafe(`SELECT count(*)::int AS count
    FROM corestack_erp_fiscal.dispatch WHERE tenant_id=$1 AND operation_id=$2`,
    tenant, `synthetic-${order.id}-${order.updatedAt.toISOString()}`);
  assert.equal(jobs[0].count, 0);
  console.log(JSON.stringify({ result: 'PASS', invoiceId: invoice.id,
    orderId: template.id, outbox: 'REGISTERED', duplicateDrafts: false,
    rollback: 'NO_ORPHAN_DRAFT_OR_PREPARATION', payments: 0, stockMovements: 0 }));
}
main().catch(() => { console.error(`LINKED_DISPATCH_TEST_FAILED:${phase}`); process.exitCode = 1; })
  .finally(() => db.$disconnect());
