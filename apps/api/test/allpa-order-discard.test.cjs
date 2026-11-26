const assert = require('node:assert/strict');
const test = require('node:test');
const { OrdersService } = require('../dist/modules/orders/orders.service');

function harness(overrides = {}, { updateCount = 1, role = 'CASHIER' } = {}) {
  const calls = [];
  const order = {
    id: 'order-test', tenantId: 'tenant-test', orderNumber: 'ORD-TEST',
    status: 'IN_CASHIER', invoiceId: null, claimedById: 'cashier-test',
    claimedCashSessionId: 'session-test', createdById: 'order-taker',
    inventorySource: 'WAREHOUSE', total: '118.00', creditApproval: null, discountApproval: null,
    items: [{ productId: 'product-test', reservedQuantity: 2 }], ...overrides,
  };
  const tx = {
    $queryRaw: async (_sql, ...args) => {
      calls.push({ operation: 'lock', args });
      return args[0] === order.id && args[1] === order.tenantId ? [{ id: order.id }] : [];
    },
    salesOrder: {
      findFirst: async () => {
        assert.equal(calls.at(-1).operation, 'lock');
        return order;
      },
      updateMany: async args => {
        calls.push({ operation: 'cancel', args });
        if (updateCount === 1) Object.assign(order, args.data);
        return { count: updateCount };
      },
      findUniqueOrThrow: async () => order,
    },
    $executeRaw: async (_sql, ...args) => { calls.push({ operation: 'release', args }); return 1; },
    creditSaleApproval: { update: async args => calls.push({ operation: 'credit', args }) },
    discountApproval: { update: async args => calls.push({ operation: 'discount', args }) },
    employeeActivityLog: { create: async args => calls.push({ operation: 'audit', args }) },
  };
  const service = new OrdersService({ $transaction: async fn => fn(tx) });
  const user = { id: 'cashier-test', memberships: [{ tenantId: 'tenant-test', role, canUsePos: true }] };
  return { service, calls, user };
}

for (const inventorySource of ['WAREHOUSE', 'SALES_INVENTORY']) {
  test(`discard releases only the reservation, not physical stock or money: ${inventorySource}`, async () => {
    const { service, calls, user } = harness({ inventorySource });
    const result = await service.cancel('tenant-test', user, 'order-test', { reason: 'Prueba' });
    assert.equal(result.status, 'CANCELLED');
    assert.deepEqual(calls.map(c => c.operation), ['lock', 'cancel', 'release', 'audit']);
    assert.deepEqual(calls[0].args, ['order-test', 'tenant-test']);
    assert.equal(calls[1].args.where.invoiceId, null);
    assert.equal(calls[1].args.where.tenantId, 'tenant-test');
    assert.equal(calls[1].args.data.claimedById, null);
    assert.equal(calls[1].args.data.claimedCashSessionId, null);
    assert.deepEqual(calls[2].args, [2, 'product-test']);
  });
}

for (const overrides of [
  { status: 'COMPLETED', invoiceId: 'paid-invoice' },
  { status: 'IN_CASHIER', invoiceId: 'paid-invoice' },
  { status: 'CANCELLED' },
  { claimedById: 'other-cashier' },
]) {
  test(`refuses issued, cancelled and other operators' orders: ${JSON.stringify(overrides)}`, async () => {
    const { service, calls, user } = harness(overrides);
    await assert.rejects(() => service.cancel('tenant-test', user, 'order-test'));
    assert.deepEqual(calls.map(c => c.operation), ['lock']);
  });
}

test('another tenant cannot discard the order', async () => {
  const { service, calls, user } = harness();
  await assert.rejects(() => service.cancel('other-tenant', user, 'order-test'));
  assert.deepEqual(calls.map(c => c.operation), ['lock']);
});

test('lost conditional update does not release stock', async () => {
  const { service, calls, user } = harness({}, { updateCount: 0 });
  await assert.rejects(() => service.cancel('tenant-test', user, 'order-test'));
  assert.deepEqual(calls.map(c => c.operation), ['lock', 'cancel']);
});

test('repeated cancellation cannot release stock twice', async () => {
  const { service, calls, user } = harness();
  await service.cancel('tenant-test', user, 'order-test');
  await assert.rejects(() => service.cancel('tenant-test', user, 'order-test'));
  assert.equal(calls.filter(c => c.operation === 'release').length, 1);
});

test('ALLPA order taker can discard their own claimed order and cancel pending approvals', async () => {
  const { service, calls, user } = harness({
    creditApproval: { id: 'credit', status: 'APPROVED' },
    discountApproval: { id: 'discount', status: 'PENDING' },
  }, { role: 'ORDER_TAKER' });
  await service.cancel('tenant-test', user, 'order-test');
  assert.equal(calls.find(c => c.operation === 'credit').args.data.status, 'CANCELLED');
  assert.equal(calls.find(c => c.operation === 'discount').args.data.status, 'CANCELLED');
});

test('common products have no inventory reservation to release', async () => {
  const { service, calls, user } = harness({ items: [{ productId: null, reservedQuantity: 0 }] });
  await service.cancel('tenant-test', user, 'order-test');
  assert.deepEqual(calls.map(c => c.operation), ['lock', 'cancel', 'audit']);
});
