import type { FiscalScope } from './catalog.ts';
import { assertScope } from './catalog.ts';
import { prepareVerifiedDelivery, type FiscalSigningService } from './delivery-preparation.ts';
import type { DeliveryBundleVerifier } from './delivery-enqueue.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';
import type { FiscalRegistrationConnection } from './request-repository.ts';
import type { PrintedEvidenceVerifier } from './printed-representation.ts';

type Claim = Readonly<{ documentId: string; claimToken: string }>;
const validClaim = (value: unknown): value is Claim => {
  const claim = value as Claim;
  return !!claim && /^[1-9][0-9]{0,18}$/.test(claim.documentId) &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(claim.claimToken);
};

export async function runSigningOnce(
  db: FiscalRegistrationConnection,
  scope: FiscalScope,
  signer: FiscalSigningService,
  verify: DeliveryBundleVerifier,
  printVerify?: PrintedEvidenceVerifier,
) {
  assertScope(scope);
  assertFiscalEnvironmentEnabled(scope);
  const result = await db.query('SELECT corestack_fiscal.claim_signing() AS claim', []);
  if (result.rows.length !== 1) throw Error('INVALID_SIGNING_CLAIM_RESULT');
  if (result.rows[0]!.claim === null) return { result: 'IDLE' as const };
  const claim: unknown = result.rows[0]!.claim;
  if (!validClaim(claim)) throw Error('INVALID_SIGNING_CLAIM');
  try {
    await prepareVerifiedDelivery(db, scope, claim.documentId, signer, verify, printVerify);
    const saved = await db.query(
      'SELECT corestack_fiscal.complete_signing($1::bigint,$2::uuid) AS saved',
      [claim.documentId, claim.claimToken],
    );
    if (saved.rows.length !== 1 || saved.rows[0]!.saved !== true)
      throw Error('SIGNING_LEASE_LOST');
    return { result: 'ENQUEUED' as const, documentId: claim.documentId };
  } catch {
    await db.query(
      "SELECT corestack_fiscal.fail_signing($1::bigint,$2::uuid,'SIGNING_FAILED') AS saved",
      [claim.documentId, claim.claimToken],
    );
    return { result: 'DEFERRED' as const };
  }
}
