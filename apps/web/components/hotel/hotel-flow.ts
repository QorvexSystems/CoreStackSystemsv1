import type { HotelReservation } from '@/lib/api';

export const reservationStatusLabels: Record<string, string> = {
  PENDING_REVIEW: 'Pendiente de revisión',
  CONFIRMED: 'Confirmada',
  ASSIGNED: 'Habitación asignada',
  CHECKED_IN: 'En estadía',
  CHECKED_OUT: 'Check-out completado',
  CANCELLED: 'Cancelada',
  NO_SHOW: 'No se presentó',
};

export const reservationStatusTones: Record<string, string> = {
  PENDING_REVIEW: 'bg-amber-100 text-amber-800',
  CONFIRMED: 'bg-sky-100 text-sky-800',
  ASSIGNED: 'bg-teal-light text-teal-deep',
  CHECKED_IN: 'bg-emerald-100 text-emerald-800',
  CHECKED_OUT: 'bg-slate-100 text-slate-700',
  CANCELLED: 'bg-rose-100 text-rose-700',
  NO_SHOW: 'bg-orange-100 text-orange-800',
};

export const roomStatusLabels: Record<string, string> = {
  AVAILABLE: 'Disponible',
  RESERVED: 'Reservada',
  OCCUPIED: 'Ocupada',
  CLEANING: 'Pendiente de limpieza',
  MAINTENANCE: 'Fuera de servicio',
  OUT_OF_SERVICE: 'Fuera de servicio',
};

export const roomStatusTones: Record<string, string> = {
  AVAILABLE: 'bg-emerald-50 text-emerald-700',
  RESERVED: 'bg-sky-50 text-sky-700',
  OCCUPIED: 'bg-teal-light text-teal-deep',
  CLEANING: 'bg-amber-50 text-amber-700',
  MAINTENANCE: 'bg-rose-50 text-rose-700',
  OUT_OF_SERVICE: 'bg-rose-50 text-rose-700',
};

export function formatMoney(value: string | number) {
  return new Intl.NumberFormat('es-DO', {
    style: 'currency',
    currency: 'DOP',
    minimumFractionDigits: 2,
  }).format(Number(value));
}

export function formatStayDate(value: string) {
  return new Intl.DateTimeFormat('es-DO', { day: 'numeric', month: 'short' }).format(
    new Date(value),
  );
}

export function formatStayDateTime(value: string) {
  return new Intl.DateTimeFormat('es-DO', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatStayTime(value: string) {
  return new Intl.DateTimeFormat('es-DO', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function reservationBalance(reservation: HotelReservation) {
  return Math.max(0, Number(reservation.totalAmount) - Number(reservation.paidAmount));
}

export function canCollectReservationPayment(reservation: HotelReservation, now = new Date()) {
  return hotelDateKey(now) >= hotelDateKey(new Date(reservation.checkIn));
}

export function hotelDateKey(value: Date) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function nightsBetween(checkIn: string, checkOut: string) {
  return Math.max(
    1,
    Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86_400_000),
  );
}

/** Horario fijo del hotel. */
export const CHECK_IN_HOUR = 15;
export const CHECK_OUT_HOUR = 11;
/** Una hora después de la salida sin check-out: alerta emergente y tarjeta en rojo. */
export const CHECK_OUT_OVERDUE_HOUR = 12;
/** A esta hora una llegada sin check-in pasa a "No se presentaron". */
export const NO_SHOW_HOUR = 21;

/** Instante real de un día del hotel a cierta hora (Santo Domingo es UTC-4 todo el año). */
export function hotelMoment(dayKey: string, hour: number) {
  return new Date(`${dayKey}T${String(hour).padStart(2, '0')}:00:00-04:00`);
}

/** Estado de la salida de un huésped alojado: 'due' desde las 11:00 AM, 'overdue' desde las 12:00 PM. */
export function checkoutAlert(reservation: HotelReservation, now = new Date()): 'due' | 'overdue' | null {
  if (reservation.status !== 'CHECKED_IN') return null;
  const day = hotelDateKey(new Date(reservation.checkOut));
  if (now >= hotelMoment(day, CHECK_OUT_OVERDUE_HOUR)) return 'overdue';
  if (now >= hotelMoment(day, CHECK_OUT_HOUR)) return 'due';
  return null;
}

/** Ya pasaron las 9:00 PM del día de llegada sin check-in (el servidor la mueve a "No se presentaron"). */
export function isPastNoShowDeadline(reservation: HotelReservation, now = new Date()) {
  return (
    ['PENDING_REVIEW', 'CONFIRMED', 'ASSIGNED'].includes(reservation.status) &&
    !reservation.noShowRecoveredAt &&
    now >= hotelMoment(hotelDateKey(new Date(reservation.checkIn)), NO_SHOW_HOUR)
  );
}

/** Un cobro hecho en recepción impide borrar la reservación (sí se borran los pagos simulados de la web). */
export function hasReceptionPayment(reservation: HotelReservation) {
  return (reservation.payments ?? []).some(
    (payment) => !(payment.method === 'CARD' && payment.notes?.startsWith('Pago en línea')),
  );
}

/** Se puede eliminar antes del check-in y sin cobros de recepción. */
export function canDeleteReservation(reservation: HotelReservation) {
  return (
    ['PENDING_REVIEW', 'CONFIRMED', 'ASSIGNED', 'NO_SHOW', 'CANCELLED'].includes(reservation.status) &&
    !hasReceptionPayment(reservation)
  );
}
