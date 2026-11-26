import { createHash } from 'node:crypto';
import { scopeKey, type FiscalScope } from './catalog.ts';
import {
  interpretDgiiResult,
  type createDgiiClient,
  type SignedXmlVerifier,
} from './dgii-client.ts';
import {
  parseDeliveryClaim,
  type DeliveryClaim,
  type DeliveryGateway,
  type DeliveryObservation,
} from './delivery-worker.ts';
type Client = Pick<
  ReturnType<typeof createDgiiClient>,
  'submit' | 'result' | 'rfceResult' | 'trackIds'
>;
const check = (ok: unknown): void => {
  if (!ok) throw new Error('DELIVERY_EVIDENCE_MISMATCH');
};
/** Scope-bound adapter: no synthetic verifier supplied by default, no automatic
 * POST replay, and no optimistic acceptance based on a trackId alone. */
export function createDeliveryGateway(
  scope: FiscalScope,
  client: Client,
  verify: SignedXmlVerifier,
): DeliveryGateway {
  const savedScope = Object.freeze({ ...scope });
  async function verified(claim: DeliveryClaim) {
    parseDeliveryClaim(claim, savedScope);
    const evidence = await verify(savedScope, claim.route, claim.xml);
    check(
      evidence.actorRnc === savedScope.issuerRnc &&
        evidence.encf === claim.encf &&
        evidence.sha256 === claim.sha256 &&
        createHash('sha256').update(claim.xml).digest('hex') === claim.sha256,
    );
    check(scopeKey(savedScope) === scopeKey(claim.scope));
    return evidence;
  }
  function result(
    value: Record<string, unknown>,
    claim: DeliveryClaim,
    trackId?: string,
  ): DeliveryObservation {
    // RFCE consultation documents the code as a string; accept only exact digits.
    const codigo =
      typeof value.codigo === 'string' && /^[0-4]$/.test(value.codigo)
        ? Number(value.codigo)
        : value.codigo;
    const interpreted = interpretDgiiResult(
      { ...value, codigo },
      { rnc: savedScope.issuerRnc, encf: claim.encf, ...(trackId ? { trackId } : {}) },
    );
    const outcome = interpreted.state === 'NOT_FOUND' ? 'UNCONFIRMED' : interpreted.state;
    check(
      ['UNCONFIRMED', 'PROCESSING', 'ACCEPTED', 'ACCEPTED_CONDITIONALLY', 'REJECTED'].includes(
        outcome!,
      ),
    );
    return {
      outcome: outcome as DeliveryObservation['outcome'],
      ...(trackId ? { trackId } : {}),
      evidence: {
        codigo,
        sequenceUsed: interpreted.sequenceUsed,
        encf: claim.encf,
        rnc: savedScope.issuerRnc,
      },
    };
  }
  return {
    async send(claim) {
      check(claim.action === 'SEND');
      await verified(claim);
      const response = await client.submit(claim.route, claim.xml);
      if (claim.route === 'RFCE') {
        // RFCE POST has no RNC field; binding comes from this scoped authenticated
        // request. Never apply this normalization to a consultation response.
        check(response.rnc === undefined || response.rnc === savedScope.issuerRnc);
        return result({ ...response, rnc: savedScope.issuerRnc }, claim);
      }
      check(
        typeof response.trackId === 'string' &&
          /^[A-Za-z0-9-]{1,200}$/.test(response.trackId) &&
          !response.error,
      );
      return {
        outcome: 'PROCESSING',
        trackId: response.trackId as string,
        evidence: { acknowledged: true },
      };
    },
    async reconcile(claim) {
      check(claim.action === 'RECONCILE');
      const evidence = await verified(claim);
      if (claim.route === 'RFCE') {
        check(
          typeof evidence.securityCode === 'string' &&
            /^[A-Za-z0-9+/]{6}$/.test(evidence.securityCode),
        );
        return result(await client.rfceResult(claim.encf, evidence.securityCode!), claim);
      }
      let trackId = claim.trackId;
      if (!trackId) {
        if (savedScope.environment === 'certification')
          return {
            outcome: 'REVIEW_REQUIRED',
            evidence: { reason: 'TRACK_LOOKUP_UNAVAILABLE_IN_CERTIFICATION' },
          };
        const tracks = [...new Set(await client.trackIds(claim.encf))];
        if (tracks.length === 0)
          return { outcome: 'UNCONFIRMED', evidence: { reason: 'TRACK_NOT_FOUND' } };
        if (tracks.length !== 1)
          return { outcome: 'REVIEW_REQUIRED', evidence: { reason: 'MULTIPLE_TRACKS' } };
        trackId = tracks[0]!;
      }
      return result(await client.result(trackId), claim, trackId);
    },
  };
}
