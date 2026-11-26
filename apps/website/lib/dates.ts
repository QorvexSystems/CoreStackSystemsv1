// Fechas como claves AAAA-MM-DD (fecha local del hotel), sin depender de la zona del navegador.
const DAY_MS = 86_400_000;

export const addDays = (key: string, days: number) =>
  new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export const monthStart = (key: string) => `${key.slice(0, 7)}-01`;

export const addMonths = (key: string, months: number) => {
  const date = new Date(`${monthStart(key)}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
};

const asDate = (key: string) => new Date(`${key}T12:00:00Z`);

export const formatShort = (key: string) =>
  new Intl.DateTimeFormat('es-DO', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(asDate(key));

export const formatLong = (key: string) =>
  new Intl.DateTimeFormat('es-DO', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(asDate(key));

export const formatMonth = (key: string) =>
  new Intl.DateTimeFormat('es-DO', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    asDate(key),
  );

/** 0 = lunes … 6 = domingo. */
export const weekdayIndex = (key: string) => (asDate(key).getUTCDay() + 6) % 7;

export const money = (value: number) =>
  `RD$${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;

export const moneyShort = (value: number) =>
  `RD$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)}`;
