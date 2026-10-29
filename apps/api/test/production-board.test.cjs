require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadProductionBoard } = require('../dist/modules/orders/production-board.query');
const { OrdersService } = require('../dist/modules/orders/orders.service');

function approvalFixture(overrides = {}) {
  const order = {
    id: 'order-approval', requiresProduction: true, productionStage: 'FACTORY',
    status: 'COMPLETED', exceptionStatus: 'NONE', designApprovedAt: null,
    items: [{ product: { kind: 'PERSONALIZED' } }], ...overrides,
  };
  const events = [];
  const tx = {
    salesOrder: {
      findFirstOrThrow: async () => order,
      update: async ({ data }) => Object.assign(order, data),
    },
    orderWorkflowEvent: { create: async ({ data }) => events.push(data) },
  };
  const service = new OrdersService({ $transaction: async (callback) => callback(tx) }, {});
  service.lockSalesOrder = async () => {};
  service.findOne = async () => order;
  return { service, order, events };
}
const approvalAdmin = { id: 'admin', memberships: [{ tenantId: 'tenant', role: 'ADMIN' }] };
const approvalWorker = { id: 'worker', memberships: [{ tenantId: 'tenant', role: 'WAREHOUSE_KEEPER' }] };

test('administración puede aprobar diseño en fábrica y el operario aprobar calidad después', async () => {
  const { service, order, events } = approvalFixture();
  await assert.rejects(service.approveQuality('tenant', approvalWorker, order.id), /diseño primero/);
  await service.approveDesign('tenant', approvalAdmin, order.id);
  await service.approveQuality('tenant', approvalWorker, order.id);
  assert.ok(order.designApprovedAt instanceof Date);
  assert.ok(order.qualityApprovedAt instanceof Date);
  assert.equal(order.designApprovedById, 'admin');
  assert.equal(order.qualityApprovedById, 'worker');
  assert.equal(order.productionStage, 'FACTORY');
  assert.equal(events.length, 2);
});
test('Fábrica no adquiere permiso para aprobar diseños', async () => {
  const { service, order, events } = approvalFixture();
  await assert.rejects(service.approveDesign('tenant', approvalWorker, order.id), /administración/);
  assert.equal(events.length, 0);
});
test('diseño mantiene aprobación en espera y bloquea órdenes cerradas o con incidencia', async () => {
  const waiting = approvalFixture({ productionStage: 'WAITING' });
  await waiting.service.approveDesign('tenant', approvalAdmin, waiting.order.id);
  assert.ok(waiting.order.designApprovedAt);
  for (const state of [
    { productionStage: 'DELIVERED' }, { productionStage: 'READY' },
    { status: 'CANCELLED' }, { exceptionStatus: 'PAUSED' }, { requiresProduction: false },
  ]) {
    const { service, order } = approvalFixture(state);
    await assert.rejects(service.approveDesign('tenant', approvalAdmin, order.id), /no está disponible/);
  }
});

test('tablero carga una vez con negocio parametrizado y conserva fechas y cantidades', async () => {
  let statement;
  let calls = 0;
  const prisma = {
    $queryRaw: async (sql) => {
      calls++;
      statement = sql;
      return [
        {
          order: {
            id: 'order-1',
            total: '2065.00',
            promisedAt: '2026-10-18T12:00:00',
            items: [{ quantity: '1.00', description: 'Cadena' }],
            corporateUnits: [],
            workflowEvents: [],
          },
        },
      ];
    },
  };
  const tenantId = "tenant-'--not-sql";
  const orders = await loadProductionBoard(prisma, tenantId);
  assert.equal(calls, 1);
  assert.ok(statement.values.includes(tenantId));
  assert.ok(!statement.text.includes(tenantId));
  assert.equal(orders[0].total, '2065');
  assert.equal(orders[0].items[0].quantity, '1');
  assert.equal(orders[0].promisedAt.toISOString(), '2026-10-18T12:00:00.000Z');
});

test('la consulta de Fábrica filtra sus trabajos antes del límite del tablero', async () => {
  let statement;
  await loadProductionBoard(
    {
      $queryRaw: async (sql) => {
        statement = sql;
        return [];
      },
    },
    'tenant',
    true,
  );
  assert.match(statement.text, /"requiresProduction" = true/);
  assert.ok(
    statement.text.indexOf('"requiresProduction" = true') < statement.text.indexOf('LIMIT 1000'),
  );
});

test('Fábrica solo recibe trabajos asignados y nunca datos comerciales', async () => {
  const base = {
    status: 'COMPLETED',
    productionStage: 'WAITING',
    exceptionStatus: 'NONE',
    createdAt: '2026-10-20T12:00:00Z',
    items: [
      {
        id: 'line-1',
        quantity: '1',
        description: 'Collar',
        product: { kind: 'PERSONALIZED', price: '900' },
      },
    ],
    corporateUnits: [],
    workflowEvents: [],
    total: '900',
  };
  const prisma = {
    $queryRaw: async () => [
      { order: { ...base, id: 'assigned', requiresProduction: true } },
      { order: { ...base, id: 'normal', requiresProduction: false } },
      { order: { ...base, id: 'finished', requiresProduction: true, productionStage: 'READY' } },
    ],
  };
  const service = new OrdersService(prisma, {});
  const worker = { memberships: [{ tenantId: 'tenant', role: 'WAREHOUSE_KEEPER' }] };
  const admin = { memberships: [{ tenantId: 'tenant', role: 'ADMIN' }] };
  const workerRows = await service.getKanban('tenant', worker);
  assert.deepEqual(
    workerRows.map((order) => order.id),
    ['assigned'],
  );
  assert.equal(workerRows[0].total, undefined);
  assert.equal(workerRows[0].items[0].product.price, undefined);
  assert.equal((await service.getKanban('tenant', admin)).length, 3);
});

test('administración asigna por orden un producto normal sin cambiar el producto', async () => {
  let saved;
  const current = {
    id: 'order-1',
    isExpress: false,
    productionStage: 'WAITING',
    status: 'COMPLETED',
    requiresProduction: false,
    items: [{ product: { kind: 'STANDARD' } }],
    corporateUnits: [],
  };
  const tx = {
    salesOrder: {
      findFirst: async () => current,
      update: async ({ data }) => {
        saved = data;
        return { ...current, ...data, notificationEmail: null };
      },
    },
    orderWorkflowEvent: { create: async () => ({}) },
  };
  const service = new OrdersService({ $transaction: async (callback) => callback(tx) }, {});
  service.lockSalesOrder = async () => {};
  service.findOne = async () => ({ id: current.id });
  const admin = { id: 'admin', memberships: [{ tenantId: 'tenant', role: 'ADMIN' }] };
  const worker = { id: 'worker', memberships: [{ tenantId: 'tenant', role: 'WAREHOUSE_KEEPER' }] };
  await service.updateWorkflow('tenant', admin, current.id, { requiresProduction: true });
  assert.equal(saved.requiresProduction, true);
  assert.equal(saved.productionStage, undefined);
  assert.equal(current.items[0].product.kind, 'STANDARD');
  await assert.rejects(
    service.updateWorkflow('tenant', worker, current.id, { requiresProduction: true }),
    /Fábrica solo puede iniciar o terminar/,
  );
});
