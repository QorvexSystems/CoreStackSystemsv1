import { createHash } from 'node:crypto';
import { assertScope, assertEcfType, type FiscalScope, type EcfType } from './catalog.ts';
import { assertBusinessDate, parseEncf } from './encf.ts';
import { element as e, serializeXml, child, children, textAt, type XmlElement } from './xml.ts';
import { scaledDecimal, fixedDecimal } from './decimal.ts';
import { XmllintDraftValidator, type AuxiliaryKind } from './xsd-validator.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

const check = (ok: unknown, code: string): void => {
  if (!ok) throw new Error(code);
};
function rnc(value: string) {
  check(typeof value === 'string' && /^(?:\d{9}|\d{11})$/.test(value), 'INVALID_RNC');
  return value;
}
function text(value: string, max: number) {
  check(typeof value === 'string' && value.trim() && [...value].length <= max, 'INVALID_TEXT');
  return value;
}
function date(value: string) {
  assertBusinessDate(value);
  check(/^20\d{2}/.test(value), 'INVALID_YEAR');
  return value.split('-').reverse().join('-');
}
function timestamp(value: string) {
  check(
    typeof value === 'string' &&
      /^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d-04:00$/.test(value),
    'DOMINICAN_TIMESTAMP_REQUIRED',
  );
  return `${date(value.slice(0, 10))} ${value.slice(11, 19)}`;
}
function scopeFor(scope: FiscalScope, actorRnc: string) {
  assertScope(scope);
  assertFiscalEnvironmentEnabled(scope);
  check(scope.issuerRnc === rnc(actorRnc), 'AUXILIARY_ACTOR_MISMATCH');
}
async function draft(kind: AuxiliaryKind, root: XmlElement, scope: FiscalScope) {
  const savedScope = Object.freeze({ ...scope });
  const xml = serializeXml(root);
  await new XmllintDraftValidator().validateUnsignedAuxiliary(kind, xml);
  return Object.freeze({
    kind,
    scope: savedScope,
    xml,
    sha256: createHash('sha256').update(xml).digest('hex'),
    schemaValidated: true,
    validationProfile: 'UNSIGNED_DRAFT' as const,
    signed: false as const,
    sendable: false as const,
  });
}

type Receipt = { issuerRnc: string; buyerRnc: string; encf: string; at: string };
/** Buyer creates receipt. Receipt does NOT assert commercial acceptance. */
export async function prepareAreCf(
  scope: FiscalScope,
  input: Receipt & { state: 0 | 1; reason?: 1 | 2 | 3 | 4 },
) {
  scopeFor(scope, input.buyerRnc);
  rnc(input.issuerRnc);
  parseEncf(input.encf);
  check(
    (input.state === 0 && input.reason === undefined) ||
      (input.state === 1 && [1, 2, 3, 4].includes(input.reason!)),
    'INVALID_RECEIPT_REASON',
  );
  return draft(
    'ARECF',
    e('ARECF', [
      e('DetalleAcusedeRecibo', [
        e('Version', '1.0'),
        e('RNCEmisor', input.issuerRnc),
        e('RNCComprador', input.buyerRnc),
        e('eNCF', input.encf),
        e('Estado', String(input.state)),
        ...(input.reason === undefined ? [] : [e('CodigoMotivoNoRecibido', String(input.reason))]),
        e('FechaHoraAcuseRecibo', timestamp(input.at)),
      ]),
    ]),
    scope,
  );
}

/** Input document identity/date/amount MUST come from the stored received e-CF,
 * not independently editable form fields. Caller authorizes the commercial action. */
export async function prepareAceCf(
  scope: FiscalScope,
  input: Receipt & {
    issuedOn: string;
    total: string;
    state: 1 | 2;
    rejectionReason?: string;
  },
) {
  scopeFor(scope, input.buyerRnc);
  rnc(input.issuerRnc);
  parseEncf(input.encf);
  check(input.state === 1 || input.state === 2, 'INVALID_COMMERCIAL_STATE');
  check(
    input.state === 2 ? !!input.rejectionReason : input.rejectionReason === undefined,
    'INVALID_COMMERCIAL_REASON',
  );
  return draft(
    'ACECF',
    e('ACECF', [
      e('DetalleAprobacionComercial', [
        e('Version', '1.0'),
        e('RNCEmisor', input.issuerRnc),
        e('eNCF', input.encf),
        e('FechaEmision', date(input.issuedOn)),
        e('MontoTotal', fixedDecimal(scaledDecimal(input.total, 2), 2)),
        e('RNCComprador', input.buyerRnc),
        e('Estado', String(input.state)),
        ...(input.rejectionReason === undefined
          ? []
          : [e('DetalleMotivoRechazo', text(input.rejectionReason, 250))]),
        e('FechaHoraAprobacionComercial', timestamp(input.at)),
      ]),
    ]),
    scope,
  );
}

/** Pure draft only: does NOT cancel stored numbers. Caller must lock/check the
 * authorized ledger and absence of sends to DGII/recipient before committing. */
export async function prepareAnEcf(
  scope: FiscalScope,
  input: {
    at: string;
    groups: readonly { type: EcfType; ranges: readonly { from: string; to: string }[] }[];
  },
) {
  scopeFor(scope, scope.issuerRnc);
  check(
    Array.isArray(input.groups) && input.groups.length > 0 && input.groups.length <= 10,
    'INVALID_CANCELLATION_GROUPS',
  );
  const types = new Set<number>();
  let count = 0n;
  const groups = input.groups.map((group, index) => {
    assertEcfType(group.type);
    check(!types.has(group.type), 'DUPLICATE_CANCELLATION_TYPE');
    types.add(group.type);
    check(
      Array.isArray(group.ranges) && group.ranges.length > 0 && group.ranges.length <= 10000,
      'INVALID_CANCELLATION_RANGES',
    );
    let subtotal = 0n;
    let last = 0n;
    const parsed = group.ranges
      .map((range) => ({ from: parseEncf(range.from), to: parseEncf(range.to), range }))
      .sort((a, b) => (BigInt(a.from.sequence) < BigInt(b.from.sequence) ? -1 : 1));
    const ranges = parsed.map(({ from, to, range }) => {
      const first = BigInt(from.sequence),
        end = BigInt(to.sequence);
      check(
        from.type === group.type && to.type === group.type && first <= end,
        'INVALID_CANCELLATION_RANGE',
      );
      check(first > last, 'OVERLAPPING_CANCELLATION_RANGES');
      last = end;
      subtotal += end - first + 1n;
      return e('Secuencias', [
        e('SecuenciaeNCFDesde', range.from),
        e('SecuenciaeNCFHasta', range.to),
      ]);
    });
    count += subtotal;
    check(count <= 9999999999n, 'CANCELLATION_COUNT_OVERFLOW');
    return e('Anulacion', [
      e('NoLinea', String(index + 1)),
      e('TipoeCF', String(group.type)),
      e('TablaRangoSecuenciasAnuladaseNCF', ranges),
      e('CantidadeNCFAnulados', String(subtotal)),
    ]);
  });
  return draft(
    'ANECF',
    e('ANECF', [
      e('Encabezado', [
        e('Version', '1.0'),
        e('RncEmisor', scope.issuerRnc),
        e('CantidadeNCFAnulados', String(count)),
        e('FechaHoraAnulacioneNCF', timestamp(input.at)),
      ]),
      e('DetalleAnulacion', groups),
    ]),
    scope,
  );
}

/** For issuer-owned authentication service only. Signing a DGII-provided seed
 * must preserve the original received XML bytes/tree rather than rebuilding it. */
export async function prepareSeed(scope: FiscalScope, value: string, at: string) {
  scopeFor(scope, scope.issuerRnc);
  text(value, 512);
  check(
    /^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:Z|-04:00)$/.test(at),
    'INVALID_SEED_TIMESTAMP',
  );
  assertBusinessDate(at.slice(0, 10));
  return draft('SEMILLA', e('SemillaModel', [e('valor', value), e('fecha', at)]), scope);
}

/** Draft projection of the exact E32 tree. The signing layer must supply the
 * security code from the verified ORIGINAL E32 signature; this function does
 * not verify a signature and never authorizes submission of the RFCE.
 */
export async function prepareRfce(
  scope: FiscalScope,
  ecf: XmlElement,
  binding: {
    unsignedEcfSha256: string;
    securityCode: string;
  },
) {
  scopeFor(scope, scope.issuerRnc);
  check(ecf.name === 'ECF', 'RFCE_REQUIRES_ECF');
  const sourceXml = serializeXml(ecf);
  // Snapshot after bounded serialization: callers cannot change the validated
  // source, scope or signature-code binding while xmllint runs asynchronously.
  ecf = structuredClone(ecf);
  binding = { ...binding };
  scope = { ...scope };
  check(
    createHash('sha256').update(sourceXml).digest('hex') === binding.unsignedEcfSha256,
    'RFCE_SOURCE_DIGEST_MISMATCH',
  );
  check(/^[A-Za-z0-9+/]{6}$/.test(binding.securityCode), 'INVALID_SECURITY_CODE');
  await new XmllintDraftValidator().validateUnsignedEcf(32, sourceXml);
  const header = child(ecf, 'Encabezado'),
    id = child(header, 'IdDoc'),
    issuer = child(header, 'Emisor');
  check(
    textAt(id, 'TipoeCF') === '32' && parseEncf(textAt(id, 'eNCF')).type === 32,
    'RFCE_REQUIRES_E32',
  );
  check(textAt(issuer, 'RNCEmisor') === scope.issuerRnc, 'RFCE_ISSUER_MISMATCH');
  date(textAt(issuer, 'FechaEmision').split('-').reverse().join('-'));
  const totals = child(header, 'Totales');
  const total = scaledDecimal(textAt(totals, 'MontoTotal'), 2);
  check(total < 25000000n, 'RFCE_THRESHOLD_EXCEEDED');
  const optionalAmount = (name: string) => {
    const nodes = children(totals).filter((node) => node.name === name);
    check(nodes.length <= 1, 'DUPLICATE_TOTAL');
    return nodes.length ? scaledDecimal(nodes[0]!.value as string, 2) : 0n;
  };
  check(
    optionalAmount('MontoGravadoTotal') +
      optionalAmount('MontoExento') +
      optionalAmount('TotalITBIS') +
      optionalAmount('MontoImpuestoAdicional') ===
      total,
    'RFCE_TOTAL_MISMATCH',
  );
  const project = (node: XmlElement, allowed: string[]) =>
    allowed.flatMap((name) => children(node).filter((item) => item.name === name));
  const totalNames = [
    'MontoGravadoTotal',
    'MontoGravadoI1',
    'MontoGravadoI2',
    'MontoGravadoI3',
    'MontoExento',
    'TotalITBIS',
    'TotalITBIS1',
    'TotalITBIS2',
    'TotalITBIS3',
    'MontoImpuestoAdicional',
    'ImpuestosAdicionales',
    'MontoTotal',
    'MontoNoFacturable',
    'MontoPeriodo',
  ];
  check(
    children(totals).every((node) =>
      [...totalNames, 'ITBIS1', 'ITBIS2', 'ITBIS3'].includes(node.name),
    ),
    'UNSUPPORTED_RFCE_TOTAL',
  );
  const buyer = child(header, 'Comprador');
  return draft(
    'RFCE',
    e('RFCE', [
      e('Encabezado', [
        e('Version', '1.0'),
        e('IdDoc', project(id, ['TipoeCF', 'eNCF', 'TipoIngresos', 'TipoPago', 'TablaFormasPago'])),
        e('Emisor', project(issuer, ['RNCEmisor', 'RazonSocialEmisor', 'FechaEmision'])),
        e(
          'Comprador',
          project(buyer, ['RNCComprador', 'IdentificadorExtranjero', 'RazonSocialComprador']),
        ),
        e('Totales', project(totals, totalNames)),
        e('CodigoSeguridadeCF', binding.securityCode),
      ]),
    ]),
    scope,
  );
}
