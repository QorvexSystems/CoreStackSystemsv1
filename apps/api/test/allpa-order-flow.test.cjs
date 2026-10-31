const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const {
  InvoiceDocumentType,
  PaymentMethod,
  Prisma,
  ProductInventoryDestination,
  ProductUnit,
  SalesOrderPriceLevel,
} = require('@qorvex/database');
const { OrdersService } = require('../dist/modules/orders/orders.service');
const { PosService } = require('../dist/modules/pos/pos.service');
const { reserveOrderStock } = require('../dist/common/utils/order-stock-reservation');

const posUtilsPath = path.resolve(__dirname, '../../web/components/operations/pos/pos-utils.ts');
const posUtilsModule = new Module(posUtilsPath, module);
posUtilsModule.filename = posUtilsPath;
posUtilsModule.paths = Module._nodeModulePaths(path.dirname(posUtilsPath));
posUtilsModule._compile(
  ts.transpileModule(readFileSync(posUtilsPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  posUtilsPath,
);
const { calculateSaleAmounts, canAddProduct, getAvailableStock, getDefaultQuantity, getProductPrice } = posUtilsModule.exports;

const product = {
  id: 'warehouse-product',
  name: 'Caja de prueba',
  sku: 'CAJA-1',
  barcode: '123456',
  unit: ProductUnit.UNIT,
  price: new Prisma.Decimal(100),
  salePrice: new Prisma.Decimal(100),
  taxRate: new Prisma.Decimal('0.18'),
  trackInventory: false,
  stock: 0,
  reservedStock: 0,
};

function orderServiceWithWarehouseStock(quantity, reservedStock = 0, pricesIncludeTax = false) {
  return new OrdersService({
    tenant: { findUniqueOrThrow: async () => ({ salePricesIncludeTax: pricesIncludeTax }) },
    product: { findMany: async () => [{ ...product, reservedStock }] },
    warehouseStock: {
      findMany: async () => quantity === null ? [] : [{ productId: product.id, quantity }],
    },
  });
}

function computeWarehouseOrder(
  quantityAvailable,
  quantity,
  priceLevel = SalesOrderPriceLevel.REGULAR,
  reservedStock = 0,
) {
  const service = orderServiceWithWarehouseStock(quantityAvailable, reservedStock);
  return service.computeOrder(
    'tenant',
    [{ productId: product.id, quantity }],
    undefined,
    priceLevel,
    ProductInventoryDestination.WAREHOUSE,
  );
}

test('warehouse order reads WarehouseStock, adds ITBIS once, and preserves the checkout snapshot', async () => {
  const order = await computeWarehouseOrder(2, 2);
  assert.equal(order.subtotal.toNumber(), 200);
  assert.equal(order.taxTotal.toNumber(), 36);
  assert.equal(order.total.toNumber(), 236);

  const pos = Object.create(PosService.prototype);
  const checkout = await pos.computeSaleFromOrder({
    inventorySource: ProductInventoryDestination.WAREHOUSE,
    items: order.items,
  });
  assert.equal(checkout.total.toNumber(), order.total.toNumber());
  await assert.rejects(
    pos.computeSaleFromOrder({
      inventorySource: ProductInventoryDestination.WAREHOUSE,
      items: order.items.map((item) => ({ ...item, reservedQuantity: 0 })),
    }),
    /reservation is incomplete/,
  );
});

test('ALLPA treats a catalog price of RD$100 as the final amount and extracts ITBIS', async () => {
  const service = orderServiceWithWarehouseStock(2, 0, true);
  const order = await service.computeOrder(
    'tenant',
    [{ productId: product.id, quantity: 1 }],
    undefined,
    SalesOrderPriceLevel.REGULAR,
    ProductInventoryDestination.WAREHOUSE,
  );
  const preview = calculateSaleAmounts(getProductPrice(product), 1, 0.18, 0, true);

  assert.equal(order.subtotal.toNumber(), 84.75);
  assert.equal(order.taxTotal.toNumber(), 15.25);
  assert.equal(order.total.toNumber(), 100);
  assert.equal(preview.subtotal, 84.75);
  assert.equal(preview.taxTotal, 15.25);
  assert.equal(preview.total, 100);
});

test('warehouse order rejects missing, exhausted, and insufficient stock', async () => {
  for (const available of [null, 0, 1]) {
    await assert.rejects(computeWarehouseOrder(available, 2), /Insufficient available stock/);
  }
});

test('order-taking cart uses real warehouse quantity and blocks exhausted stock', () => {
  const warehouseProduct = {
    ...product,
    inventoryDestination: ProductInventoryDestination.WAREHOUSE,
    warehouseStocks: [{ quantity: 2 }],
  };
  assert.equal(getAvailableStock(warehouseProduct), 2);
  assert.equal(getDefaultQuantity(warehouseProduct), 1);
  assert.equal(canAddProduct(warehouseProduct, 1), true);
  assert.equal(canAddProduct(warehouseProduct, 2), false);
  assert.equal(canAddProduct({ ...warehouseProduct, warehouseStocks: [] }), false);
  assert.equal(getAvailableStock({ ...warehouseProduct, reservedStock: 1 }), 1);
  assert.equal(canAddProduct({ ...warehouseProduct, reservedStock: 2 }), false);
  assert.equal(
    getAvailableStock({ ...warehouseProduct, inventoryDestination: ProductInventoryDestination.SALES_INVENTORY, stock: 5, reservedStock: 2 }),
    3,
  );
});

test('warehouse reservation holds stock for the first order and rejects the next', async () => {
  let reservedStock = 0;
  const tx = {
    $queryRaw: async () => [{ reservedStock }],
    warehouseStock: { findUnique: async () => ({ quantity: 2 }) },
    product: {
      update: async ({ data }) => {
        reservedStock += data.reservedStock.increment;
      },
    },
  };
  const item = {
    productId: product.id,
    description: product.name,
    quantity: 2,
    trackInventory: false,
  };
  await reserveOrderStock(tx, 'tenant', ProductInventoryDestination.WAREHOUSE, [item]);
  assert.equal(reservedStock, 2);
  await assert.rejects(
    reserveOrderStock(tx, 'tenant', ProductInventoryDestination.WAREHOUSE, [
      { ...item, quantity: 1 },
    ]),
    /Insufficient available stock/,
  );
  await assert.rejects(computeWarehouseOrder(2, 1, SalesOrderPriceLevel.REGULAR, 2),
    /Insufficient available stock/);
});

test('warehouse checkout releases its reservation and decrements physical stock', async () => {
  let reservedStock = 2;
  let warehouseQuantity = 2;
  const tx = {
    product: {
      updateMany: async ({ where, data }) => {
        if (reservedStock < where.reservedStock.gte) return { count: 0 };
        reservedStock -= data.reservedStock.decrement;
        return { count: 1 };
      },
    },
    $queryRaw: async () => {
      warehouseQuantity -= 2;
      return [{ quantity: warehouseQuantity }];
    },
    warehouseMovement: { create: async () => ({}) },
  };
  const pos = Object.create(PosService.prototype);
  await pos.applyInventoryForSale(tx, {
    tenantId: 'tenant',
    item: {
      product: { ...product, reservedStock: 2 },
      productId: product.id,
      description: product.name,
      quantity: new Prisma.Decimal(2),
      reservedQuantity: 2,
    },
    invoiceId: 'invoice',
    invoiceNumber: 'ALL-NV-1',
    userId: 'employee',
    fromOrder: true,
    inventorySource: ProductInventoryDestination.WAREHOUSE,
  });
  assert.equal(reservedStock, 0);
  assert.equal(warehouseQuantity, 0);
});

test('warehouse order rejects fractional units and aggregates duplicate product lines', async () => {
  await assert.rejects(computeWarehouseOrder(2, 1.5), /whole quantities/);
  const service = orderServiceWithWarehouseStock(1);
  await assert.rejects(
    service.computeOrder(
      'tenant',
      [{ productId: product.id, quantity: 1 }, { productId: product.id, quantity: 1 }],
      undefined,
      SalesOrderPriceLevel.REGULAR,
      ProductInventoryDestination.WAREHOUSE,
    ),
    /Insufficient available stock/,
  );
});

test('discount applies to base before ITBIS', async () => {
  const order = await computeWarehouseOrder(1, 1, SalesOrderPriceLevel.PREFERRED_18);
  assert.equal(order.subtotal.toNumber(), 90);
  assert.equal(order.discountTotal.toNumber(), 10);
  assert.equal(order.taxTotal.toNumber(), 16.2);
  assert.equal(order.total.toNumber(), 106.2);
});

test('ALLPA document policy keeps local note for non-card and enforces E32 for card', () => {
  const pos = Object.create(PosService.prototype);
  const resolve = (requested, payment, electronic = false) =>
    pos.resolveAllpaDocumentType(requested, payment, electronic);
  assert.equal(resolve(undefined, PaymentMethod.CASH), InvoiceDocumentType.LOCAL_SALE_NOTE);
  assert.equal(
    resolve(InvoiceDocumentType.CONSUMER_ELECTRONIC_32, PaymentMethod.CASH),
    InvoiceDocumentType.CONSUMER_ELECTRONIC_32,
  );
  assert.equal(resolve(undefined, PaymentMethod.CARD), InvoiceDocumentType.CONSUMER_ELECTRONIC_32);
  assert.equal(
    resolve(InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31, PaymentMethod.CARD),
    InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31,
  );
  assert.throws(
    () => resolve(InvoiceDocumentType.LOCAL_SALE_NOTE, PaymentMethod.CARD),
    /requiere E32/,
  );
  assert.throws(
    () => resolve(InvoiceDocumentType.LOCAL_SALE_NOTE, PaymentMethod.CASH, true),
    /requiere E32/,
  );
});
