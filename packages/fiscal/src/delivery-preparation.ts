import { assertScope, type FiscalScope } from './catalog.ts';
import { parseEncf } from './encf.ts';
import { submissionRoute } from './draft.ts';
import { readFiscalPreparation } from './preparation-repository.ts';
import { enqueueVerifiedDelivery, type DeliveryBundleVerifier } from './delivery-enqueue.ts';
import type { FiscalRegistrationConnection } from './request-repository.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';
import { parseSerializedXml } from './xml.ts';
import {
  preparePrintedRepresentation,
  type PrintedEvidenceVerifier,
} from './printed-representation.ts';

/** Inject a provisioned signing service, never private keys from an HTTP body.
 * RFCE must be derived from the full signed E32 (including its security code).
 * No default signer/verifier: callers cannot silently substitute a test identity.
 */
export interface FiscalSigningService {
  signEcf(scope: FiscalScope, unsignedXml: string): Promise<string>;
  signConsumptionSummary(
    scope: FiscalScope,
    unsignedEcfXml: string,
    signedEcfXml: string,
  ): Promise<string>;
}

/** Bridges immutable preparation to the durable delivery queue. Does not POST,
 * charge an invoice, mark fiscal acceptance, or enable a paused delivery scope.
 * The enqueue verifier establishes identity, exact source, signature and RFCE
 * projection bindings before any outbound artifact can be persisted.
 */
export async function prepareVerifiedDelivery(
  db: FiscalRegistrationConnection,
  scope: FiscalScope,
  documentId: string,
  signer: FiscalSigningService,
  verify: DeliveryBundleVerifier,
  printVerify?: PrintedEvidenceVerifier,
) {
  assertScope(scope);
  assertFiscalEnvironmentEnabled(scope);
  const trustedScope = Object.freeze({ ...scope });
  const prepared = await readFiscalPreparation(db, documentId);
  if (!prepared || prepared.state !== 'DONE' || !prepared.xml)
    throw Error('DELIVERY_PREPARATION_NOT_READY');
  const issuers = [...prepared.xml.matchAll(/<RNCEmisor>([0-9]+)<\/RNCEmisor>/g)];
  if (issuers.length !== 1 || issuers[0]![1] !== trustedScope.issuerRnc)
    throw Error('DELIVERY_PREPARATION_ISSUER_MISMATCH');
  const totals = [...prepared.xml.matchAll(/<MontoTotal>([0-9]+(?:\.[0-9]+)?)<\/MontoTotal>/g)];
  if (totals.length !== 1) throw Error('INVALID_PREPARED_TOTAL');
  const route = submissionRoute(parseEncf(prepared.encf).type, totals[0]![1]!);
  const signedEcf = await signer.signEcf(trustedScope, prepared.xml);
  const submission =
    route === 'RFCE'
      ? await signer.signConsumptionSummary(trustedScope, prepared.xml, signedEcf)
      : signedEcf;
  const representation = printVerify
    ? await preparePrintedRepresentation(
        trustedScope,
        parseSerializedXml(prepared.xml),
        signedEcf,
        printVerify,
      )
    : undefined;
  return enqueueVerifiedDelivery(
    db,
    trustedScope,
    documentId,
    signedEcf,
    submission,
    verify,
    representation,
  );
}
