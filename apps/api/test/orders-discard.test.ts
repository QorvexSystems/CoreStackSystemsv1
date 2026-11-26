import assert from 'node:assert/strict';
import test from 'node:test';
import { OrdersService } from '../src/modules/orders/orders.service';

function harness(overrides: Record<string, unknown> = {}, updateCount = 1) {
  const calls: Array<{ operation: string; args?: any }> = [];
  const order = {
    id: 'unpaid-order', tenantId: 'tenant-test', orderNumber: 'ORD-TEST',
    status: 'IN_CASHIER', invoiceId: null, claimedById: 'cashier-test',
    claimedCashSessionId: 'session-test', createdById: 'order-taker',
    items: [{ productId: 'product-test', reservedQuantity: 2 }],
    creditApproval: null, total: '118.00', ...overrides,
  };
  const tx = {
    $queryRaw: async (_sql: unknown, ...args: unknown[]) => {
      calls.push({ operation: 'lock', args });
      return [{ id: order.id }];
    },
    salesOrder: {
      findFirst: async (args: any) => {
        assert.equal(calls[0].operation, 'lock');
        assert.equal(args.where.tenantId, 'tenant-test');
        return order;
      },
      updateMany: async (args: any) => {
        calls.push({ operation: 'cancel', args });
        return { count: updateCount };
      },
      findUniqueOrThrow: async () => ({ ...order, status: 'CANCELLED' }),
    },
    $executeRaw: async (_sql: unknown, ...args: unknown[]) => {
      calls.push({ operation: 'release', args });
      return 1;
    },
    creditSaleApproval: { update: async (args: unknown) => calls.push({ operation: 'credit', args }) },
    employeeActivityLog: { create: async (args: unknown) => calls.push({ operation: 'audit', args }) },
  };
  const service = new OrdersService({
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as never, {} as never);
  const user = {
    id: 'cashier-test', memberships: [{ tenantId: 'tenant-test', role: 'CASHIER', canUsePos: true }],
  } as never;
  return { service, calls, user };
}

test('cashier discards their unpaid claimed order, releases reservations and audits without issuing anything', async () => {
  const { service, calls, user } = harness();
  const cancelled = await service.cancel('tenant-test', user, 'unpaid-order', { reason: 'Error de prueba' });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.deepEqual(calls.map(c => c.operation), ['lock', 'cancel', 'release', 'audit']);
  const update = calls.find(c => c.operation === 'cancel')!.args;
  assert.equal(update.where.invoiceId, null);
  assert.equal(update.where.tenantId, 'tenant-test');
  assert.equal(update.data.claimedById, null);
  assert.equal(update.data.claimedCashSessionId, null);
  assert.equal(update.data.claimExpiresAt, null);
  assert.deepEqual(calls.find(c => c.operation === 'release')!.args, [2, 'product-test']);
});

for (const overrides of [
  { status: 'COMPLETED', invoiceId: 'issued-invoice' },
  { status: 'CANCELLED' },
  { status: 'IN_CASHIER', invoiceId: 'issued-invoice' },
  { claimedById: 'other-cashier' },
]) {
  test(`discard refuses paid, cancelled or another cashier's order: ${JSON.stringify(overrides)}`, async () => {
    const { service, calls, user } = harness(overrides);
    await assert.rejects(() => service.cancel('tenant-test', user, 'unpaid-order'));
    assert.deepEqual(calls.map(c => c.operation), ['lock']);
  });
}

test('conditional cancellation loss never releases inventory twice', async () => {
  const { service, calls, user } = harness({}, 0);
  await assert.rejects(() => service.cancel('tenant-test', user, 'unpaid-order'));
  assert.deepEqual(calls.map(c => c.operation), ['lock', 'cancel']);
});

test('discard also cancels a pending credit approval', async () => {
  const { service, calls, user } = harness({ creditApproval: { id: 'credit-test', status: 'APPROVED' } });
  await service.cancel('tenant-test', user, 'unpaid-order');
  assert.equal(calls.find(c => c.operation === 'credit')!.args.data.status, 'CANCELLED');
});
