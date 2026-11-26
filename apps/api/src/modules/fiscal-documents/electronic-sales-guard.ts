import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export type ElectronicSalesScope = { tenantId: string; issuerRnc: string; environment: 'production' };
type ObjectValue = Record<string, unknown>;

function requireInput(ok: unknown, field: string): asserts ok {
  if (!ok) throw new BadRequestException(`Datos fiscales inválidos en ${field}. Corrígelos antes de cobrar.`);
}
function object(value: unknown, required: string[], optional: string[] = [], path = 'solicitud'): ObjectValue {
  requireInput(value !== null && typeof value === 'object' && !Array.isArray(value), path);
  const result = value as ObjectValue;
  requireInput(required.every(key => Object.hasOwn(result, key)) &&
    Object.keys(result).every(key => required.includes(key) || optional.includes(key)), path);
  return result;
}
function text(value: unknown, limit: number, field: string) {
  requireInput(typeof value === 'string' && value.length > 0 && value === value.trim() &&
    Array.from(value).length <= limit &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value), field);
  return value;
}
function date(value: unknown, field: string) {
  requireInput(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), field);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  requireInput(Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value, field);
  return value;
}
function decimal(value: unknown, scale: 2 | 4, field: string) {
  requireInput(typeof value === 'string' && new RegExp(`^(?:0|[1-9]\\d{0,15})\\.\\d{${scale}}$`).test(value), field);
  const [whole, fraction] = value.split('.');
  return BigInt(whole!) * 10n ** BigInt(scale) + BigInt(fraction!);
}
const round = (value: bigint, denominator: bigint) => (2n * value + denominator) / (2n * denominator);

export function canonicalElectronicSalesValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalElectronicSalesValue).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalElectronicSalesValue(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function electronicSalesDigest(scope: ElectronicSalesScope, request: unknown) {
  return createHash('sha256').update(canonicalElectronicSalesValue({ scope, request }), 'utf8').digest('hex');
}

/** Strict E31/E32 producer profile, verified by parity tests against the core.
 * Runs inside the checkout transaction BEFORE payment/inventory/outbox commit.
 * Never repairs immutable input, truncates names, changes money or reserves NCF.
 */
export function validateElectronicSalesRequest(input: unknown, scope: ElectronicSalesScope) {
  text(scope.tenantId, 200, 'empresa');
  requireInput(scope.environment === 'production' && /^(?:\d{9}|\d{11})$/.test(scope.issuerRnc), 'emisor');
  const r = object(input, ['version','operationId','source','type','issuedOn','currency','pricesIncludeTax',
    'issuer','incomeType','payment','lines','expectedTotals'], ['buyer']);
  requireInput(r.version === '1' && [31, 32].includes(r.type as number) && r.currency === 'DOP' && r.pricesIncludeTax === false, 'perfil');
  text(r.operationId, 200, 'operación');
  const source = object(r.source, ['documentId','revision'], [], 'origen');
  text(source.documentId, 200, 'origen.documento');text(source.revision, 100, 'origen.revisión');
  const issued = date(r.issuedOn, 'fecha');
  const issuer = object(r.issuer, ['rnc','fiscalName','address'], [], 'emisor');
  requireInput(issuer.rnc === scope.issuerRnc, 'emisor.RNC');
  text(issuer.fiscalName, 150, 'emisor.nombre');text(issuer.address, 100, 'emisor.dirección');
  requireInput(['01','02','03','04','05','06'].includes(r.incomeType as string), 'tipo de ingreso');
  let buyerKind: unknown;
  if (r.buyer !== undefined) {
    const buyer = object(r.buyer, ['kind','identifier','fiscalName'], [], 'comprador');
    buyerKind = buyer.kind;
    requireInput(buyer.kind === 'DOMESTIC' || buyer.kind === 'FOREIGN', 'comprador.tipo');
    if (buyer.kind === 'DOMESTIC') requireInput(typeof buyer.identifier === 'string' && /^(?:\d{9}|\d{11})$/.test(buyer.identifier), 'comprador.RNC o cédula');
    else text(buyer.identifier, 20, 'comprador.documento');
    text(buyer.fiscalName, 150, 'comprador.nombre');
  }
  requireInput(r.type !== 31 || buyerKind === 'DOMESTIC', 'comprador de E31');
  const payment = object(r.payment, ['type'], ['dueOn'], 'pago');
  requireInput(payment.type === 1 || payment.type === 2, 'pago.tipo');
  if (payment.type === 2) requireInput(date(payment.dueOn, 'pago.vencimiento') >= issued, 'pago.vencimiento');
  else requireInput(payment.dueOn === undefined, 'pago.vencimiento');
  requireInput(Array.isArray(r.lines) && r.lines.length > 0 && r.lines.length <= 1000, 'cantidad de líneas');
  const ids = new Set<string>(), bases = [0n, 0n, 0n, 0n];
  for (const [index, value] of r.lines.entries()) {
    const field = `línea ${index + 1}`;
    const line = object(value, ['sourceLineId','description','kind','quantity','unitPrice','discount','billingIndicator'], [], field);
    const id = text(line.sourceLineId, 200, `${field}.identificador`);
    requireInput(!ids.has(id), `${field}.identificador duplicado`);ids.add(id);
    text(line.description, 80, `${field}.descripción`);
    requireInput(line.kind === 'GOOD' || line.kind === 'SERVICE', `${field}.clasificación`);
    requireInput([1,2,4].includes(line.billingIndicator as number), `${field}.impuesto`);
    const quantity = decimal(line.quantity, 2, `${field}.cantidad`);
    const price = decimal(line.unitPrice, 4, `${field}.precio`);
    const discount = decimal(line.discount, 2, `${field}.descuento`);
    requireInput(quantity > 0n && discount * 10000n <= quantity * price, `${field}.cantidad o descuento`);
    bases[(line.billingIndicator as number) - 1] += round(quantity * price - discount * 10000n, 10000n);
  }
  const net = bases.reduce((sum, n) => sum + n, 0n);
  const itbis = round(bases[0]! * 18n, 100n) + round(bases[1]! * 16n, 100n);
  const totals = object(r.expectedTotals, ['net','itbis','total','itbisWithheld','isrWithheld'], [], 'totales');
  for (const [key, expected] of Object.entries({ net, itbis, total: net + itbis, itbisWithheld: 0n, isrWithheld: 0n })) {
    requireInput(decimal(totals[key], 2, `totales.${key}`) === expected, `totales.${key}`);
  }
  // Same rule as the isolated core. Do not collect money for a request that
  // this deployed profile will reject later for a missing buyer.
  requireInput(r.type !== 32 || net + itbis < 25000000n || r.buyer !== undefined, 'comprador requerido para este importe E32');
  requireInput(Buffer.byteLength(JSON.stringify(r), 'utf8') <= 512 * 1024, 'tamaño del documento');
}
