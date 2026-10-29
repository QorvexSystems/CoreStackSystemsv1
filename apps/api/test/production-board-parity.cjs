const assert = require('node:assert/strict');
const fs = require('node:fs');

if (process.argv.length < 4) {
  throw new Error('Uso: node test/production-board-parity.cjs <antes.json> <después.json>');
}
const previous = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const current = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const card = (order) => ({
  id: order.id,
  orderNumber: order.orderNumber,
  clientName: order.clientName,
  status: order.status,
  source: order.source,
  productionStage: order.productionStage,
  exceptionStatus: order.exceptionStatus,
  priority: order.priority,
  promisedAt: order.promisedAt,
  requiresProduction: order.requiresProduction,
  designApprovedAt: order.designApprovedAt,
  qualityApprovedAt: order.qualityApprovedAt,
  productionNotes: order.productionNotes,
  deliveredAt: order.deliveredAt,
  isCorporate: order.isCorporate,
  deliveryMethod: order.deliveryMethod,
  dispatchLocation: order.dispatchLocation,
  deliveryAddress: order.deliveryAddress,
  deliveryPhone: order.deliveryPhone,
  invoiceId: order.invoiceId,
  total: order.total,
  createdAt: order.createdAt,
  customerName: order.customer?.name ?? null,
  invoiceNumber: order.invoice?.invoiceNumber ?? null,
  items: order.items.map((item) => ({
    id: item.id,
    description: item.description,
    quantity: item.quantity,
    personalization: item.personalization,
  })),
  workflowEvents: order.workflowEvents.map((event) => ({
    id: event.id,
    createdAt: event.createdAt,
    fromStage: event.fromStage,
    toStage: event.toStage,
    note: event.note,
    changedByName: event.changedBy?.name ?? null,
  })),
  corporateUnits: order.corporateUnits.map((unit) => ({
    id: unit.id,
    recipientName: unit.recipientName,
    status: unit.status,
    deliveredAt: unit.deliveredAt,
  })),
});

assert.deepEqual(current.map(card), previous.map(card));
console.log('OK: tarjetas de producción conservan sus datos visibles.');
