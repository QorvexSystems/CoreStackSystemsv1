import assert from 'node:assert/strict';
import test from 'node:test';
import { Role, SalesOrderDestination, SalesOrderStatus } from '@qorvex/database';
import { OrdersService } from '../src/modules/orders/orders.service';

test('quotation listing includes pending, accepted and cancelled quotations beyond the general order cap', async () => {
  const ordinaryOrders = Array.from({ length: 160 }, (_, index) => ({
    id: `sale-${index}`,
    tenantId: 'tenant-rivnu',
    destination: SalesOrderDestination.CASH_SALE,
    orderNumber: `ORD-${index}`,
    status: SalesOrderStatus.COMPLETED,
  }));
  const quotations = [
    { id: 'pending', destination: SalesOrderDestination.QUOTATION, orderNumber: 'COT-1', status: SalesOrderStatus.QUOTATION },
    { id: 'accepted', destination: SalesOrderDestination.QUOTATION, orderNumber: 'COT-2', status: SalesOrderStatus.COMPLETED },
    { id: 'cancelled', destination: SalesOrderDestination.QUOTATION, orderNumber: 'COT-3', status: SalesOrderStatus.CANCELLED },
    { id: 'legacy', destination: SalesOrderDestination.CASH_SALE, orderNumber: 'COT-4', status: SalesOrderStatus.QUOTATION },
  ].map((order) => ({ ...order, tenantId: 'tenant-rivnu' }));
  const queries: any[] = [];
  const prisma = {
    salesOrder: {
      updateMany: async () => ({ count: 0 }),
      findMany: async (query: any) => {
        queries.push(query);
        let rows = [...ordinaryOrders, ...quotations].filter((order) => order.tenantId === query.where.tenantId);
        if (query.where.OR) {
          rows = rows.filter((order) => query.where.OR.some((filter: any) =>
            filter.destination === order.destination
              || order.orderNumber.startsWith(filter.orderNumber?.startsWith ?? '\0')));
        }
        return query.take ? rows.slice(0, query.take) : rows;
      },
    },
  };
  const service = new OrdersService(prisma as never, {} as never);
  const admin = { id: 'admin', memberships: [{ tenantId: 'tenant-rivnu', role: Role.ADMIN }] } as never;

  const general = await service.findAll('tenant-rivnu', admin);
  assert.equal(general.length, 150);
  assert.equal(general.some((order: any) => order.status === SalesOrderStatus.QUOTATION), false);

  const result = await service.findAll('tenant-rivnu', admin, undefined, 'QUOTATION');
  assert.deepEqual(result.map((order: any) => order.id), ['pending', 'accepted', 'cancelled', 'legacy']);
  assert.equal(queries[1].take, undefined);
  assert.deepEqual(queries[1].where.OR, [
    { destination: SalesOrderDestination.QUOTATION },
    { orderNumber: { startsWith: 'COT-' } },
  ]);
  await assert.rejects(() => service.findAll('tenant-rivnu', admin, undefined, 'OTHER'));
});
