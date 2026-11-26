import { createHash } from 'node:crypto';
import { assertScope, type FiscalScope } from './catalog.ts';
import { parseEncf } from './encf.ts';
import { submissionRoute } from './draft.ts';
import { readFiscalPreparation } from './preparation-repository.ts';
import type { FiscalRegistrationConnection } from './request-repository.ts';
import type { SignedXmlVerifier } from './dgii-client.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';
import type { PrintedRepresentation } from './printed-types.ts';

/** A real verifier must establish these bindings from the signed trees, not
 * trust caller-provided metadata. For RFCE, verify its projection/security code
 * against signedEcfXml as well as both XMLDSig signatures and the delegation.
 */
export type DeliveryBundleVerifier = (
  scope: FiscalScope,
  input: {
    unsignedEcfXml: string;
    signedEcfXml: string;
    submissionXml: string;
    route: 'ECF' | 'RFCE';
  },
) => Promise<{
  ecf: Awaited<ReturnType<SignedXmlVerifier>>;
  submission: Awaited<ReturnType<SignedXmlVerifier>>;
  certificateSha256: string;
  sourceSha256: string;
}>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const check = (ok: unknown): void => {
  if (!ok) throw Error('INVALID_VERIFIED_DELIVERY_BUNDLE');
};

/** Only enqueue from immutable preparation, never arbitrary operator XML. The
 * full signed E32 is retained even when only its signed RFCE is transmitted. */
export async function enqueueVerifiedDelivery(
  db: FiscalRegistrationConnection,
  scope: FiscalScope,
  documentId: string,
  signedEcfXml: string,
  submissionXml: string,
  verify: DeliveryBundleVerifier,
  representation?: PrintedRepresentation,
) {
  assertScope(scope);
  assertFiscalEnvironmentEnabled(scope);
  const savedScope = Object.freeze({ ...scope });
  for (const xml of [signedEcfXml, submissionXml])
    check(
      typeof xml === 'string' &&
        xml.length > 0 &&
        Buffer.byteLength(xml) <= 2097152 &&
        !/<!/.test(xml),
    );
  const prepared = await readFiscalPreparation(db, documentId);
  check(prepared?.state === 'DONE' && prepared.xml);
  // The route must agree with the immutable source, not an API flag. Only the
  // generated, schema-validated unsigned dialect is read here; no general parser.
  const matches = [...prepared!.xml!.matchAll(/<MontoTotal>([0-9]+(?:\.[0-9]+)?)<\/MontoTotal>/g)];
  check(matches.length === 1);
  const route = submissionRoute(parseEncf(prepared!.encf).type, matches[0]![1]!);
  if (route === 'ECF') check(signedEcfXml === submissionXml);
  const verified = await verify(savedScope, {
    unsignedEcfXml: prepared!.xml!,
    signedEcfXml,
    submissionXml,
    route,
  });
  check(
    verified.sourceSha256 === prepared!.xmlSha256 &&
      /^[a-f0-9]{64}$/.test(verified.certificateSha256),
  );
  for (const [evidence, xml] of [
    [verified.ecf, signedEcfXml],
    [verified.submission, submissionXml],
  ] as const) {
    check(
      evidence.actorRnc === savedScope.issuerRnc &&
        evidence.encf === prepared!.encf &&
        evidence.sha256 === digest(xml),
    );
    check(evidence.total === matches[0]![1]);
  }
  const result = await db.query(
    representation
      ? 'SELECT corestack_fiscal.enqueue_delivery_with_representation($1::bigint,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text,$8::jsonb) AS created'
      : 'SELECT corestack_fiscal.enqueue_delivery($1::bigint,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text) AS created',
    [
      documentId,
      submissionXml,
      digest(submissionXml),
      prepared!.xmlSha256!,
      verified.certificateSha256,
      signedEcfXml,
      digest(signedEcfXml),
      ...(representation ? [JSON.stringify(representation)] : []),
    ],
  );
  check(result.rows.length === 1 && typeof result.rows[0]!.created === 'boolean');
  return { documentId, route, created: result.rows[0]!.created as boolean };
}
