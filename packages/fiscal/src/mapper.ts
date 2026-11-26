import type { FiscalScope } from './catalog.ts';
import { scopeKey } from './catalog.ts';
import { deepFreeze, requireFiscal, snapshotFiscalRequest } from './contract.ts';
import type { FiscalRequestV1 } from './contract.ts';
import { fixedDecimal, roundRatio, scaledDecimal } from './decimal.ts';
import { assertBusinessDate, parseEncf } from './encf.ts';
import { prepareEcfDraft } from './draft.ts';
import type { DraftSchemaValidator } from './draft.ts';
import { element as e } from './xml.ts';
import type { XmlElement } from './xml.ts';

const RATES = [18n, 16n, 0n, 0n] as const;
const hasIncome = (type: number) => [31, 32, 33, 34, 44, 45, 46].includes(type);
const hasTaxIndicator = (type: number) => [31, 32, 33, 34, 41, 45].includes(type);
const isNote = (type: number) => type === 33 || type === 34;
const cents = (value: string) => scaledDecimal(value, 2);
const money = (value: bigint) => fixedDecimal(value, 2);
const dgiiDate = (value: string) => value.split('-').reverse().join('-');
const ageDays = (original: string, current: string) =>
  (Date.parse(`${current}T00:00:00Z`) - Date.parse(`${original}T00:00:00Z`)) / 86_400_000;

function calculate(request: FiscalRequestV1) {
  const bases = [0n, 0n, 0n, 0n];
  const present = [false, false, false, false];
  let itbisWithheld = 0n;
  let isrWithheld = 0n;
  const lines = request.lines.map((line, index) => {
    const field = `lines[${index}]`;
    if ([43, 44, 47].includes(request.type)) {
      requireFiscal(line.billingIndicator === 4, 'EXEMPT_REQUIRED', `${field}.billingIndicator`);
    }
    if (request.type === 46)
      requireFiscal(line.billingIndicator === 3, 'ZERO_RATE_REQUIRED', `${field}.billingIndicator`);
    const product = scaledDecimal(line.quantity, 2) * scaledDecimal(line.unitPrice, 4);
    const discount = cents(line.discount);
    requireFiscal(discount * 10_000n <= product, 'DISCOUNT_EXCEEDS_LINE', `${field}.discount`);
    if ([43, 47].includes(request.type))
      requireFiscal(discount === 0n, 'DISCOUNT_NOT_APPLICABLE', `${field}.discount`);
    const net = roundRatio(product - discount * 10_000n, 10_000n);
    money(net); // Overflow checked before accumulating or serializing.
    const bucket = line.billingIndicator - 1;
    bases[bucket] += net;
    present[bucket] = true;
    if ([41, 47].includes(request.type))
      requireFiscal(line.withholding, 'WITHHOLDING_REQUIRED', field);
    if (line.withholding) {
      requireFiscal(
        [31, 33, 34, 41, 47].includes(request.type),
        'WITHHOLDING_NOT_APPLICABLE',
        field,
      );
      const itbis = cents(line.withholding.itbis);
      const isr = cents(line.withholding.isr);
      requireFiscal(
        itbis <= roundRatio(net * RATES[bucket], 100n),
        'EXCESS_ITBIS_WITHHOLDING',
        field,
      );
      requireFiscal(isr <= net, 'EXCESS_ISR_WITHHOLDING', field);
      if (request.type === 41 && line.kind === 'GOOD') {
        requireFiscal(isr === 0n, 'ISR_SERVICE_ONLY_PROFILE', field);
      }
      itbisWithheld += itbis;
      isrWithheld += isr;
    }
    return { net: money(net) };
  });
  // Compute tax from each aggregate base, not from a sum of rounded per-line taxes.
  const taxes = bases.map((base, index) => roundRatio(base * RATES[index], 100n));
  const net = bases.reduce((a, b) => a + b, 0n);
  const itbis = taxes.reduce((a, b) => a + b, 0n);
  requireFiscal(itbisWithheld <= itbis, 'EXCESS_ITBIS_WITHHOLDING', 'expectedTotals');
  const totals = {
    net: money(net),
    itbis: money(itbis),
    total: money(net + itbis),
    itbisWithheld: money(itbisWithheld),
    isrWithheld: money(isrWithheld),
  };
  for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
    requireFiscal(
      request.expectedTotals[key] === totals[key],
      'TOTAL_MISMATCH',
      `expectedTotals.${key}`,
    );
  }
  return { lines, bases: bases.map(money), taxes: taxes.map(money), present, totals };
}

function validateRules(request: FiscalRequestV1, amounts: ReturnType<typeof calculate>) {
  if ([31, 32, 44, 45, 46].includes(request.type))
    requireFiscal(request.incomeType, 'INCOME_TYPE_REQUIRED', 'incomeType');
  if (!hasIncome(request.type))
    requireFiscal(request.incomeType === undefined, 'INCOME_TYPE_NOT_APPLICABLE', 'incomeType');
  if ([31, 41, 45].includes(request.type))
    requireFiscal(request.buyer?.kind === 'DOMESTIC', 'DOMESTIC_BUYER_REQUIRED', 'buyer');
  if ([33, 34, 44, 46].includes(request.type))
    requireFiscal(request.buyer, 'BUYER_REQUIRED_PROFILE', 'buyer');
  if (request.type === 43)
    requireFiscal(request.buyer === undefined, 'BUYER_NOT_APPLICABLE', 'buyer');
  if (request.type === 47 && request.buyer)
    requireFiscal(request.buyer.kind === 'FOREIGN', 'FOREIGN_BUYER_REQUIRED', 'buyer');
  if (request.type === 32 && cents(amounts.totals.total) >= 25_000_000n)
    requireFiscal(request.buyer, 'BUYER_REQUIRED_THRESHOLD', 'buyer');
  if (request.payment.type === 2) {
    requireFiscal(request.type !== 43, 'CREDIT_NOT_SUPPORTED_PROFILE', 'payment.type');
    requireFiscal(
      request.payment.dueOn && request.payment.dueOn >= request.issuedOn,
      'CREDIT_DUE_DATE_REQUIRED',
      'payment.dueOn',
    );
  } else
    requireFiscal(
      request.payment.dueOn === undefined,
      'CASH_DUE_DATE_NOT_APPLICABLE',
      'payment.dueOn',
    );
  if (isNote(request.type)) {
    requireFiscal(request.reference, 'REFERENCE_REQUIRED', 'reference');
    requireFiscal(
      request.reference.issuedOn <= request.issuedOn,
      'FUTURE_REFERENCE',
      'reference.issuedOn',
    );
    requireFiscal(
      !isNote(parseEncf(request.reference.encf).type),
      'REFERENCE_TO_NOTE_NOT_SUPPORTED_PROFILE',
      'reference.encf',
    );
    if (request.type === 33)
      requireFiscal(
        request.reference.code === 3,
        'DEBIT_CODE_NOT_SUPPORTED_PROFILE',
        'reference.code',
      );
    if (request.reference.code === 2) {
      requireFiscal(
        amounts.lines.every((line) => cents(line.net) === 0n),
        'TEXT_CORRECTION_MUST_BE_ZERO',
        'lines',
      );
    }
    // Beyond 30 days the treatment of ITBIS needs a distinct rule set; never silently
    // turn a taxed credit into an exempt one. This initial profile rejects that case.
    if (request.type === 34 && ageDays(request.reference.issuedOn, request.issuedOn) > 30) {
      requireFiscal(
        request.lines.every((line) => line.billingIndicator === 4),
        'LATE_TAX_CREDIT_NOT_SUPPORTED_PROFILE',
        'reference.issuedOn',
      );
    }
  } else
    requireFiscal(request.reference === undefined, 'REFERENCE_NOT_SUPPORTED_PROFILE', 'reference');
}

/** Runs BEFORE reservation. No database mutation or sequence consumption here. */
export function analyzeFiscalRequest(scope: FiscalScope, input: unknown) {
  const snapshot = snapshotFiscalRequest(scope, input);
  const amounts = calculate(snapshot.request);
  validateRules(snapshot.request, amounts);
  return deepFreeze({ ...snapshot, profile: 'DOP_BASIC_V1' as const, amounts });
}

/** Evidence from the future repository, not an authorization supplied by an HTTP client. */
export type FiscalReservationBinding = Readonly<{
  scope: FiscalScope;
  operationId: string;
  payloadSha256: string;
  encf: string;
  businessDate: string;
  validUntil: string | null;
}>;

export function mapFiscalRequest(
  scope: FiscalScope,
  input: unknown,
  reservation: FiscalReservationBinding,
  plannedSignatureAt: string,
) {
  const analysis = analyzeFiscalRequest(scope, input);
  const { request, amounts } = analysis;
  requireFiscal(
    scopeKey(reservation.scope) === scopeKey(analysis.scope) &&
      reservation.operationId === request.operationId &&
      reservation.payloadSha256 === analysis.payloadSha256 &&
      reservation.businessDate === request.issuedOn &&
      parseEncf(reservation.encf).type === request.type,
    'RESERVATION_BINDING_MISMATCH',
    'reservation',
  );
  if (reservation.validUntil !== null) {
    assertBusinessDate(reservation.validUntil);
    requireFiscal(
      reservation.validUntil >= request.issuedOn,
      'EXPIRED_SEQUENCE',
      'reservation.validUntil',
    );
  }
  if (![32, 34].includes(request.type))
    requireFiscal(reservation.validUntil, 'SEQUENCE_EXPIRY_REQUIRED', 'reservation.validUntil');
  requireFiscal(reservation.encf !== request.reference?.encf, 'SELF_REFERENCE', 'reference.encf');
  requireFiscal(
    typeof plannedSignatureAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d-04:00$/.test(plannedSignatureAt),
    'INVALID_SIGNATURE_TIME',
    'plannedSignatureAt',
  );
  const signatureDay = plannedSignatureAt.slice(0, 10);
  assertBusinessDate(signatureDay);
  requireFiscal(
    signatureDay >= request.issuedOn,
    'SIGNATURE_BEFORE_ISSUANCE',
    'plannedSignatureAt',
  );
  const id: XmlElement[] = [e('TipoeCF', String(request.type)), e('eNCF', reservation.encf)];
  if (![32, 34].includes(request.type))
    id.push(e('FechaVencimientoSecuencia', dgiiDate(reservation.validUntil!)));
  if (request.type === 34)
    id.push(
      e(
        'IndicadorNotaCredito',
        ageDays(request.reference!.issuedOn, request.issuedOn) > 30 ? '1' : '0',
      ),
    );
  if (hasTaxIndicator(request.type)) id.push(e('IndicadorMontoGravado', '0'));
  if (request.incomeType) id.push(e('TipoIngresos', request.incomeType));
  id.push(e('TipoPago', String(request.payment.type)));
  if (request.payment.dueOn) id.push(e('FechaLimitePago', dgiiDate(request.payment.dueOn)));
  const header: XmlElement[] = [
    e('Version', '1.0'),
    e('IdDoc', id),
    e('Emisor', [
      e('RNCEmisor', request.issuer.rnc),
      e('RazonSocialEmisor', request.issuer.fiscalName),
      e('DireccionEmisor', request.issuer.address),
      e('FechaEmision', dgiiDate(request.issuedOn)),
    ]),
  ];
  if (request.buyer)
    header.push(
      e('Comprador', [
        e(
          request.buyer.kind === 'DOMESTIC' ? 'RNCComprador' : 'IdentificadorExtranjero',
          request.buyer.identifier,
        ),
        e('RazonSocialComprador', request.buyer.fiscalName),
      ]),
    );
  else if (request.type === 32) header.push(e('Comprador', [])); // Required container, optional identity.
  const totalFields: XmlElement[] = [];
  const taxed = amounts.present.slice(0, 3).some(Boolean);
  if (taxed)
    totalFields.push(
      e(
        'MontoGravadoTotal',
        money(amounts.bases.slice(0, 3).reduce((sum, value) => sum + cents(value), 0n)),
      ),
    );
  for (let index = 0; index < 3; index++)
    if (amounts.present[index])
      totalFields.push(e(`MontoGravadoI${index + 1}`, amounts.bases[index]));
  if (amounts.present[3]) totalFields.push(e('MontoExento', amounts.bases[3]));
  for (let index = 0; index < 3; index++)
    if (amounts.present[index]) totalFields.push(e(`ITBIS${index + 1}`, String(RATES[index])));
  if (taxed) totalFields.push(e('TotalITBIS', amounts.totals.itbis));
  for (let index = 0; index < 3; index++)
    if (amounts.present[index]) totalFields.push(e(`TotalITBIS${index + 1}`, amounts.taxes[index]));
  totalFields.push(e('MontoTotal', amounts.totals.total));
  if (request.lines.some((line) => line.withholding)) {
    if (request.type !== 47)
      totalFields.push(e('TotalITBISRetenido', amounts.totals.itbisWithheld));
    totalFields.push(e('TotalISRRetencion', amounts.totals.isrWithheld));
  }
  header.push(e('Totales', totalFields));
  const details = request.lines.map((line, index) => {
    const nodes: XmlElement[] = [
      e('NumeroLinea', String(index + 1)),
      e('IndicadorFacturacion', String(line.billingIndicator)),
    ];
    if (line.withholding)
      nodes.push(
        e('Retencion', [
          e('IndicadorAgenteRetencionoPercepcion', '1'),
          ...(request.type !== 47 ? [e('MontoITBISRetenido', line.withholding.itbis)] : []),
          // E41 goods do not carry an ISR service retention; the contract requires zero.
          ...(request.type === 41 && line.kind === 'GOOD'
            ? []
            : [e('MontoISRRetenido', line.withholding.isr)]),
        ]),
      );
    nodes.push(
      e('NombreItem', line.description),
      e('IndicadorBienoServicio', line.kind === 'GOOD' ? '1' : '2'),
      e('CantidadItem', line.quantity),
      e('PrecioUnitarioItem', line.unitPrice),
    );
    if (cents(line.discount) > 0n)
      nodes.push(
        e('DescuentoMonto', line.discount),
        e('TablaSubDescuento', [
          e('SubDescuento', [e('TipoSubDescuento', '$'), e('MontoSubDescuento', line.discount)]),
        ]),
      );
    nodes.push(e('MontoItem', amounts.lines[index].net));
    return e('Item', nodes);
  });
  const sections: XmlElement[] = [e('Encabezado', header), e('DetallesItems', details)];
  if (request.reference)
    sections.push(
      e('InformacionReferencia', [
        e('NCFModificado', request.reference.encf),
        e('FechaNCFModificado', dgiiDate(request.reference.issuedOn)),
        e('CodigoModificacion', String(request.reference.code)),
        e('RazonModificacion', request.reference.reason),
      ]),
    );
  sections.push(
    e('FechaHoraFirma', `${dgiiDate(signatureDay)} ${plannedSignatureAt.slice(11, 19)}`),
  );
  return deepFreeze({ ...analysis, sections });
}

/** Only this wrapper adds the real XSD check; still NEVER signs or sends anything. */
export async function prepareMappedEcfDraft(
  scope: FiscalScope,
  input: unknown,
  reservation: FiscalReservationBinding,
  plannedSignatureAt: string,
  validator: DraftSchemaValidator,
) {
  const mapped = mapFiscalRequest(scope, input, reservation, plannedSignatureAt);
  const draft = await prepareEcfDraft(
    mapped.scope,
    mapped.request.type,
    mapped.sections,
    validator,
  );
  return deepFreeze({
    ...draft,
    mappingProfile: mapped.profile,
    payloadSha256: mapped.payloadSha256,
    source: mapped.request.source,
    operationId: mapped.request.operationId,
  });
}
