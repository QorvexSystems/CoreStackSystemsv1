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
const { canAddProduct, getAvailableStock, getDefaultQuantity } = posUtilsModule.exports;

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

function orderServiceWithWarehouseStock(quantity) {
  return new OrdersService({
    tenant: { findUniqueOrThrow: async () => ({ salePricesIncludeTax: false }) },
    product: { findMany: async () => [product] },
    warehouseStock: {
      findMany: async () => quantity === null ? [] : [{ productId: product.id, quantity }],
    },
  });
}

function computeWarehouseOrder(quantityAvailable, quantity, priceLevel = SalesOrderPriceLevel.REGULAR) {
  const service = orderServiceWithWarehouseStock(quantityAvailable);
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
    items: order.items.map((item) => ({ ...item, reservedQuantity: 0 })),
  });
  assert.equal(checkout.total.toNumber(), order.total.toNumber());
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
  assert.equal(
    getAvailableStock({ ...warehouseProduct, inventoryDestination: ProductInventoryDestination.SALES_INVENTORY, stock: 5, reservedStock: 2 }),
    3,
  );
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
