const assert = require('node:assert/strict');
const test = require('node:test');
const { OrdersService } = require('../dist/modules/orders/orders.service');

const tenantId = 'allpa-tenant';
const user = { id: 'admin', memberships: [{ tenantId, role: 'ADMIN' }] };

test('order search includes inventory and warehouse products with warehouse availability', async () => {
  let query;
  const products = [
    { id: 'inventory', inventoryDestination: 'SALES_INVENTORY' },
    { id: 'warehouse', inventoryDestination: 'WAREHOUSE', warehouseStocks: [{ quantity: 3 }] },
  ];
  const service = new OrdersService({
    product: {
      findMany: async (args) => {
        query = args;
        return products;
      },
    },
  });

  const result = await service.searchProducts(tenantId, user, 'funda', 'ALL');

  assert.deepEqual(result, products);
  assert.equal(query.where.tenantId, tenantId);
  assert.equal(query.where.inventoryDestination, undefined);
  assert.equal(query.where.OR[0].name.contains, 'funda');
  assert.deepEqual(query.include.warehouseStocks, {
    where: { tenantId },
    select: { quantity: true },
  });
});

test('order search keeps its single-origin behavior for existing clients', async () => {
  let query;
  const service = new OrdersService({
    product: { findMany: async (args) => { query = args; return []; } },
  });

  await service.searchProducts(tenantId, user, 'funda');
  assert.equal(query.where.inventoryDestination, 'SALES_INVENTORY');
  assert.equal(query.include.warehouseStocks, undefined);
});

test('barcode lookup finds a warehouse item without an origin selector', async () => {
  let query;
  let markedScannedId;
  const warehouseProduct = {
    id: 'warehouse',
    inventoryDestination: 'WAREHOUSE',
    warehouseStocks: [{ quantity: 3 }],
  };
  const service = new OrdersService({
    product: {
      findFirst: async (args) => {
        query = args;
        return warehouseProduct;
      },
      update: async ({ where }) => { markedScannedId = where.id; },
    },
  });

  const result = await service.findProductByBarcode(tenantId, user, 'BA00407', 'ALL');

  assert.equal(result, warehouseProduct);
  assert.equal(query.where.inventoryDestination, undefined);
  assert.deepEqual(query.include.warehouseStocks, {
    where: { tenantId },
    select: { quantity: true },
  });
  assert.equal(markedScannedId, warehouseProduct.id);
});
