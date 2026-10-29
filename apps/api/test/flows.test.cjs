require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Prisma } = require('@qorvex/database');
const { OrdersService } = require('../dist/modules/orders/orders.service');
const { ReceivablesService } = require('../dist/modules/receivables/receivables.service');
const { ShopifyService } = require('../dist/modules/shopify/shopify.service');
const { factoryOrder, factoryProduct } = require('../dist/common/utils/factory-view');
const { changeReservation } = require('../dist/common/utils/stock-reservations');
const { deliverOrder } = require('../dist/common/utils/order-delivery');
const { businessDateKey } = require('../dist/common/utils/business-date');
const decimal = (value) => new Prisma.Decimal(value);
const product = {
  id: 'p1',
  name: 'Collar',
  sku: 'UP-1',
  price: decimal(100),
  salePrice: decimal(100),
  taxRate: decimal(0.18),
  stock: 10,
  reservedStock: 0,
  unit: 'UNIT',
  trackInventory: true,
};
const orders = new OrdersService({}, {});
const client = { product: { findMany: async () => [product] } };

test('dos personalizaciones del mismo SKU conservan líneas y precios distintos', async () => {
  const result = await orders.computeOrder(
    'tenant',
    [
      { productId: 'p1', quantity: 1, unitPrice: 120, personalization: { children: 1 } },
      { productId: 'p1', quantity: 2, unitPrice: 150, personalization: { children: 3 } },
    ],
    client,
  );
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].personalization.children, 1);
  assert.equal(result.items[1].unitPrice.toNumber(), 150);
  assert.equal(result.total.toNumber(), 495.6);
  assert.equal(result.discountTotal.toNumber(), 0);
});
test('rechaza el origen de stock físico de fábrica retirado', async () => {
  await assert.rejects(
    orders.computeOrder(
      'tenant',
      [{ productId: 'p1', quantity: 3 }],
      client,
      'REGULAR',
      'WAREHOUSE',
    ),
    /stock físico de Fábrica ya no está disponible/,
  );
});
test('cantidades repetidas se validan juntas contra existencia', async () => {
  await assert.rejects(
    orders.computeOrder(
      'tenant',
      [
        { productId: 'p1', quantity: 6 },
        { productId: 'p1', quantity: 5 },
      ],
      client,
    ),
    /Insufficient/,
  );
});
test('el nivel de descuento conserva 5% y 10% acordados', async () => {
  const first = await orders.computeOrder(
    'tenant',
    [{ productId: 'p1', quantity: 1 }],
    client,
    'DISCOUNT_10',
  );
  const second = await orders.computeOrder(
    'tenant',
    [{ productId: 'p1', quantity: 1 }],
    client,
    'PREFERRED_18',
  );
  assert.equal(first.items[0].unitPrice.toNumber(), 95);
  assert.equal(second.items[0].unitPrice.toNumber(), 90);
});
test('una reserva fallida no registra sincronización', async () => {
  let jobs = 0;
  await assert.rejects(
    changeReservation(
      { $executeRaw: async () => 0, inventorySyncJob: { upsert: async () => jobs++ } },
      't',
      'p',
      'SALES_INVENTORY',
      1,
    ),
  );
  assert.equal(jobs, 0);
});
test('reservar o liberar registra una sincronización persistente', async () => {
  let job;
  await changeReservation(
    {
      $executeRaw: async () => 1,
      inventorySyncJob: {
        upsert: async (args) => {
          job = args;
        },
      },
    },
    't',
    'p',
    'SALES_INVENTORY',
    -1,
  );
  assert.equal(job.update.pending, true);
  assert.equal(job.update.revision.increment, 1);
});
test('la vista de fábrica usa lista permitida, sin precios ni pagos', () => {
  const safe = factoryOrder({
    id: 'o',
    total: 100,
    invoiceId: 'i',
    invoice: { balance: 50 },
    customer: { name: 'Ana', creditBalance: 200 },
    items: [{ id: 'l', unitPrice: 100, total: 100, product: { ...product, cost: 50 } }],
    corporateUnits: [],
  });
  assert.equal(safe.total, undefined);
  assert.equal(safe.invoice, undefined);
  assert.equal(safe.items[0].unitPrice, undefined);
  assert.equal(safe.items[0].product.cost, undefined);
  assert.equal(factoryProduct({ ...product, cost: 80 }).price, undefined);
});
function deliveryClient(overrides = {}) {
  return {
    $queryRaw: async () => [],
    salesOrder: {
      findFirstOrThrow: async () => ({
        status: 'COMPLETED',
        productionStage: 'READY',
        exceptionStatus: 'NONE',
        paymentMode: 'CASH',
        requiresProduction: false,
        invoice: { status: 'PAID', balance: decimal(0) },
        corporateUnits: [],
        ...overrides,
      }),
      update: async () => {},
    },
    orderWorkflowEvent: { create: async () => {} },
  };
}
for (const [description, overrides] of [
  ['pausa', { exceptionStatus: 'PAUSED' }],
  ['calidad pendiente', { requiresProduction: true, qualityApprovedAt: null }],
  ['balance de anticipo pendiente', { invoice: { status: 'PARTIALLY_PAID', balance: decimal(1) } }],
  [
    'destinatario empresarial no entregado',
    { isCorporate: true, corporateUnits: [{ deliveredAt: null }] },
  ],
  ['doble entrega', { productionStage: 'DELIVERED' }],
])
  test('la entrega bloquea ' + description, async () => {
    await assert.rejects(deliverOrder(deliveryClient(overrides), 't', 'o', 'u'));
  });
test('la entrega válida cambia estado y escribe historial', async () => {
  const tx = deliveryClient();
  let update;
  let event;
  tx.salesOrder.update = async (args) => {
    update = args;
  };
  tx.orderWorkflowEvent.create = async (args) => {
    event = args;
  };
  await deliverOrder(tx, 't', 'o', 'u');
  assert.equal(update.data.productionStage, 'DELIVERED');
  assert.equal(event.data.fromStage, 'READY');
});
test('una clave repetida de abono no acepta cambiar el método', () => {
  const service = new ReceivablesService({});
  const payment = {
    invoiceId: 'i',
    userId: 'u',
    cashSessionId: 'c',
    amount: decimal(100),
    method: 'TRANSFER',
  };
  assert.throws(
    () => service.validateIdempotentPayment(payment, 'i', 'u', 'c', decimal(100), 'CASH'),
    /Idempotency/,
  );
  service.validateIdempotentPayment(payment, 'i', 'u', 'c', decimal(100), 'TRANSFER');
});
test('un pago Shopify repetido no vuelve a descontar inventario', async () => {
  const tx = {
    $queryRaw: async () => [],
    salesOrder: { findUniqueOrThrow: async () => ({ id: 'o', status: 'COMPLETED' }) },
  };
  const service = new ShopifyService({ $transaction: (callback) => callback(tx) }, {});
  service.verifyWebhook = () => {};
  service.findShopifyOrder = async () => ({ tenant: { id: 't' }, order: { id: 'o' } });
  const result = await service.receiveOrderPaid(Buffer.from('{}'), { id: 1 }, {});
  assert.equal(result.duplicate, true);
});
test('fecha operativa usa Santo Domingo aunque el servidor esté en UTC', () => {
  assert.equal(businessDateKey(new Date('2026-10-17T02:00:00Z')), '2026-10-16');
});

test('consultas de dashboard respetan un pool de una conexión', async () => {
  const { readInBatches } = require('../dist/common/utils/read-batch');
  const before = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://test@localhost/demo?connection_limit=1';
  let active = 0;
  let maximum = 0;
  const lazy = (value) => ({
    then: (resolve) => {
      active++;
      maximum = Math.max(maximum, active);
      setTimeout(() => {
        active--;
        resolve(value);
      }, 2);
    },
  });
  try {
    assert.deepEqual(await readInBatches([lazy(1), lazy(2), lazy(3)]), [1, 2, 3]);
    assert.equal(maximum, 1);
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before;
  }
});
test('no se entrega una orden con factura acreditada', async () => {
  await assert.rejects(
    deliverOrder(
      deliveryClient({ invoice: { status: 'CREDITED', balance: decimal(0) } }),
      't',
      'o',
      'u',
    ),
  );
});

test('aprobar crédito no cancela el borrador de factura', async () => {
  const {
    CreditApprovalsService,
  } = require('../dist/modules/credit-approvals/credit-approvals.service');
  const approval = {
    id: 'a',
    salesOrderId: 'o',
    customerId: 'c',
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 86400000),
    financedAmount: decimal(100),
    customer: {
      status: 'ACTIVE',
      creditEnabled: true,
      creditStatus: 'ACTIVE',
      creditLimit: decimal(1000),
    },
    salesOrder: { status: 'CREATED', paymentMode: 'CREDIT', items: [], orderNumber: 'o' },
  };
  const dueDate = new Date(Date.now() + 86400000);
  Object.assign(approval, {
    dueDate,
    requestedTotal: decimal(100),
    initialPaymentAmount: decimal(0),
    initialPaymentOption: 'NONE',
    creditTermOption: 'CUSTOMER_DEFAULT',
  });
  Object.assign(approval.salesOrder, {
    dueDate,
    customerId: 'c',
    total: decimal(100),
    initialPaymentAmount: decimal(0),
    initialPaymentOption: 'NONE',
    creditTermOption: 'CUSTOMER_DEFAULT',
  });
  let cancellations = 0;
  const tx = {
    creditSaleApproval: {
      findFirst: async () => approval,
      updateMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => ({ ...approval, exceedsCreditLimit: false }),
    },
    invoice: {
      aggregate: async () => ({ _sum: { balance: decimal(0) } }),
      updateMany: async () => {
        cancellations++;
        return { count: 1 };
      },
    },
    salesOrder: { updateMany: async () => ({ count: 1 }) },
    auditLog: { create: async () => {} },
  };
  const service = new CreditApprovalsService({ $transaction: (callback) => callback(tx) });
  await service.approve('t', { id: 'u', memberships: [{ tenantId: 't', role: 'ADMIN' }] }, 'a', {});
  assert.equal(cancellations, 0);
});
