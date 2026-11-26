import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { EcfType, FiscalScope } from './catalog.ts';
import type { FiscalRequestV1 } from './contract.ts';
import { analyzeFiscalRequest, prepareMappedEcfDraft } from './mapper.ts';
import { formatEncf } from './encf.ts';
import { XmllintDraftValidator } from './xsd-validator.ts';

const outputRoot = '/output';
const issuedOn = '2026-10-19';
const signatureAt = '2026-10-19T21:54:00-04:00';
const validUntil = '2028-12-31';
const scope: FiscalScope = Object.freeze({
  tenantId: 'cmt397emm0002nm0ogb50l2q6',
  issuerRnc: '40220429126',
  environment: 'certification',
});
const issuer = Object.freeze({
  rnc: scope.issuerRnc,
  fiscalName: 'STARLIN ANTONIO RIVAS NUÑEZ',
  address: 'JUANA SALTITO, NO. 20, LOCAL 41, VILLA REAL, LA VEGA',
});
const domesticBuyer = Object.freeze({
  kind: 'DOMESTIC' as const,
  identifier: '131880681',
  fiscalName: 'DOCUMENTOS ELECTRONICOS DE 03',
});
const foreignBuyer = Object.freeze({
  kind: 'FOREIGN' as const,
  identifier: 'CLIENTE-EXTERIOR-001',
  fiscalName: 'CLIENTE DE PRUEBA DEL EXTERIOR',
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function applyOfficialCreditNoteProfile(xml: string): string {
  const replacements: readonly [string, string][] = [
    ['<TipoIngresos>01</TipoIngresos>', ''],
    [
      '<MontoGravadoTotal>0.00</MontoGravadoTotal><MontoGravadoI1>0.00</MontoGravadoI1><ITBIS1>18</ITBIS1><TotalITBIS>0.00</TotalITBIS><TotalITBIS1>0.00</TotalITBIS1><MontoTotal>0.00</MontoTotal>',
      '<MontoTotal>0.00</MontoTotal><MontoNoFacturable>1.00</MontoNoFacturable>',
    ],
    ['<IndicadorFacturacion>1</IndicadorFacturacion>', '<IndicadorFacturacion>0</IndicadorFacturacion>'],
    ['<PrecioUnitarioItem>0.0000</PrecioUnitarioItem>', '<PrecioUnitarioItem>1.00</PrecioUnitarioItem>'],
    ['<MontoItem>0.00</MontoItem>', '<MontoItem>1.00</MontoItem>'],
  ];
  let result = xml;
  for (const [before, after] of replacements) {
    if (result.split(before).length !== 2) throw Error('SIMULATION_E34_PROFILE_SOURCE_INVALID');
    result = result.replace(before, after);
  }
  return result;
}

type Case = Readonly<{
  phase: 1 | 2 | 3 | 4;
  route: 'ECF' | 'RFCE' | 'PORTAL';
  request: FiscalRequestV1;
  encf: string;
  dependsOn?: readonly string[];
}>;

function request(
  type: EcfType,
  sequence: number,
  options: {
    description: string;
    unitPrice: string;
    billingIndicator?: 1 | 3 | 4;
    buyer?: 'DOMESTIC' | 'FOREIGN' | 'NONE';
    reference?: { encf: string; code: 1 | 2 | 3; reason: string };
  },
): FiscalRequestV1 {
  const billingIndicator = options.billingIndicator ?? 1;
  const taxed = billingIndicator === 1;
  const price = BigInt(options.unitPrice.replace('.', ''));
  const scale = options.unitPrice.includes('.') ? options.unitPrice.split('.')[1]!.length : 0;
  const netCents = scale === 0 ? price * 100n : scale === 1 ? price * 10n : price;
  const taxCents = taxed ? (netCents * 18n + 50n) / 100n : 0n;
  const money = (cents: bigint) => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  const buyerKind = options.buyer ?? ([32, 43].includes(type) ? 'NONE' : [46, 47].includes(type) ? 'FOREIGN' : 'DOMESTIC');
  const withholding = type === 41
    ? { itbis: money(taxCents), isr: money(netCents / 10n) }
    : type === 47
      ? { itbis: '0.00', isr: money((netCents * 27n) / 100n) }
      : undefined;
  const encf = formatEncf(type, String(sequence));
  return {
    version: '1',
    operationId: `rivnu-simulation-${encf}`,
    source: { documentId: `simulation-${encf}`, revision: '1' },
    type,
    issuedOn,
    currency: 'DOP',
    pricesIncludeTax: false,
    issuer,
    ...(buyerKind === 'DOMESTIC' ? { buyer: domesticBuyer } : {}),
    ...(buyerKind === 'FOREIGN' ? { buyer: foreignBuyer } : {}),
    ...([31, 32, 33, 34, 44, 45, 46].includes(type) ? { incomeType: '01' as const } : {}),
    payment: { type: 1 },
    ...(options.reference
      ? {
          reference: {
            encf: options.reference.encf,
            issuedOn,
            code: options.reference.code,
            reason: options.reference.reason,
          },
        }
      : {}),
    lines: [{
      sourceLineId: `${encf}-1`,
      description: options.description,
      kind: type === 41 || type === 47 ? 'SERVICE' : 'GOOD',
      quantity: '1.00',
      unitPrice: money(netCents),
      billingIndicator,
      discount: '0.00',
      ...(withholding ? { withholding } : {}),
    }],
    expectedTotals: {
      net: money(netCents),
      itbis: money(taxCents),
      total: money(netCents + taxCents),
      itbisWithheld: type === 41 ? money(taxCents) : '0.00',
      isrWithheld: type === 41
        ? money(netCents / 10n)
        : type === 47
          ? money((netCents * 27n) / 100n)
          : '0.00',
    },
  };
}

const e31a = formatEncf(31, '300001');
const e41a = formatEncf(41, '300001');
const e41b = formatEncf(41, '300002');
const cases: Case[] = [
  ...[
    request(31, 300001, { description: 'CEMENTO GRIS USO GENERAL', unitPrice: '1450.00' }),
    request(31, 300002, { description: 'VARILLA CORRUGADA 3/8', unitPrice: '980.00' }),
    request(31, 300003, { description: 'PINTURA ACRILICA BLANCA', unitPrice: '2350.00' }),
    request(31, 300004, { description: 'TUBO PVC PRESION', unitPrice: '725.00' }),
    request(32, 300001, { description: 'LOTE DE MATERIALES DE CONSTRUCCION', unitPrice: '260000.00', buyer: 'DOMESTIC' }),
    request(32, 300002, { description: 'LOTE DE HERRAMIENTAS Y EQUIPOS', unitPrice: '275000.00', buyer: 'DOMESTIC' }),
    request(41, 300001, { description: 'SERVICIO DE INSTALACION', unitPrice: '10000.00' }),
    request(41, 300002, { description: 'SERVICIO DE TRANSPORTE LOCAL', unitPrice: '8000.00' }),
    request(43, 300001, { description: 'GASTO MENOR DE FERRETERIA', unitPrice: '1500.00', billingIndicator: 4 }),
    request(43, 300002, { description: 'GASTO MENOR DE MANTENIMIENTO', unitPrice: '2200.00', billingIndicator: 4 }),
    request(44, 300001, { description: 'MATERIALES PARA REGIMEN ESPECIAL', unitPrice: '12500.00', billingIndicator: 4 }),
    request(44, 300002, { description: 'HERRAMIENTAS PARA REGIMEN ESPECIAL', unitPrice: '9800.00', billingIndicator: 4 }),
    request(45, 300001, { description: 'MATERIALES PARA ENTIDAD GUBERNAMENTAL', unitPrice: '18500.00' }),
    request(45, 300002, { description: 'EQUIPOS PARA ENTIDAD GUBERNAMENTAL', unitPrice: '24500.00' }),
    request(46, 300001, { description: 'HERRAMIENTAS PARA EXPORTACION', unitPrice: '32000.00', billingIndicator: 3 }),
    request(46, 300002, { description: 'MATERIALES PARA EXPORTACION', unitPrice: '41000.00', billingIndicator: 3 }),
    request(47, 300001, { description: 'SERVICIO CONTRATADO EN EL EXTERIOR', unitPrice: '15000.00', billingIndicator: 4 }),
    request(47, 300002, { description: 'SOPORTE TECNICO DEL EXTERIOR', unitPrice: '20000.00', billingIndicator: 4 }),
  ].map((entry) => ({ phase: 1 as const, route: 'ECF' as const, request: entry, encf: formatEncf(entry.type, entry.operationId.split('-').at(-1)!.slice(3)) })),
  {
    phase: 2,
    route: 'ECF',
    request: request(33, 300001, { description: 'AJUSTE POR DIFERENCIA DE PRECIO', unitPrice: '100.00', reference: { encf: e31a, code: 3, reason: 'Diferencia de precio' } }),
    encf: formatEncf(33, '300001'),
    dependsOn: [e31a],
  },
  {
    phase: 2,
    route: 'ECF',
    request: request(34, 300001, { description: 'SERVICIO DE INSTALACION ACTUALIZADO', unitPrice: '0.00', reference: { encf: e41a, code: 2, reason: 'Corrección de texto' } }),
    encf: formatEncf(34, '300001'),
    dependsOn: [e41a],
  },
  {
    phase: 2,
    route: 'ECF',
    request: request(34, 300002, { description: 'SERVICIO DE TRANSPORTE LOCAL ACTUALIZADO', unitPrice: '0.00', reference: { encf: e41b, code: 2, reason: 'Corrección de texto' } }),
    encf: formatEncf(34, '300002'),
    dependsOn: [e41b],
  },
  ...[
    request(32, 300003, { description: 'MARTILLO DE UÑA', unitPrice: '850.00', buyer: 'DOMESTIC' }),
    request(32, 300004, { description: 'JUEGO DE DESTORNILLADORES', unitPrice: '1250.00', buyer: 'DOMESTIC' }),
    request(32, 300005, { description: 'CINTA METRICA', unitPrice: '475.00', buyer: 'DOMESTIC' }),
    request(32, 300006, { description: 'ALICATE UNIVERSAL', unitPrice: '695.00', buyer: 'DOMESTIC' }),
  ].flatMap((entry) => {
    const encf = formatEncf(32, entry.operationId.split('-').at(-1)!.slice(3));
    return [
      { phase: 3 as const, route: 'RFCE' as const, request: entry, encf },
      { phase: 4 as const, route: 'PORTAL' as const, request: entry, encf, dependsOn: [encf] },
    ];
  }),
];

const apiCases = cases.filter((entry) => entry.route !== 'PORTAL');
if (apiCases.length !== 25 || new Set(apiCases.map((entry) => `${entry.route}:${entry.encf}`)).size !== 25)
  throw Error('SIMULATION_PLAN_INVALID');
if (cases.filter((entry) => entry.route === 'PORTAL').length !== 4)
  throw Error('SIMULATION_PORTAL_PLAN_INVALID');

await mkdir(`${outputRoot}/ecf-unsigned`, { recursive: true, mode: 0o700 });
const validator = new XmllintDraftValidator();
const documents: Record<string, unknown>[] = [];
for (const entry of cases.filter((item) => item.route !== 'PORTAL')) {
  const analysis = analyzeFiscalRequest(scope, entry.request);
  const reservation = {
    scope,
    operationId: entry.request.operationId,
    payloadSha256: analysis.payloadSha256,
    encf: entry.encf,
    businessDate: issuedOn,
    validUntil: [32, 34].includes(entry.request.type) ? null : validUntil,
  };
  const draft = await prepareMappedEcfDraft(scope, entry.request, reservation, signatureAt, validator);
  const xml = entry.request.type === 34 ? applyOfficialCreditNoteProfile(draft.xml) : draft.xml;
  if (entry.request.type === 34) await validator.validateUnsignedEcf(34, xml);
  await writeFile(`${outputRoot}/ecf-unsigned/${entry.encf}.xml`, xml, { mode: 0o600, flag: 'wx' });
  documents.push({
    phase: entry.phase,
    route: entry.route,
    type: entry.request.type,
    encf: entry.encf,
    sha256: hash(xml),
    bytes: Buffer.byteLength(xml),
    dependsOn: entry.dependsOn ?? [],
  });
}
const manifest = {
  profile: 'RIVNU_SIMULATION_20261019_ATTEMPT3_V1',
  scope,
  issuedOn,
  signatureAt,
  validUntil,
  sequenceStart: 300001,
  documents,
  portalUploads: cases.filter((entry) => entry.route === 'PORTAL').map((entry) => entry.encf),
};
await writeFile(`${outputRoot}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log('RIVNU_SIMULATION_SET_PREPARED_ECF=25_RFCE_PENDING=4');
