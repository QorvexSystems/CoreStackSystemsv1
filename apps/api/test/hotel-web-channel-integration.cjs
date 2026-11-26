// Pruebas E2E del canal del sitio web del hotel (/channel/hotel/*). Requiere el API compilado corriendo
// contra una base LOCAL desechable con `db:seed` + `db:seed:demo` (nunca Supabase):
//   DATABASE_URL=<base local> CHANNEL_API_SECRET=<secreto> [API=http://127.0.0.1:4010] [KEY=web-e2e]
//   [ADMIN_EMAIL=admin@hotelancla.local ADMIN_PASSWORD=<SEED_HOTEL_ADMIN_PASSWORD>] node test/hotel-web-channel-integration.cjs
// Crea reservaciones sintéticas (huéspedes 'PRUEBA ...') a más de 200 días para no tocar la operación demo.
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@qorvex/database');

const API = process.env.API || 'http://127.0.0.1:4010';
const KEY = process.env.KEY || 'web-e2e';
const SECRET = (process.env.CHANNEL_API_SECRET || '').trim();
const local = (value) => /(127\.0\.0\.1|localhost)/.test(value || '');
if (!SECRET || !local(API) || !local(process.env.DATABASE_URL))
  throw new Error('Define CHANNEL_API_SECRET y usa solo API y base locales.');
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const ok = (message) => console.log('  PASS ' + message);
const step = (message) => console.log('\n== ' + message);

const sign = (method, path, body) => {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const signature = crypto.createHmac('sha256', SECRET).update(['v1', ts, nonce, method, path, digest].join('\n')).digest('hex');
  return { 'x-channel-key-id': KEY, 'x-channel-timestamp': ts, 'x-channel-nonce': nonce, 'x-channel-signature': signature };
};
async function call(method, path, payload, { signed = true } = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const response = await fetch(API + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(signed ? sign(method, path, body) : {}) },
    body: body || undefined,
  });
  let json = null;
  try { json = await response.json(); } catch {}
  return { s: response.status, j: json };
}
const get = (path, opts) => call('GET', path, undefined, opts);
const reserve = (payload) => call('POST', '/channel/hotel/reservations', payload);

const addDays = (key, days) => new Date(Date.parse(key + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const ref = () => 'ref_' + crypto.randomBytes(12).toString('hex');
let guestSeq = 0;
const booking = (roomTypeId, checkIn, checkOut, over = {}) => ({
  reference: ref(), roomTypeId, checkIn, checkOut, adults: 1, children: 0,
  firstName: 'PRUEBA', lastName: 'Web ' + ++guestSeq, email: `prueba.web.${Date.now()}.${guestSeq}@example.com`, phone: '809-555-0101',
  paymentMethod: 'CARD', cardLast4: '4242', cardBrand: 'Visa',
  ...over,
});

(async () => {
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'hotel-ancla' } });
  assert.ok(tenant, 'tenant hotel-ancla');

  step('1. Seguridad');
  assert.equal((await get('/channel/hotel/catalog', { signed: false })).s, 401); ok('sin firma -> 401');
  const catalog = await get('/channel/hotel/catalog');
  assert.equal(catalog.s, 200, JSON.stringify(catalog.j));
  assert.equal(catalog.j.bookingEnabled, true);
  assert.ok(catalog.j.roomTypes.length >= 1);
  assert.ok(!JSON.stringify(catalog.j).includes('"number"'), 'no expone números de habitación');
  ok(`catálogo con ${catalog.j.roomTypes.length} tipos, tasa ${catalog.j.taxRate}, sin números de habitación`);

  const today = catalog.j.today;
  const base = addDays(today, 200 + Math.floor(Math.random() * 100));
  const type = catalog.j.roomTypes.find((item) => item.name === 'Suite Junior') ?? catalog.j.roomTypes[0];
  const sellable = await prisma.hotelRoom.count({ where: { tenantId: tenant.id, roomTypeId: type.id, status: { notIn: ['MAINTENANCE', 'OUT_OF_SERVICE'] } } });
  const already = await prisma.hotelReservation.count({ where: { tenantId: tenant.id, roomTypeId: type.id, status: { notIn: ['CANCELLED', 'NO_SHOW', 'CHECKED_OUT'] }, checkIn: { lt: new Date(addDays(base, 4) + 'T23:00:00Z') }, checkOut: { gt: new Date(base + 'T00:00:00Z') } } });
  assert.equal(already, 0, 'ventana de prueba sin reservas previas');
  console.log(`  tipo ${type.name}: ${sellable} habitaciones vendibles; estadía de prueba ${base} → ${addDays(base, 2)}`);

  const tampered = await reserve({ ...booking(type.id, base, addDays(base, 2)), totalAmount: 1 });
  assert.equal(tampered.s, 400); ok('un total enviado por el cliente se rechaza (400)');
  const { paymentMethod: _omit, ...unpaid } = booking(type.id, base, addDays(base, 2));
  assert.equal((await reserve(unpaid)).s, 400); ok('una reserva sin pago se rechaza (400)');
  assert.equal((await reserve(booking(type.id, addDays(today, -1), today))).s, 400); ok('fecha pasada -> 400');
  assert.equal((await reserve(booking(type.id, base, base))).s, 400); ok('salida igual a llegada -> 400');
  assert.equal((await reserve(booking(type.id, base, addDays(base, 2), { adults: type.capacityAdults + 1 }))).s, 400); ok('exceder capacidad -> 400');

  step('2. Disponibilidad y precio');
  const availability = await get(`/channel/hotel/availability?checkIn=${base}&checkOut=${addDays(base, 2)}&adults=1`);
  assert.equal(availability.s, 200, JSON.stringify(availability.j));
  const row = availability.j.roomTypes.find((item) => item.roomTypeId === type.id);
  assert.equal(row.available, sellable);
  const expectedTotal = Math.round(type.nightlyRate * 2 * (1 + catalog.j.taxRate) * 100) / 100;
  assert.equal(row.quote.total, expectedTotal);
  ok(`disponibles ${row.available}, total 2 noches ${row.quote.total}`);

  step('3. Creación en el ERP con canal Sitio Web');
  const first = booking(type.id, base, addDays(base, 2), { arrivalTime: '18:00', notes: 'PRUEBA cuna adicional' });
  const created = await reserve(first);
  assert.equal(created.s, 201, JSON.stringify(created.j));
  assert.match(created.j.code, /^AN-\d{5}$/);
  const stored = await prisma.hotelReservation.findFirst({ where: { tenantId: tenant.id, code: created.j.code }, include: { channel: true, guest: true, payments: true } });
  assert.equal(stored.channel.type, 'DIRECT_WEB');
  assert.equal(stored.status, 'PENDING_REVIEW');
  assert.equal(stored.paymentStatus, 'PAID');
  assert.equal(Number(stored.paidAmount), expectedTotal);
  assert.equal(stored.payments.length, 1);
  assert.equal(stored.payments[0].method, 'CARD');
  assert.equal(Number(stored.payments[0].amount), expectedTotal);
  assert.equal(stored.payments[0].receiptNumber, 'NV-' + created.j.code);
  assert.match(stored.payments[0].notes, /Sitio web \(simulado\).*4242/);
  assert.equal(stored.roomId, null);
  assert.equal(Number(stored.totalAmount), expectedTotal);
  assert.equal(stored.arrivalTime, '18:00');
  assert.equal(stored.sourceReference, 'web:' + first.reference);
  assert.equal(stored.checkIn.toISOString(), base + 'T19:00:00.000Z');
  assert.equal(stored.checkOut.toISOString(), addDays(base, 2) + 'T15:00:00.000Z');
  ok(`${created.j.code} en canal "${stored.channel.name}", SOLICITUD (PENDING_REVIEW) + PAID (${stored.payments[0].receiptNumber}), total ${stored.totalAmount}, llegada 15:00 / salida 11:00`);

  const again = await reserve(first);
  assert.equal(again.s, 200); assert.equal(again.j.duplicate, true); assert.equal(again.j.code, created.j.code);
  assert.equal(await prisma.hotelReservation.count({ where: { tenantId: tenant.id, sourceReference: 'web:' + first.reference } }), 1);
  ok('reintento con la misma referencia -> 200 duplicate, sin duplicar');

  step('4. Sin sobreventa (incluye solicitudes simultáneas)');
  const remaining = sellable - 1;
  const burst = await Promise.all(Array.from({ length: remaining + 3 }, () => reserve(booking(type.id, addDays(base, 1), addDays(base, 3)))));
  const accepted = burst.filter((item) => item.s === 201).length;
  const rejected = burst.filter((item) => item.s === 409);
  assert.equal(accepted, remaining, JSON.stringify(burst.map((item) => item.s)));
  assert.equal(rejected.length, 3);
  assert.equal(rejected[0].j.code, 'SOLD_OUT');
  ok(`${remaining + 3} solicitudes simultáneas: ${accepted} aceptadas, 3 rechazadas con 409 SOLD_OUT`);

  const full = await get(`/channel/hotel/availability?checkIn=${addDays(base, 1)}&checkOut=${addDays(base, 2)}`);
  assert.equal(full.j.roomTypes.find((item) => item.roomTypeId === type.id).available, 0); ok('la noche llena muestra 0 disponibles');

  const calendar = await get(`/channel/hotel/calendar?from=${base}&days=5`);
  const nights = calendar.j.roomTypes.find((item) => item.roomTypeId === type.id).available;
  assert.deepEqual(nights, [sellable - 1, 0, sellable - remaining, sellable, sellable]);
  ok('calendario por noche: ' + JSON.stringify(nights));

  const overlap = await reserve(booking(type.id, addDays(base, -1), addDays(base, 2)));
  assert.equal(overlap.s, 409); ok('una estadía que cruza la noche llena -> 409');
  const backToBack = await reserve(booking(type.id, addDays(base, 3), addDays(base, 4)));
  assert.equal(backToBack.s, 201); ok('llegada el mismo día de la salida (back-to-back) -> 201');

  step('5. El ERP también respeta el inventario');
  if (process.env.ADMIN_PASSWORD) {
    const login = await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.ADMIN_EMAIL || 'admin@hotelancla.local', password: process.env.ADMIN_PASSWORD }) });
    const session = await login.json();
    const token = session.accessToken || session.access_token || session.token;
    assert.ok(token, 'login ERP');
    const channel = await prisma.hotelChannel.findFirst({ where: { tenantId: tenant.id, type: 'WALK_IN' } });
    const erpCreate = await fetch(API + '/hotel/reservations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-tenant-id': tenant.id },
      body: JSON.stringify({ firstName: 'PRUEBA', lastName: 'Recepcion', roomTypeId: type.id, channelId: channel.id, checkIn: addDays(base, 1) + 'T15:00:00-04:00', checkOut: addDays(base, 2) + 'T11:00:00-04:00', adults: 1, totalAmount: 100 }),
    });
    assert.equal(erpCreate.status, 400, await erpCreate.text()); ok('recepción no puede sobrevender la noche llena -> 400');
    const listed = await fetch(API + '/hotel/reservations', { headers: { authorization: 'Bearer ' + token, 'x-tenant-id': tenant.id } }).then((r) => r.json());
    const mine = listed.find((item) => item.code === created.j.code);
    assert.ok(mine && mine.channel.type === 'DIRECT_WEB'); ok(`la reserva web aparece en la cola del ERP con canal "${mine.channel.name}"`);
  } else console.log('  SKIP sin ADMIN_PASSWORD');

  console.log('\nTodas las pruebas pasaron.');
  await prisma.$disconnect();
})().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
