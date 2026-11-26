'use strict';

const fs = require('node:fs');
const { PrismaClient } = require('/app/packages/database/generated/client');

const prisma = new PrismaClient();
const targetInvoiceNumber = 'RIV-0000000001';
const targetOrderNumber = 'ORD-20261102-142539-Z7C';
const targetProductId = 'cmv01390r02y8qf0798r02cff';
const backupPath = '/tmp/rivnu-test-local-sale-20261102.json';

function serialize(value) {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item), 2);
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

async function readState(client) {
  const invoice = await client.invoice.findFirst({
    where: { invoiceNumber: targetInvoiceNumber },
    include: {
      items: true,
      payments: true,
      inventoryMovements: true,
      cashMovements: true,
      employeeActivityLogs: true,
      salesOrder: { include: { items: true, creditApproval: true } },
      electronicDocument: true,
      returnRequests: { include: { items: true } },
    },
  });
  if (!invoice) return { invoice: null };

  const [sequence, product, auditLogs, localInvoiceCount, cashSession] = await Promise.all([
    client.localSaleSequence.findUnique({ where: { tenantId: invoice.tenantId } }),
    client.product.findUnique({ where: { id: targetProductId } }),
    client.auditLog.findMany({
      where: {
        OR: [
          { entityId: invoice.id },
          ...(invoice.salesOrder ? [{ entityId: invoice.salesOrder.id }] : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
    }),
    client.invoice.count({
      where: { tenantId: invoice.tenantId, documentType: 'LOCAL_SALE_NOTE' },
    }),
    invoice.cashSessionId
      ? client.cashSession.findUnique({ where: { id: invoice.cashSessionId } })
      : null,
  ]);

  return { invoice, sequence, product, auditLogs, localInvoiceCount, cashSession };
}

function verifyTarget(state) {
  const { invoice, sequence, product, localInvoiceCount, cashSession } = state;
  assert(invoice, 'TARGET_INVOICE_NOT_FOUND');
  assert(invoice.invoiceNumber === targetInvoiceNumber, 'TARGET_INVOICE_NUMBER_MISMATCH');
  assert(invoice.documentType === 'LOCAL_SALE_NOTE', 'TARGET_NOT_LOCAL_SALE_NOTE');
  assert(invoice.status === 'PAID' && invoice.fiscalStatus === 'NOT_APPLICABLE', 'TARGET_STATUS_MISMATCH');
  assert(invoice.ncf === null && invoice.eNcf === null, 'TARGET_HAS_FISCAL_NUMBER');
  assert(invoice.total.toString() === '9.98' && invoice.paidAmount.toString() === '9.98', 'TARGET_TOTAL_MISMATCH');
  assert(invoice.electronicDocument === null, 'TARGET_HAS_ELECTRONIC_DOCUMENT');
  assert(invoice.returnRequests.length === 0, 'TARGET_HAS_RETURN_REQUEST');
  assert(invoice.salesOrder?.orderNumber === targetOrderNumber, 'TARGET_ORDER_MISMATCH');
  assert(invoice.salesOrder.status === 'COMPLETED', 'TARGET_ORDER_STATUS_MISMATCH');
  assert(invoice.salesOrder.creditApproval === null, 'TARGET_HAS_CREDIT_APPROVAL');
  assert(invoice.items.length === 1 && invoice.items[0].productId === targetProductId, 'TARGET_ITEM_MISMATCH');
  assert(invoice.items[0].quantity.toString() === '2', 'TARGET_QUANTITY_MISMATCH');
  assert(invoice.payments.length === 1 && invoice.payments[0].amount.toString() === '9.98', 'TARGET_PAYMENT_MISMATCH');
  assert(invoice.cashMovements.length === 1 && invoice.cashMovements[0].amount.toString() === '9.98', 'TARGET_CASH_MISMATCH');
  assert(invoice.inventoryMovements.length === 1, 'TARGET_INVENTORY_MOVEMENT_COUNT_MISMATCH');
  assert(invoice.inventoryMovements[0].type === 'SALE' && invoice.inventoryMovements[0].quantity === 2, 'TARGET_INVENTORY_MOVEMENT_MISMATCH');
  assert(invoice.inventoryMovements[0].previousStock === 47 && invoice.inventoryMovements[0].newStock === 45, 'TARGET_STOCK_HISTORY_MISMATCH');
  assert(product?.id === targetProductId && product.stock === 45 && product.reservedStock === 0, 'CURRENT_PRODUCT_STOCK_MISMATCH');
  assert(sequence?.nextNumber === 2n && localInvoiceCount === 1, 'LOCAL_SEQUENCE_NOT_EXCLUSIVE');
  assert(cashSession?.status === 'OPEN' && cashSession.expectedAmount === null, 'CASH_SESSION_NOT_SAFE_TO_RESTORE');
}

async function backup() {
  const state = await readState(prisma);
  verifyTarget(state);
  fs.writeFileSync(backupPath, `${serialize(state)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`RIVNU_TEST_LOCAL_SALE_BACKUP_READY path=${backupPath}`);
}

async function apply() {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(746821103, 20261102)::text AS "lock"`;
    await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "invoiceNumber" = ${targetInvoiceNumber} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${targetProductId} FOR UPDATE`;

    const state = await readState(tx);
    verifyTarget(state);
    const invoice = state.invoice;
    const order = invoice.salesOrder;

    const productUpdated = await tx.product.updateMany({
      where: { id: targetProductId, stock: 45, reservedStock: 0 },
      data: { stock: 47 },
    });
    assert(productUpdated.count === 1, 'PRODUCT_RESTORE_CONFLICT');

    await tx.employeeActivityLog.deleteMany({
      where: {
        OR: [
          { invoiceId: invoice.id },
          { entityId: invoice.id },
          ...(order ? [{ entityId: order.id }] : []),
        ],
      },
    });
    await tx.auditLog.deleteMany({
      where: {
        OR: [
          { entityId: invoice.id },
          ...(order ? [{ entityId: order.id }] : []),
        ],
      },
    });
    await tx.cashMovement.deleteMany({ where: { invoiceId: invoice.id } });
    await tx.inventoryMovement.deleteMany({ where: { invoiceId: invoice.id } });
    await tx.payment.deleteMany({ where: { invoiceId: invoice.id } });
    if (order) await tx.salesOrder.delete({ where: { id: order.id } });
    await tx.invoice.delete({ where: { id: invoice.id } });

    const sequenceUpdated = await tx.localSaleSequence.updateMany({
      where: { tenantId: invoice.tenantId, nextNumber: 2n },
      data: { nextNumber: 1n },
    });
    assert(sequenceUpdated.count === 1, 'LOCAL_SEQUENCE_RESTORE_CONFLICT');

    const [invoiceCount, orderCount, stock, sequence] = await Promise.all([
      tx.invoice.count({ where: { invoiceNumber: targetInvoiceNumber } }),
      tx.salesOrder.count({ where: { orderNumber: targetOrderNumber } }),
      tx.product.findUnique({ where: { id: targetProductId }, select: { stock: true, reservedStock: true } }),
      tx.localSaleSequence.findUnique({ where: { tenantId: invoice.tenantId }, select: { nextNumber: true } }),
    ]);
    assert(invoiceCount === 0 && orderCount === 0, 'TEST_DOCUMENTS_REMAIN');
    assert(stock?.stock === 47 && stock.reservedStock === 0, 'PRODUCT_NOT_RESTORED');
    assert(sequence?.nextNumber === 1n, 'LOCAL_SEQUENCE_NOT_RESTORED');

    return { restoredStock: stock.stock, nextLocalNumber: sequence.nextNumber.toString() };
  }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });

  console.log(`RIVNU_TEST_LOCAL_SALE_RESTORED stock=${result.restoredStock} nextLocalNumber=${result.nextLocalNumber}`);
  console.log('No NCF, e-NCF or DGII record existed or was changed.');
}

const mode = process.argv[2];
(mode === 'backup' ? backup() : mode === 'apply' ? apply() : Promise.reject(new Error('USE_BACKUP_OR_APPLY')))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
