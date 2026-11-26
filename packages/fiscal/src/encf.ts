import { assertEcfType, assertScope, scopeKey } from './catalog.ts';
import type { EcfType, FiscalScope } from './catalog.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

export const MAX_ECF_SEQUENCE = 9_999_999_999n;

export function parseSequence(value: string): bigint {
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value)) {
    throw new Error('Sequence must be a decimal string of at most ten digits.');
  }
  const number = BigInt(value);
  if (number < 1n || number > MAX_ECF_SEQUENCE) throw new Error('Sequence out of range.');
  return number;
}

export function formatEncf(type: EcfType, sequence: string): string {
  assertEcfType(type);
  return `E${type}${parseSequence(sequence).toString().padStart(10, '0')}`;
}

export function parseEncf(value: string): { type: EcfType; sequence: string } {
  if (typeof value !== 'string' || !/^E\d{12}$/.test(value)) throw new Error('Invalid e-NCF.');
  const type = Number(value.slice(1, 3));
  assertEcfType(type);
  return { type, sequence: parseSequence(value.slice(3)).toString() };
}

export function assertBusinessDate(value: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Expected ISO business date.');
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid calendar date.');
  }
}

export type AuthorizedRange = Readonly<{
  id: string;
  scope: FiscalScope;
  type: EcfType;
  first: string;
  last: string;
  // null is the explicit exhausted sentinel (never increment past ten digits).
  next: string | null;
  validFrom: string;
  validUntil: string | null;
  authorizationReference: string;
}>;

/** Pure planning only. Persist range update + reservation atomically under a DB lock. */
export function planReservation(range: AuthorizedRange, scope: FiscalScope, date: string) {
  assertScope(scope);
  assertFiscalEnvironmentEnabled(scope);
  assertEcfType(range.type);
  if (scopeKey(range.scope) !== scopeKey(scope)) throw new Error('Fiscal scope mismatch.');
  if (!range.id.trim() || !range.authorizationReference.trim()) {
    throw new Error('An explicit range authorization is required, including in test environments.');
  }
  assertBusinessDate(date);
  assertBusinessDate(range.validFrom);
  if (range.validUntil !== null) {
    assertBusinessDate(range.validUntil);
    if (range.validUntil < range.validFrom) throw new Error('Invalid validity interval.');
  }
  if (date < range.validFrom || (range.validUntil !== null && date > range.validUntil)) {
    throw new Error('Range not valid on the issuance date.');
  }
  const first = parseSequence(range.first);
  const last = parseSequence(range.last);
  if (first > last) throw new Error('Invalid sequence range.');
  if (range.next === null) throw new Error('Sequence range exhausted.');
  const next = parseSequence(range.next);
  if (next < first || next > last) throw new Error('Next sequence outside authorized range.');
  return Object.freeze({
    encf: formatEncf(range.type, range.next),
    next: next === last ? null : (next + 1n).toString(),
    exhausted: next === last,
  });
}
