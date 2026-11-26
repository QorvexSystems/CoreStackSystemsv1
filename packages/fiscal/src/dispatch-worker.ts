import type { FiscalScope } from './catalog.ts';
import { analyzeFiscalRequest } from './mapper.ts';
import { FiscalTransportError } from './registration-client.ts';

export type DispatchClaim = Readonly<{
  id: string;
  leaseToken: string;
  requestText: string;
  payloadSha256: string;
}>;

/** ERP-side durable queue port. Implementations must atomically claim a scoped
 * job, retain immutable input and fence acknowledgments with the lease token.
 * This worker never reads a live invoice/catalogue to reconstruct a retry.
 */
export interface FiscalDispatchQueue {
  claim(): Promise<DispatchClaim | null>;
  acknowledge(
    claim: DispatchClaim,
    result: { documentId: string; encf: string; payloadSha256: string },
  ): Promise<boolean>;
  defer(
    claim: DispatchClaim,
    reason: 'UNCONFIRMED' | 'REJECTED' | 'INVALID_SNAPSHOT',
  ): Promise<boolean>;
}

export async function runDispatchOnce(
  queue: FiscalDispatchQueue,
  scope: FiscalScope,
  send: (
    input: unknown,
  ) => Promise<{
    documentId: string;
    encf: string;
    payloadSha256: string;
    stage: 'RESERVED';
    sendable: false;
  }>,
) {
  const claim = await queue.claim();
  if (!claim) return { result: 'IDLE' as const };
  let input: unknown;
  try {
    input = JSON.parse(claim.requestText);
    const checked = analyzeFiscalRequest(scope, input);
    if (
      checked.payloadSha256 !== claim.payloadSha256 ||
      JSON.stringify(checked.request) !== claim.requestText
    )
      throw new Error();
  } catch {
    return {
      result: (await queue.defer(claim, 'INVALID_SNAPSHOT'))
        ? ('REVIEW_REQUIRED' as const)
        : ('LEASE_LOST' as const),
    };
  }
  let result: Awaited<ReturnType<typeof send>>;
  try {
    result = await send(input);
  } catch (error) {
    const reason =
      error instanceof FiscalTransportError && error.outcome === 'REJECTED'
        ? 'REJECTED'
        : 'UNCONFIRMED';
    return {
      result: (await queue.defer(claim, reason))
        ? reason === 'REJECTED'
          ? ('REVIEW_REQUIRED' as const)
          : ('DEFERRED' as const)
        : ('LEASE_LOST' as const),
    };
  }
  if (
    result.payloadSha256 !== claim.payloadSha256 ||
    result.stage !== 'RESERVED' ||
    result.sendable !== false
  ) {
    return {
      result: (await queue.defer(claim, 'UNCONFIRMED'))
        ? ('DEFERRED' as const)
        : ('LEASE_LOST' as const),
    };
  }
  // If this write fails, do NOT send again here or invent a replacement request.
  // Expiry of the persistent lease recovers the same immutable operation.
  return {
    result: (await queue.acknowledge(claim, result))
      ? ('REGISTERED' as const)
      : ('LEASE_LOST' as const),
  };
}
