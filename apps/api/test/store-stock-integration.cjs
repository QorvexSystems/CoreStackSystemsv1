require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@qorvex/database');
const { ReceiptsService } = require('../dist/modules/receipts/receipts.service');
const {
  SupplierInvoicesService,
} = require('../dist/modules/supplier-invoices/supplier-invoices.service');

const db = new PrismaClient();
const rollback = new Error('ROLLBACK_STOCK_TEST_SUCCESS');
const checks = [];
function check(name, condition) {
  assert.ok(condition, name);
  checks.push(name);
  console.log('OK: ' + name);
}

(async () => {
  const [tables] = await db.$queryRaw`
    SELECT to_regclass('public."WarehouseStock"')::text AS stock,
      to_regclass('public."WarehouseMovement"')::text AS movements
  `;
  check(
    'Las tablas de stock físico de Fábrica están eliminadas',
    tables.stock === null && tables.movements === null,
  );
  await db.$transaction(
    async (tx) => {
      const scoped = new Proxy(tx, {
        get(target, key) {
          if (key === '$transaction')
            return (operation) =>
              typeof operation === 'function' ? operation(scoped) : Promise.all(operation);
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { slug: 'unique-personalizado' } });
      const member = await tx.membership.findFirstOrThrow({
        where: { tenantId: tenant.id, role: 'ADMIN', status: 'ACTIVE' },
      });
      const product = await tx.product.create({
        data: {
          tenantId: tenant.id,
          name: 'Producto prueba recepción',
          sku: 'TEST-' + randomUUID(),
          price: 200,
          salePrice: 200,
          cost: 100,
          stock: 10,
          reservedStock: 2,
        },
      });
      const supplier = await tx.supplier.create({
        data: {
          tenantId: tenant.id,
          commercialName: 'Suplidor prueba transaccional',
          documentType: 'RNC',
          documentNumber: 'TEST-' + randomUUID(),
          createdById: member.userId,
        },
      });
      const receipts = new ReceiptsService(scoped);
      const invoices = new SupplierInvoicesService(scoped, receipts);
      const invoice = await invoices.create(tenant.id, member.userId, {
        supplierId: supplier.id,
        invoiceNumber: 'TEST-' + randomUUID(),
        issueDate: '2026-10-21',
        dueDate: '2026-11-21',
        inventoryDestination: 'SALES_INVENTORY',
        items: [{ productId: product.id, quantity: 3, unitCostNet: 120, taxRate: 0.18 }],
      });
      await invoices.registerInTransaction(tx, tenant.id, member.userId, invoice.id);
      const receipt = await receipts.create(tenant.id, member.userId, {
        supplierInvoiceId: invoice.id,
        items: [
          {
            supplierInvoiceItemId: invoice.items[0].id,
            quantityReceived: 3,
            priceDecision: 'KEEP',
          },
        ],
      });
      await receipts.confirm(tenant.id, member.userId, receipt.id);
      const received = await tx.product.findUniqueOrThrow({ where: { id: product.id } });
      check(
        'Recepción suma stock de Productos y conserva sus reservas',
        received.stock === 13 && received.reservedStock === 2,
      );
      check(
        'Recepción actualiza costo sin cambiar el precio conservado',
        received.cost.eq(120) && received.price.eq(200),
      );
      const purchaseMovements = await tx.inventoryMovement.findMany({
        where: { productId: product.id, goodsReceiptId: receipt.id },
      });
      check(
        'Recepción registra una sola entrada en el historial de Tienda',
        purchaseMovements.length === 1 &&
          purchaseMovements[0].type === 'PURCHASE' &&
          purchaseMovements[0].quantity === 3,
      );
      await assert.rejects(receipts.confirm(tenant.id, member.userId, receipt.id));
      check(
        'Confirmar dos veces no duplica existencias',
        (await tx.product.findUniqueOrThrow({ where: { id: product.id } })).stock === 13,
      );
      await tx.product.update({ where: { id: product.id }, data: { reservedStock: 12 } });
      await assert.rejects(
        receipts.reverse(tenant.id, member.userId, receipt.id, 'Prueba de reservas'),
        /existencias suficientes/,
      );
      await tx.product.update({ where: { id: product.id }, data: { reservedStock: 2 } });
      await receipts.reverse(
        tenant.id,
        member.userId,
        receipt.id,
        'Prueba de reversión de recepción',
      );
      const restored = await tx.product.findUniqueOrThrow({ where: { id: product.id } });
      check(
        'Revertir recepción resta una vez y conserva reservas',
        restored.stock === 10 && restored.reservedStock === 2,
      );
      check(
        'Revertir recepción restaura costo y precio',
        restored.cost.eq(100) && restored.price.eq(200),
      );
      const movements = await tx.inventoryMovement.findMany({
        where: { productId: product.id, goodsReceiptId: receipt.id },
      });
      check(
        'Historial conserva entrada y reversión de Tienda',
        movements.length === 2 &&
          movements.some((m) => m.type === 'ADJUSTMENT_OUT' && m.quantity === 3),
      );
      throw rollback;
    },
    { timeout: 180000, maxWait: 10000 },
  );
})()
  .catch((error) => {
    if (error === rollback)
      console.log(JSON.stringify({ passed: checks.length, rolledBack: true }));
    else {
      console.error(error.message);
      process.exitCode = 1;
    }
  })
  .finally(() => db.$disconnect());
