const assert = require('node:assert/strict');
const test = require('node:test');
const { OrdersService } = require('../dist/modules/orders/orders.service');
const { OrdersController } = require('../dist/modules/orders/orders.controller');

const tenantId = 'allpa-test';
const admin = { id: 'admin-test', memberships: [{ tenantId, role: 'ADMIN' }] };

function harness() {
  const cashOrders = Array.from({ length: 200 }, (_, index) => ({
    id: `cash-${index}`,
    tenantId,
    orderNumber: `ORD-${index}`,
    destination: 'CASH_SALE',
    status: 'COMPLETED',
  }));
  const quotations = [
    { id: 'pending', tenantId, orderNumber: 'COT-PENDING', destination: 'QUOTATION', status: 'QUOTATION' },
    { id: 'accepted', tenantId, orderNumber: 'COT-ACCEPTED', destination: 'CASH_SALE', status: 'SENT_TO_CASHIER' },
    { id: 'cancelled', tenantId, orderNumber: 'COT-CANCELLED', destination: 'QUOTATION', status: 'CANCELLED' },
  ];
  const records = [...cashOrders, ...quotations, {
    id: 'other-tenant', tenantId: 'other-tenant', orderNumber: 'COT-OTHER', destination: 'QUOTATION', status: 'QUOTATION',
  }];
  const calls = [];
  const prisma = {
    salesOrder: {
      findMany: async args => {
        calls.push(args);
        const rows = records.filter(order =>
          order.tenantId === args.where.tenantId &&
          (!args.where.OR || args.where.OR.some(condition =>
            condition.destination === order.destination ||
            order.orderNumber.startsWith(condition.orderNumber?.startsWith ?? '\0')
          ))
        );
        return args.take ? rows.slice(0, args.take) : rows;
      },
    },
  };
  const service = new OrdersService(prisma);
  service.releaseExpiredClaims = async () => {};
  return { service, controller: new OrdersController(service), calls };
}

test('Cotizaciones returns pending, accepted and cancelled quotations beyond the general 150-order limit', async () => {
  const { controller, calls } = harness();
  const general = await controller.findAll(tenantId, admin);
  assert.equal(general.length, 150);
  assert.equal(general.some(order => order.orderNumber.startsWith('COT-')), false);

  const quotationHistory = await controller.findAll(tenantId, admin, undefined, 'QUOTATION');
  assert.deepEqual(quotationHistory.map(order => order.id), ['pending', 'accepted', 'cancelled']);
  assert.equal(calls[1].take, undefined);
  assert.deepEqual(calls[1].where.OR, [
    { destination: 'QUOTATION' },
    { orderNumber: { startsWith: 'COT-' } },
  ]);
});

test('unknown origin is rejected before querying orders', async () => {
  const { controller, calls } = harness();
  await assert.rejects(() => controller.findAll(tenantId, admin, undefined, 'OTHER'), /Invalid sales order origin/);
  assert.equal(calls.length, 0);
});
