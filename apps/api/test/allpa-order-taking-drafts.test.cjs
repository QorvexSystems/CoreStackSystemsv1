const assert = require('node:assert/strict');
const test = require('node:test');
const { OrdersService } = require('../dist/modules/orders/orders.service');

function setup() {
  const rows = [];
  const tenantId = 'tenant-a';
  const admin = { id: 'admin-a', memberships: [{ tenantId, role: 'ADMIN' }] };
  const colleague = { id: 'admin-b', memberships: [{ tenantId, role: 'ADMIN' }] };
  const prisma = {
    orderTakingDraft: {
      findMany: async ({ where }) => rows.filter((row) => row.tenantId === where.tenantId),
      create: async ({ data }) => {
        const row = { id: `draft-${rows.length + 1}`, version: 1, ...data };
        rows.push(row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const row = rows.find((item) => item.id === where.id && item.tenantId === where.tenantId && item.version === where.version);
        if (!row) return { count: 0 };
        Object.assign(row, { label: data.label, snapshot: data.snapshot, version: row.version + 1 });
        return { count: 1 };
      },
      findFirstOrThrow: async ({ where }) => rows.find((row) => row.id === where.id && row.tenantId === where.tenantId),
      deleteMany: async ({ where }) => {
        const index = rows.findIndex((row) => row.id === where.id && row.tenantId === where.tenantId);
        if (index === -1) return { count: 0 };
        rows.splice(index, 1);
        return { count: 1 };
      },
    },
    product: {
      findFirst: async ({ where, include }) => ({ id: where.id, inventoryDestination: where.inventoryDestination, warehouseStocks: include.warehouseStocks ? [{ quantity: 4 }] : undefined }),
    },
  };
  return { service: new OrdersService(prisma), rows, tenantId, admin, colleague };
}

test('a paused order is shared with another employee without reserving inventory', async () => {
  const { service, tenantId, admin, colleague, rows } = setup();
  const snapshot = { cart: [{ product: { id: 'product-a' }, quantity: 2 }] };
  const created = await service.createDraft(tenantId, admin, { label: 'Cliente A', snapshot });
  assert.equal(created.version, 1);
  assert.equal((await service.findDrafts(tenantId, colleague))[0].id, created.id);
  assert.equal(rows.length, 1);
  const updated = await service.updateDraft(tenantId, colleague, created.id, { label: 'Cliente A', snapshot, version: 1 });
  assert.equal(updated.version, 2);
  await assert.rejects(() => service.updateDraft(tenantId, admin, created.id, { label: 'Cliente A', snapshot, version: 1 }), /changed/);
});

test('draft updates and deletion cannot cross tenants', async () => {
  const { service, tenantId, admin, rows } = setup();
  const snapshot = { cart: [] };
  const created = await service.createDraft(tenantId, admin, { label: 'Cliente B', snapshot });
  const otherTenantAdmin = { id: 'admin-c', memberships: [{ tenantId: 'tenant-b', role: 'ADMIN' }] };
  assert.deepEqual(await service.findDrafts('tenant-b', otherTenantAdmin), []);
  await assert.rejects(() => service.updateDraft('tenant-b', otherTenantAdmin, created.id, { label: 'Changed', snapshot, version: 1 }));
  await assert.rejects(() => service.discardDraft('tenant-b', otherTenantAdmin, created.id));
  assert.equal(rows.length, 1);
});

test('warehouse products can be refreshed when a shared order is resumed', async () => {
  const { service, tenantId, admin } = setup();
  const product = await service.findOrderProduct(tenantId, admin, 'product-a', 'WAREHOUSE');
  assert.equal(product.warehouseStocks[0].quantity, 4);
  assert.equal(product.inventoryDestination, 'WAREHOUSE');
});
