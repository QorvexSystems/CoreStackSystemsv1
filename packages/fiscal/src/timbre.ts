import { assertScope, type FiscalScope } from './catalog.ts';
import { assertBusinessDate, parseEncf } from './encf.ts';
import { fixedDecimal, scaledDecimal } from './decimal.ts';
import { submissionRoute } from './draft.ts';
import { planDgiiQr } from './qr-capacity.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';
export type TimbreEvidence = Readonly<{
  issuerRnc: string;
  encf: string;
  buyerRnc?: string;
  issuedOn: string;
  total: string;
  signedAt: string;
  securityCode: string;
}>;
const check = (ok: unknown): void => {
  if (!ok) throw Error('INVALID_TIMBRE_EVIDENCE');
};
// Endpoint knowledge is not authorization to emit or use a synthetic signer.
export const TIMBRE_ENDPOINTS = Object.freeze({
  precertification: 'https://ecf.dgii.gov.do/testecf/consultatimbre',
  certification: 'https://ecf.dgii.gov.do/certecf/consultatimbre',
  production: 'https://ecf.dgii.gov.do/ecf/consultatimbre',
});
export const RFCE_TIMBRE_ENDPOINTS = Object.freeze({
  precertification: 'https://fc.dgii.gov.do/testecf/consultatimbrefc',
  certification: 'https://fc.dgii.gov.do/certecf/consultatimbrefc',
  production: 'https://fc.dgii.gov.do/ecf/consultatimbrefc',
});
/** Pure payload builder, NOT a signature verifier or proof of fiscal acceptance.
 * Supply fields extracted from the persisted verified signed e-CF, never current
 * catalogue/order data. RFCE uses the ORIGINAL E32 signature security code.
 */
export function buildTimbrePayload(scope: FiscalScope, input: TimbreEvidence) {
  assertScope(scope);
  assertFiscalEnvironmentEnabled(scope);
  check(input.issuerRnc === scope.issuerRnc);
  const { type } = parseEncf(input.encf);
  assertBusinessDate(input.issuedOn);
  check(/^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d-04:00$/.test(input.signedAt));
  assertBusinessDate(input.signedAt.slice(0, 10));
  check(input.signedAt.slice(0, 10) >= input.issuedOn);
  check(typeof input.securityCode === 'string' && /^[A-Za-z0-9+/]{6}$/.test(input.securityCode));
  check(input.buyerRnc === undefined || /^(?:[0-9]{9}|[0-9]{11})$/.test(input.buyerRnc));
  check(type !== 31 || (typeof input.buyerRnc === 'string' && input.buyerRnc.length > 0));
  const total = fixedDecimal(scaledDecimal(input.total, 2), 2);
  const route = submissionRoute(type, total);
  const base =
    route === 'RFCE'
      ? RFCE_TIMBRE_ENDPOINTS[scope.environment]
      : TIMBRE_ENDPOINTS[scope.environment];
  const date = (value: string) => value.split('-').reverse().join('-');
  const fields: [string, string][] = [['RncEmisor', input.issuerRnc]];
  if (route === 'ECF' && input.buyerRnc) fields.push(['RncComprador', input.buyerRnc]);
  fields.push(['ENCF', input.encf]);
  if (route === 'ECF') fields.push(['FechaEmision', date(input.issuedOn)]);
  fields.push(['MontoTotal', total]);
  if (route === 'ECF')
    fields.push([
      'FechaFirma',
      `${date(input.signedAt.slice(0, 10))} ${input.signedAt.slice(11, 19)}`,
    ]);
  fields.push(['CodigoSeguridad', input.securityCode]);
  // encodeURIComponent preserves + / and the timestamp space unambiguously.
  const url = base + '?' + fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const qr = planDgiiQr(url, { documentType: type, environment: scope.environment });
  return Object.freeze({ url, route, qrVersion: qr.version, qrMinimumBits: qr.minimumBits });
}
