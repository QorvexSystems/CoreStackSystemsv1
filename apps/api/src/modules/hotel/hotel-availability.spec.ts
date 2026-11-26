import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hotelDateKey,
  hotelInstant,
  nightlyAvailability,
  quoteStay,
  stayNights,
  validateWebStay,
  earlyCheckoutCredit,
  webTaxRate,
} from './hotel-availability';

const at = (key: string, hour: number) => hotelInstant(key, hour);

test('hotelInstant usa hora de Santo Domingo (UTC-4)', () => {
  assert.equal(at('2026-10-16', 15).toISOString(), '2026-10-16T19:00:00.000Z');
  assert.equal(hotelDateKey(at('2026-10-16', 23)), '2026-10-16');
  assert.equal(hotelDateKey(at('2026-10-16', 0)), '2026-10-16');
});

test('una estadía ocupa [llegada, salida) y como mínimo una noche', () => {
  assert.deepEqual(stayNights(at('2026-10-16', 15), at('2026-10-18', 11)), {
    first: '2026-10-16',
    endExclusive: '2026-10-18',
  });
  assert.deepEqual(stayNights(at('2026-10-16', 9), at('2026-10-16', 18)), {
    first: '2026-10-16',
    endExclusive: '2026-10-17',
  });
});

test('reservas consecutivas no se solapan; las superpuestas consumen inventario', () => {
  const rooms = new Map([['std', 2], ['suite', 1]]);
  const result = nightlyAvailability(
    rooms,
    [
      { roomTypeId: 'std', checkIn: at('2026-10-16', 15), checkOut: at('2026-10-18', 11) },
      { roomTypeId: 'std', checkIn: at('2026-10-17', 15), checkOut: at('2026-10-19', 11) },
      { roomTypeId: 'suite', checkIn: at('2026-10-14', 15), checkOut: at('2026-10-17', 11) },
      { roomTypeId: 'suite', checkIn: at('2026-10-17', 15), checkOut: at('2026-10-18', 11) },
      { roomTypeId: 'otro', checkIn: at('2026-10-16', 15), checkOut: at('2026-10-18', 11) },
    ],
    '2026-10-15',
    5,
  );
  //                              15 16 17 18 19
  assert.deepEqual(result.get('std'), [2, 1, 0, 1, 2]);
  assert.deepEqual(result.get('suite'), [0, 0, 0, 1, 1]);
  assert.equal(result.has('otro'), false);
});

test('la sobreventa nunca devuelve cupos negativos', () => {
  const result = nightlyAvailability(
    new Map([['std', 1]]),
    [
      { roomTypeId: 'std', checkIn: at('2026-10-16', 15), checkOut: at('2026-10-17', 11) },
      { roomTypeId: 'std', checkIn: at('2026-10-16', 15), checkOut: at('2026-10-17', 11) },
    ],
    '2026-10-16',
    1,
  );
  assert.deepEqual(result.get('std'), [0]);
});

test('validateWebStay aplica las reglas del sitio', () => {
  const today = '2026-10-10';
  assert.deepEqual(validateWebStay('2026-10-16', '2026-10-18', today), { ok: true, nights: 2 });
  assert.equal(validateWebStay('2026-10-09', '2026-10-11', today).ok, false);
  assert.equal(validateWebStay('2026-10-16', '2026-10-16', today).ok, false);
  assert.equal(validateWebStay('2026-10-16', '2026-12-16', today).ok, false);
  assert.equal(validateWebStay('2026-02-30', '2026-03-02', today).ok, false);
  assert.equal(validateWebStay('2027-12-01', '2027-12-02', today).ok, false);
});

test('quoteStay y la tasa configurable', () => {
  assert.deepEqual(quoteStay(3800, 2, 0.18), {
    nightlyRate: 3800,
    nights: 2,
    subtotal: 7600,
    taxRate: 0.18,
    taxes: 1368,
    total: 8968,
  });
  assert.equal(webTaxRate({}), 0.18);
  assert.equal(webTaxRate({ HOTEL_WEB_TAX_RATE: '0' }), 0);
  assert.equal(webTaxRate({ HOTEL_WEB_TAX_RATE: 'abc' }), 0.18);
});

test('check-out anticipado: crédito por noches pagadas y no usadas', () => {
  const stay = { checkIn: at('2026-11-20', 15), checkOut: at('2026-11-24', 11), totalAmount: 12000, paidAmount: 12000 };
  // 4 noches pagadas; sale el 22 por la mañana → usó 2, quedan 2 × 3000.
  assert.deepEqual(earlyCheckoutCredit(stay, at('2026-11-22', 9)), { nights: 2, amount: 6000 });
  // Sale el mismo día que llegó: cuenta 1 noche usada.
  assert.deepEqual(earlyCheckoutCredit(stay, at('2026-11-20', 18)), { nights: 3, amount: 9000 });
  // En la fecha acordada o después: sin crédito.
  assert.equal(earlyCheckoutCredit(stay, at('2026-11-24', 10)), null);
  // Solo se acredita lo pagado.
  assert.deepEqual(earlyCheckoutCredit({ ...stay, paidAmount: 6000 }, at('2026-11-23', 9)), { nights: 1, amount: 1500 });
});
