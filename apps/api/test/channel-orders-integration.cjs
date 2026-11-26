// Pruebas E2E de POST /channel/orders. Requiere el API compilado corriendo contra una base LOCAL de ensayo (nunca Supabase).
//   DATABASE_URL=<base local> CHANNEL_API_SECRET=<secreto del API> [API=http://127.0.0.1:4010] [KEY=verify-key] node test/channel-orders-integration.cjs
// Crea pedidos sinteticos (clientes 'PRUEBA ...'); usar una copia desechable de la base.
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@qorvex/database');
const docs = require('../dist/common/utils/dominican-documents.js');
const { loadProductionBoard } = require('../dist/modules/orders/production-board.query.js');

const API = process.env.API || 'http://127.0.0.1:4010';
const KEY = process.env.KEY || 'verify-key';
const SECRET = (process.env.CHANNEL_API_SECRET || '').trim();
if (!SECRET || !/(127\.0\.0\.1|localhost)/.test(API) || !/(127\.0\.0\.1|localhost)/.test(process.env.DATABASE_URL || '')) throw new Error('Define CHANNEL_API_SECRET y usa solo API y base locales.');
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const ok = (m) => console.log('  PASS ' + m);
const step = (m) => console.log('\n== ' + m);

const sign = (method, path, body) => {
  const ts = String(Math.floor(Date.now() / 1000)), nonce = crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', SECRET).update(['v1', ts, nonce, method, path, crypto.createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
  return { 'x-channel-key-id': KEY, 'x-channel-timestamp': ts, 'x-channel-nonce': nonce, 'x-channel-signature': sig };
};
async function post(payload, { signed = true } = {}) {
  const body = JSON.stringify(payload);
  const r = await fetch(API + '/channel/orders', { method: 'POST', headers: { 'content-type': 'application/json', ...(signed ? sign('POST', '/channel/orders', body) : {}) }, body });
  let j = null; try { j = await r.json(); } catch {}
  return { s: r.status, j };
}
const ref = () => 'ref_' + crypto.randomBytes(12).toString('hex');
const customer = (name, phone, extra = {}) => ({ name, phone, ...extra });
const mk = (over = {}) => ({ reference: ref(), customer: customer('PRUEBA Cliente Sintetico', '809-555-0101'), delivery: { method: 'PICKUP' }, items: [{ variantId: 'UP-P-0110-V01', quantity: 1 }], ...over });
const prod = (variantId) => prisma.product.findFirst({ where: { legacyEcommerceVariantId: variantId } });

(async () => {
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'hotel-ancla' } });
  const baseline = {
    orders: await prisma.salesOrder.count(), invoices: await prisma.invoice.count(), payments: await prisma.payment.count(),
    movements: await prisma.inventoryMovement.count(), jobs: await prisma.inventorySyncJob.count(), customers: await prisma.customer.count(),
  };

  step('1. Seguridad del canal');
  assert.equal((await post(mk(), { signed: false })).s, 401); ok('sin firma -> 401');
  const tampered = await post(mk({ items: [{ variantId: 'UP-P-0110-V01', quantity: 1, unitPrice: 1 }] }));
  assert.equal(tampered.s, 400); ok('un precio enviado por el cliente se rechaza (400), nunca se acepta');
  const totalField = await post({ ...mk(), total: 1 });
  assert.equal(totalField.s, 400); ok('un total enviado por el cliente se rechaza (400)');
  assert.equal(await prisma.salesOrder.count(), baseline.orders); ok('las solicitudes rechazadas no crean pedidos');

  step('2. Pedido de recogida con personalización');
  const before = await prod('UP-P-0110-V01');
  const first = mk({ items: [{ variantId: 'UP-P-0110-V01', quantity: 2, note: 'Grabar: Ana & Luis 14.02' }], notes: 'Pasaré por la tienda el sábado' });
  const r1 = await post(first);
  assert.equal(r1.s, 201, JSON.stringify(r1.j)); assert.match(r1.j.orderNumber, /^WEB-\d{8}-[0-9A-F]{6}$/); assert.equal(r1.j.duplicate, false);
  ok('201 con referencia ' + r1.j.orderNumber);
  const order = await prisma.salesOrder.findFirst({ where: { orderNumber: r1.j.orderNumber }, include: { items: true, invoice: true, customer: true, workflowEvents: true } });
  assert.equal(order.source, 'ECOMMERCE'); assert.equal(order.status, 'SENT_TO_CASHIER'); assert.equal(order.destination, 'CASH_SALE'); assert.equal(order.externalOrderId, first.reference);
  assert.equal(order.deliveryMethod, 'PICKUP'); assert.equal(order.deliveryAddress, null); assert.equal(order.productionStage, 'WAITING'); assert.equal(order.requiresProduction, false);
  ok('source ECOMMERCE, SENT_TO_CASHIER, PICKUP, etapa WAITING, sin enviar a Fábrica');
  assert.equal(order.invoice.status, 'DRAFT'); assert.equal(Number(order.invoice.paidAmount), 0); assert.match(order.invoice.invoiceNumber, /^PEND-/);
  assert.equal(await prisma.payment.count(), baseline.payments); ok('factura en borrador PEND-, sin pagos');
  const line = order.items[0]; assert.equal(Number(line.unitPrice), Number(before.price)); assert.equal(Number(line.quantity), 2);
  assert.deepEqual(line.personalization, { instructions: 'Grabar: Ana & Luis 14.02' }); ok('precio tomado del ERP (' + before.price + ') y personalización conservada');
  assert.equal(Number(order.subtotal), Number(before.price) * 2); assert.equal(Number(order.total), Number(order.subtotal) + Number(order.taxTotal)); ok('totales calculados por el ERP (ITBIS según su regla): total=' + order.total);
  const after = await prod('UP-P-0110-V01');
  assert.equal(after.reservedStock - before.reservedStock, 2); assert.equal(after.stock, before.stock); ok('reserva +2 y stock físico sin cambios');
  assert.equal(await prisma.inventoryMovement.count(), baseline.movements); ok('sin movimientos de inventario');
  assert.ok(order.workflowEvents.length === 1 && /e-commerce/i.test(order.workflowEvents[0].note)); ok('evento de trazabilidad creado');
  assert.match(order.productionNotes, /e-commerce/); assert.match(order.productionNotes, /Personalización · .*Ana & Luis/); ok('notas del tablero incluyen origen y personalización');
  const board = await loadProductionBoard(prisma, tenant.id);
  const onBoard = board.find((o) => o.orderNumber === r1.j.orderNumber);
  assert.ok(onBoard); assert.equal(onBoard.source, 'ECOMMERCE'); assert.equal(onBoard.productionStage, 'WAITING'); assert.equal(onBoard.items[0].personalization.instructions, 'Grabar: Ana & Luis 14.02');
  ok('aparece en el tablero de seguimiento (origen ECOMMERCE, Espera) con su personalización');

  step('3. Idempotencia');
  const again = await post(first);
  assert.equal(again.s, 200); assert.equal(again.j.duplicate, true); assert.equal(again.j.orderNumber, r1.j.orderNumber); ok('mismo reference -> 200, mismo pedido');
  const afterAgain = await prod('UP-P-0110-V01'); assert.equal(afterAgain.reservedStock, after.reservedStock); ok('no se reserva dos veces');
  const parRef = ref(); const results = await Promise.all(Array.from({ length: 6 }, () => post(mk({ reference: parRef, items: [{ variantId: 'UP-P-0063-V01', quantity: 1 }] }))));
  assert.equal(results.filter((x) => x.s === 201).length, 1); assert.ok(results.every((x) => x.s === 201 || x.s === 200)); assert.equal(await prisma.salesOrder.count({ where: { externalOrderId: parRef } }), 1);
  ok('6 envíos simultáneos con el mismo reference -> exactamente 1 pedido');

  step('4. Cliente: sin duplicados');
  const sameCustomer = await post(mk({ customer: customer('prueba cliente sintetico', '(809) 555-0101'), items: [{ variantId: 'UP-P-0075-V01', quantity: 1 }] }));
  assert.equal(sameCustomer.s, 201);
  const o2 = await prisma.salesOrder.findFirst({ where: { orderNumber: sameCustomer.j.orderNumber } });
  assert.equal(o2.customerId, order.customerId); ok('mismo nombre y teléfono (otro formato) -> mismo cliente');
  let doc; do { doc = String(crypto.randomInt(0, 1e10)).padStart(10, '0') + '0'; for (let d = 0; d < 10; d++) { const c = doc.slice(0, 10) + d; if (docs.validateDominicanCedula(c)) { doc = c; break; } } } while (!docs.validateDominicanCedula(doc));
  const withDoc = await post(mk({ customer: customer('PRUEBA Con Cedula', '809-555-0102', { documentNumber: doc, email: 'prueba@example.test' }), items: [{ variantId: 'UP-P-0075-V02', quantity: 1 }] }));
  assert.equal(withDoc.s, 201); const withDoc2 = await post(mk({ customer: customer('PRUEBA Con Cedula', '809-555-0102', { documentNumber: doc }), items: [{ variantId: 'UP-P-0075-V02', quantity: 1 }] }));
  const c1 = await prisma.salesOrder.findFirst({ where: { orderNumber: withDoc.j.orderNumber } }), c2 = await prisma.salesOrder.findFirst({ where: { orderNumber: withDoc2.j.orderNumber } });
  assert.equal(c1.customerId, c2.customerId); const cust = await prisma.customer.findUnique({ where: { id: c1.customerId } }); assert.equal(cust.documentType, 'CEDULA'); assert.equal(cust.documentNumber, doc);
  ok('con cédula válida -> cliente CEDULA único, reutilizado en el segundo pedido');
  const badDoc = await post(mk({ customer: customer('PRUEBA Cedula Mala', '809-555-0103', { documentNumber: '00112345679' }) }));
  assert.equal(badDoc.s, 422); ok('cédula inválida -> 422');

  step('5. Delivery');
  const noAddr = await post(mk({ delivery: { method: 'DELIVERY' } })); assert.equal(noAddr.s, 422); ok('delivery sin dirección -> 422');
  const del = await post(mk({ delivery: { method: 'DELIVERY', address: 'Calle Prueba 12, Ensanche Test, Santo Domingo', addressReference: 'Casa azul' }, items: [{ variantId: 'UP-P-0161-V01', quantity: 1 }] }));
  assert.equal(del.s, 201); const od = await prisma.salesOrder.findFirst({ where: { orderNumber: del.j.orderNumber } });
  assert.equal(od.deliveryMethod, 'DELIVERY'); assert.match(od.deliveryAddress, /Calle Prueba 12.*Casa azul/); assert.equal(od.deliveryPhone, '809-555-0101'); assert.equal(od.dispatchLocation, 'STORE');
  ok('delivery guarda dirección, referencia y teléfono');
  assert.equal(Number(od.taxTotal) >= 0, true);

  step('6. Reglas comerciales');
  const unknown = await post(mk({ items: [{ variantId: 'NO-EXISTE-V01', quantity: 1 }] })); assert.equal(unknown.s, 422); assert.equal(unknown.j.code, 'VARIANT_UNAVAILABLE'); ok('variante inexistente -> 422 VARIANT_UNAVAILABLE');
  await prisma.webProduct.updateMany({ where: { legacyEcommerceId: 'UP-P-0063' }, data: { published: false } });
  const unpub = await post(mk({ items: [{ variantId: 'UP-P-0063-V02', quantity: 1 }] })); assert.equal(unpub.s, 422); ok('variante de un grupo no publicado -> 422');
  await prisma.webProduct.updateMany({ where: { legacyEcommerceId: 'UP-P-0063' }, data: { published: true } });
  const pBefore = await prod('UP-P-0022-V01'); const over = await post(mk({ items: [{ variantId: 'UP-P-0022-V01', quantity: 20 }] }));
  assert.equal(over.s, 409); assert.equal(over.j.code, 'INSUFFICIENT_STOCK'); const pAfter = await prod('UP-P-0022-V01'); assert.equal(pAfter.reservedStock, pBefore.reservedStock); ok('cantidad mayor al stock -> 409 y sin reservar');
  const q0 = await post(mk({ items: [{ variantId: 'UP-P-0110-V01', quantity: 0 }] })); assert.equal(q0.s, 400); ok('cantidad 0 -> 400');

  step('7. Sin efectos laterales');
  assert.equal(await prisma.payment.count(), baseline.payments); assert.equal(await prisma.inventoryMovement.count(), baseline.movements); const jobs = await prisma.inventorySyncJob.findMany();
  // La reserva de stock del ERP encola un aviso de inventario por producto (igual que cualquier orden). Con
  // SHOPIFY_SYNC_DISABLED=true nunca se procesan: sin intentos, sin errores y sin eventos de Shopify.
  assert.ok(jobs.length >= baseline.jobs && jobs.every((j) => j.attempts === 0 && j.error === null)); assert.equal(await prisma.shopifyEvent.count(), 0);
  const sh = await prisma.salesOrder.count({ where: { source: 'SHOPIFY' } }); assert.equal(sh, 0); ok('0 pagos de pedidos web, 0 movimientos de inventario, avisos de inventario sin procesar, 0 pedidos Shopify');
  const created = await prisma.salesOrder.count({ where: { source: 'ECOMMERCE' } }); console.log('  pedidos ECOMMERCE creados en el ensayo:', created);
  await prisma.$disconnect();
  console.log('\nTODAS LAS PRUEBAS PASARON');
})().catch(async (e) => { console.error('\nFALLO:', e.message); await prisma.$disconnect(); process.exit(1); });
