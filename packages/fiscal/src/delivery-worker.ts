import { createHash } from 'node:crypto';
import { assertScope, scopeKey, type FiscalScope } from './catalog.ts';
import { parseEncf } from './encf.ts';
import type { FiscalRegistrationConnection } from './request-repository.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

export type DeliveryClaim = Readonly<{
  documentId: string;
  encf: string;
  claimToken: string;
  action: 'SEND' | 'RECONCILE';
  route: 'ECF' | 'RFCE';
  xml: string;
  sha256: string;
  trackId: string | null;
  scope: FiscalScope;
}>;
export type DeliveryOutcome =
  | 'UNCONFIRMED'
  | 'PROCESSING'
  | 'ACCEPTED'
  | 'ACCEPTED_CONDITIONALLY'
  | 'REJECTED'
  | 'REVIEW_REQUIRED';
export type DeliveryObservation = {
  outcome: DeliveryOutcome;
  trackId?: string;
  evidence: Record<string, unknown>;
};
export interface DeliveryGateway {
  /** Implementations MUST verify signature, delegation, XSD, identity and scope. */
  send(claim: DeliveryClaim): Promise<DeliveryObservation>;
  /** Read-only lookup. Never POST from this method, even when no trackId exists. */
  reconcile(claim: DeliveryClaim): Promise<DeliveryObservation>;
}
const ensure = (valid: unknown, code: string): void => {
  if (!valid) throw new Error(code);
};

export function parseDeliveryClaim(value: unknown, scope: FiscalScope): DeliveryClaim {
  assertScope(scope);
  assertFiscalEnvironmentEnabled(scope);
  ensure(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_DELIVERY_CLAIM');
  const c = value as DeliveryClaim;
  ensure(c.scope && scopeKey(c.scope) === scopeKey(scope), 'DELIVERY_SCOPE_MISMATCH');
  ensure(
    typeof c.documentId === 'string' &&
      /^[1-9][0-9]{0,18}$/.test(c.documentId) &&
      typeof c.claimToken === 'string' &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(c.claimToken),
    'INVALID_DELIVERY_ID',
  );
  ensure(
    ['SEND', 'RECONCILE'].includes(c.action) && ['ECF', 'RFCE'].includes(c.route),
    'INVALID_DELIVERY_ACTION',
  );
  const parsed = parseEncf(c.encf);
  ensure(c.route !== 'RFCE' || parsed.type === 32, 'INVALID_DELIVERY_ROUTE');
  ensure(
    c.trackId === null ||
      (typeof c.trackId === 'string' && /^[A-Za-z0-9-]{1,200}$/.test(c.trackId)),
    'INVALID_DELIVERY_TRACK',
  );
  ensure(
    typeof c.xml === 'string' &&
      Buffer.byteLength(c.xml) <= 2097152 &&
      c.xml.length > 0 &&
      !/<!/.test(c.xml) &&
      typeof c.sha256 === 'string' &&
      createHash('sha256').update(c.xml).digest('hex') === c.sha256,
    'INVALID_DELIVERY_ARTIFACT',
  );
  return Object.freeze({ ...c, scope: Object.freeze({ ...c.scope }) });
}

/** Durable DB lease first, network second, fenced acknowledgment last. If saving
 * a result fails, propagate it: lease recovery performs reconciliation, not POST.
 */
export async function runDeliveryOnce(
  db: FiscalRegistrationConnection,
  scope: FiscalScope,
  gateway: DeliveryGateway,
) {
  assertScope(scope);
  assertFiscalEnvironmentEnabled(scope);
  const result = await db.query('SELECT corestack_fiscal.claim_delivery() AS claim', []);
  ensure(result.rows.length === 1, 'INVALID_DELIVERY_QUERY_RESULT');
  if (result.rows[0]!.claim === null) return { result: 'IDLE' as const };
  const claim = parseDeliveryClaim(result.rows[0]!.claim, scope);
  let observation: DeliveryObservation;
  try {
    observation = await (claim.action === 'SEND' ? gateway.send(claim) : gateway.reconcile(claim));
    ensure(
      [
        'UNCONFIRMED',
        'PROCESSING',
        'ACCEPTED',
        'ACCEPTED_CONDITIONALLY',
        'REJECTED',
        'REVIEW_REQUIRED',
      ].includes(observation.outcome),
      'INVALID_DELIVERY_OUTCOME',
    );
    ensure(
      observation.trackId === undefined || /^[A-Za-z0-9-]{1,200}$/.test(observation.trackId),
      'INVALID_DELIVERY_TRACK',
    );
    ensure(
      !claim.trackId || !observation.trackId || claim.trackId === observation.trackId,
      'DELIVERY_TRACK_CHANGED',
    );
    ensure(
      observation.evidence &&
        typeof observation.evidence === 'object' &&
        !Array.isArray(observation.evidence) &&
        Buffer.byteLength(JSON.stringify(observation.evidence)) <= 262144,
      'INVALID_DELIVERY_EVIDENCE',
    );
  } catch {
    // No arbitrary exception text/credentials in persistent events or logs.
    observation = { outcome: 'UNCONFIRMED', evidence: { reason: 'REMOTE_RESULT_UNCONFIRMED' } };
  }
  const saved = await db.query(
    "SELECT corestack_fiscal.complete_delivery($1::bigint,$2::uuid,$3::text,NULLIF($4::text,''),$5::jsonb) AS saved",
    [
      claim.documentId,
      claim.claimToken,
      observation.outcome,
      observation.trackId ?? '',
      JSON.stringify(observation.evidence),
    ],
  );
  ensure(
    saved.rows.length === 1 && typeof saved.rows[0]!.saved === 'boolean',
    'INVALID_DELIVERY_SAVE_RESULT',
  );
  return { result: saved.rows[0]!.saved ? observation.outcome : ('LEASE_LOST' as const) };
}
