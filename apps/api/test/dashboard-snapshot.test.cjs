require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Prisma } = require('@qorvex/database');
const {
  hydrateDashboardSnapshot,
  loadDashboardSnapshot,
  loadProductSalesSnapshot,
} = require('../dist/modules/dashboard/dashboard-snapshot');

test('snapshot conserva decimales, fechas UTC, stock numérico y nulos', () => {
  const hydrated = hydrateDashboardSnapshot({
    total: '123.45',
    quantity: 3,
    reservedQuantity: 1,
    issuedAt: '2026-10-17T01:30:00.123',
    dueDate: null,
    nested: { openingAmount: 0, deliveredAt: '2026-10-16T20:00:00Z' },
    status: 'PAID',
    rows: [{ refundAmount: '0.25' }],
  });
  assert.ok(hydrated.total instanceof Prisma.Decimal);
  assert.equal(hydrated.total.toNumber(), 123.45);
  assert.equal(hydrated.quantity, 3);
  assert.equal(hydrated.reservedQuantity, 1);
  assert.equal(hydrated.issuedAt.toISOString(), '2026-10-17T01:30:00.123Z');
  assert.equal(hydrated.nested.openingAmount.toNumber(), 0);
  assert.equal(hydrated.nested.deliveredAt.toISOString(), '2026-10-16T20:00:00.000Z');
  assert.equal(hydrated.dueDate, null);
  assert.equal(hydrated.rows[0].refundAmount.toNumber(), 0.25);
});
test('snapshot obtiene resumen completo con una sola lectura parametrizada', async () => {
  let calls = 0;
  let statement;
  const db = {
    $queryRaw: async (sql) => {
      calls++;
      statement = sql;
      return [{ snapshot: {} }];
    },
  };
  const date = new Date('2026-10-16T04:00:00Z');
  const tenant = "tenant-'--not-sql";
  await loadDashboardSnapshot(db, tenant, {
    todayStart: date,
    tomorrowStart: date,
    monthStart: date,
    nextMonthStart: date,
    seriesStart: date,
  });
  assert.equal(calls, 1);
  assert.ok(statement.values.includes(tenant));
  assert.ok(!statement.text.includes(tenant));
  assert.ok(statement.text.includes('WITH invoices AS'));
});
test('ranking conserva cantidades decimales y lee una sola vez', async () => {
  let calls = 0;
  const db = {
    $queryRaw: async () => {
      calls++;
      return [
        {
          snapshot: {
            products: [],
            invoiceItems: [
              {
                quantity: '2.50',
                total: '100',
                returnRequestItems: [{ quantity: '0.50', total: '20' }],
                invoice: { issuedAt: '2026-10-16T12:00:00', createdAt: '2026-10-16T12:00:00' },
              },
            ],
          },
        },
      ];
    },
  };
  const snapshot = await loadProductSalesSnapshot(db, 'tenant', new Date());
  assert.equal(calls, 1);
  assert.equal(snapshot.invoiceItems[0].quantity.toNumber(), 2.5);
  assert.equal(snapshot.invoiceItems[0].returnRequestItems[0].quantity.toNumber(), 0.5);
});
