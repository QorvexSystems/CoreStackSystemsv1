// Inventario por tipo de habitación y noche. Puro (sin Nest ni Prisma) para probarlo de forma aislada.
//
// Una reservación ocupa las noches [fecha de llegada, fecha de salida) en hora de Santo Domingo. Una
// reservación sin habitación asignada también consume inventario de su tipo: así una solicitud web
// pendiente de revisión ya bloquea la fecha y nunca se venden más habitaciones de las que existen.

export const HOTEL_TIME_ZONE = 'America/Santo_Domingo';
/** Santo Domingo no tiene horario de verano: UTC-4 todo el año. */
const HOTEL_UTC_OFFSET_HOURS = -4;
export const DEFAULT_CHECK_IN_HOUR = 15;
export const DEFAULT_CHECK_OUT_HOUR = 11;
export const MAX_STAY_NIGHTS = 30;
export const MAX_BOOKING_WINDOW_DAYS = 365;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function hotelDateKey(value: Date): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: HOTEL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function addDays(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Instante real de una fecha local del hotel a cierta hora (p. ej. llegada 15:00, salida 11:00). */
export function hotelInstant(key: string, hour: number): Date {
  return new Date(Date.parse(`${key}T00:00:00Z`) + (hour - HOTEL_UTC_OFFSET_HOURS) * 3_600_000);
}

export type StayNights = { first: string; endExclusive: string };

/** Noches que ocupa una estadía. Una estadía del mismo día ocupa al menos su noche de llegada. */
export function stayNights(checkIn: Date, checkOut: Date): StayNights {
  const first = hotelDateKey(checkIn);
  let endExclusive = hotelDateKey(checkOut);
  if (endExclusive <= first) endExclusive = addDays(first, 1);
  return { first, endExclusive };
}

export type OccupyingReservation = { roomTypeId: string; checkIn: Date; checkOut: Date };

/**
 * Habitaciones libres por tipo y por noche en [from, from + days).
 * `bookableRooms` es el inventario vendible de cada tipo (sin habitaciones fuera de servicio).
 */
export function nightlyAvailability(
  bookableRooms: Map<string, number>,
  reservations: OccupyingReservation[],
  from: string,
  days: number,
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const [roomTypeId, rooms] of bookableRooms) result.set(roomTypeId, Array(days).fill(rooms));
  for (const reservation of reservations) {
    const nights = result.get(reservation.roomTypeId);
    if (!nights) continue;
    const { first, endExclusive } = stayNights(reservation.checkIn, reservation.checkOut);
    const start = Math.max(0, daysBetween(from, first));
    const end = Math.min(days, daysBetween(from, endExclusive));
    for (let index = start; index < end; index += 1) nights[index] -= 1;
  }
  for (const nights of result.values())
    for (let index = 0; index < nights.length; index += 1)
      nights[index] = Math.max(0, nights[index]);
  return result;
}

export type StayValidation = { ok: true; nights: number } | { ok: false; message: string };

/** Reglas de una estadía pedida desde el sitio web, con `today` en hora del hotel. */
export function validateWebStay(checkIn: string, checkOut: string, today: string): StayValidation {
  if (!isDateKey(checkIn) || !isDateKey(checkOut))
    return { ok: false, message: 'Las fechas deben tener el formato AAAA-MM-DD.' };
  if (checkIn < today) return { ok: false, message: 'La fecha de llegada ya pasó.' };
  if (daysBetween(today, checkIn) > MAX_BOOKING_WINDOW_DAYS)
    return {
      ok: false,
      message: `Solo se aceptan reservas hasta ${MAX_BOOKING_WINDOW_DAYS} días de anticipación.`,
    };
  const nights = daysBetween(checkIn, checkOut);
  if (nights < 1) return { ok: false, message: 'La salida debe ser posterior a la llegada.' };
  if (nights > MAX_STAY_NIGHTS)
    return { ok: false, message: `La estadía máxima en línea es de ${MAX_STAY_NIGHTS} noches.` };
  return { ok: true, nights };
}

/** Montos en RD$ redondeados a centavos. El total es lo que el ERP cobrará. */
export function quoteStay(nightlyRate: number, nights: number, taxRate: number) {
  const round = (value: number) => Math.round(value * 100) / 100;
  const subtotal = round(nightlyRate * nights);
  const taxes = round(subtotal * taxRate);
  return { nightlyRate: round(nightlyRate), nights, subtotal, taxRate, taxes, total: round(subtotal + taxes) };
}

/** Tasa de impuestos aplicada a reservas web (`HOTEL_WEB_TAX_RATE`, 0 a 0.5; por defecto 18 % ITBIS). */
export function webTaxRate(env: Record<string, string | undefined>): number {
  const raw = env.HOTEL_WEB_TAX_RATE?.trim();
  if (!raw) return 0.18;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 0.5 ? value : 0.18;
}

/**
 * Crédito por check-out anticipado: noches pagadas y no usadas × tarifa promedio por noche de la reserva.
 * Se cuenta al menos una noche usada (la habitación se ocupó). Fechas en hora del hotel.
 */
export function earlyCheckoutCredit(
  reservation: { checkIn: Date; checkOut: Date; totalAmount: { toString(): string } | number; paidAmount: { toString(): string } | number },
  now: Date,
) {
  const arrival = hotelDateKey(reservation.checkIn);
  const scheduledDeparture = hotelDateKey(reservation.checkOut);
  const today = hotelDateKey(now);
  if (today >= scheduledDeparture) return null;
  const booked = Math.max(1, daysBetween(arrival, scheduledDeparture));
  const used = Math.min(booked, Math.max(1, daysBetween(arrival, today)));
  const nights = booked - used;
  if (nights <= 0) return null;
  const paid = Math.min(Number(String(reservation.paidAmount)), Number(String(reservation.totalAmount)));
  const amount = Math.round(((paid / booked) * nights) * 100) / 100;
  return amount > 0 ? { nights, amount } : null;
}
