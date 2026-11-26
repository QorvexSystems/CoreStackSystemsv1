import { createHash } from 'node:crypto';
import { assertEcfType, assertScope } from './catalog.ts';
import type { EcfType, FiscalScope } from './catalog.ts';
import { assertBusinessDate, parseEncf } from './encf.ts';
import { fixedDecimal, scaledDecimal } from './decimal.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

export type FiscalLine = Readonly<{
  sourceLineId: string;
  description: string;
  kind: 'GOOD' | 'SERVICE';
  quantity: string;
  unitPrice: string;
  billingIndicator: 1 | 2 | 3 | 4;
  discount: string;
  withholding?: Readonly<{ itbis: string; isr: string }>;
}>;

export type FiscalRequestV1 = Readonly<{
  version: '1';
  operationId: string;
  source: Readonly<{ documentId: string; revision: string }>;
  type: EcfType;
  issuedOn: string;
  currency: 'DOP';
  pricesIncludeTax: false;
  issuer: Readonly<{ rnc: string; fiscalName: string; address: string }>;
  buyer?: Readonly<{ kind: 'DOMESTIC' | 'FOREIGN'; identifier: string; fiscalName: string }>;
  incomeType?: '01' | '02' | '03' | '04' | '05' | '06';
  payment: Readonly<{ type: 1 | 2; dueOn?: string }>;
  reference?: Readonly<{ encf: string; issuedOn: string; code: 1 | 2 | 3; reason: string }>;
  lines: readonly FiscalLine[];
  expectedTotals: Readonly<{
    net: string;
    itbis: string;
    total: string;
    itbisWithheld: string;
    isrWithheld: string;
  }>;
}>;

export class FiscalContractError extends Error {
  readonly code: string;
  readonly field: string;
  constructor(code: string, field: string) {
    // Paths/codes only; never include the caller's fiscal data.
    super(`${code}: ${field}`);
    this.name = 'FiscalContractError';
    this.code = code;
    this.field = field;
  }
}

export function requireFiscal(condition: unknown, code: string, field: string): asserts condition {
  if (!condition) throw new FiscalContractError(code, field);
}

function object(
  value: unknown,
  allowed: readonly string[],
  field: string,
): Record<string, unknown> {
  requireFiscal(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    'INVALID_OBJECT',
    field,
  );
  const result = value as Record<string, unknown>;
  requireFiscal(
    Reflect.ownKeys(result).every(
      (key) =>
        typeof key === 'string' &&
        allowed.includes(key) &&
        'value' in Object.getOwnPropertyDescriptor(result, key)!,
    ),
    'UNKNOWN_OR_UNSUPPORTED_FIELD',
    field,
  );
  return result;
}

function text(value: unknown, max: number, field: string): string {
  requireFiscal(
    typeof value === 'string' &&
      value.length <= max * 2 &&
      value.trim().length > 0 &&
      Array.from(value.trim()).length <= max &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value),
    'INVALID_TEXT',
    field,
  );
  return value.trim();
}

function oneOf<const T extends string | number | boolean>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  requireFiscal(allowed.includes(value as T), 'UNSUPPORTED_VALUE', field);
  return value as T;
}

function date(value: unknown, field: string): string {
  requireFiscal(typeof value === 'string', 'INVALID_DATE', field);
  try {
    assertBusinessDate(value);
  } catch {
    throw new FiscalContractError('INVALID_DATE', field);
  }
  return value;
}

function decimal(value: unknown, scale: 2 | 4, field: string): string {
  try {
    return fixedDecimal(scaledDecimal(value, scale), scale);
  } catch {
    throw new FiscalContractError('INVALID_DECIMAL', field);
  }
}

function rnc(value: unknown, field: string): string {
  requireFiscal(
    typeof value === 'string' && /^(?:\d{9}|\d{11})$/.test(value),
    'INVALID_RNC_FORMAT',
    field,
  );
  return value;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A strict internal transport contract, not a Prisma model or a public HTTP DTO. */
export function parseFiscalRequest(input: unknown): FiscalRequestV1 {
  const root = object(
    input,
    [
      'version',
      'operationId',
      'source',
      'type',
      'issuedOn',
      'currency',
      'pricesIncludeTax',
      'issuer',
      'buyer',
      'incomeType',
      'payment',
      'reference',
      'lines',
      'expectedTotals',
    ],
    'request',
  );
  oneOf(root.version, ['1'], 'version');
  try {
    assertEcfType(root.type);
  } catch {
    throw new FiscalContractError('UNSUPPORTED_TYPE', 'type');
  }
  oneOf(root.currency, ['DOP'], 'currency');
  oneOf(root.pricesIncludeTax, [false], 'pricesIncludeTax');
  const source = object(root.source, ['documentId', 'revision'], 'source');
  const issuer = object(root.issuer, ['rnc', 'fiscalName', 'address'], 'issuer');
  const payment = object(root.payment, ['type', 'dueOn'], 'payment');
  const totals = object(
    root.expectedTotals,
    ['net', 'itbis', 'total', 'itbisWithheld', 'isrWithheld'],
    'expectedTotals',
  );
  const result: FiscalRequestV1 = {
    version: '1',
    operationId: text(root.operationId, 200, 'operationId'),
    source: {
      documentId: text(source.documentId, 200, 'source.documentId'),
      revision: text(source.revision, 100, 'source.revision'),
    },
    type: root.type,
    issuedOn: date(root.issuedOn, 'issuedOn'),
    currency: 'DOP',
    pricesIncludeTax: false,
    issuer: {
      rnc: rnc(issuer.rnc, 'issuer.rnc'),
      fiscalName: text(issuer.fiscalName, 150, 'issuer.fiscalName'),
      address: text(issuer.address, 100, 'issuer.address'),
    },
    ...(root.buyer !== undefined
      ? {
          buyer: (() => {
            const buyer = object(root.buyer, ['kind', 'identifier', 'fiscalName'], 'buyer');
            const kind = oneOf(buyer.kind, ['DOMESTIC', 'FOREIGN'], 'buyer.kind');
            return {
              kind,
              identifier:
                kind === 'DOMESTIC'
                  ? rnc(buyer.identifier, 'buyer.identifier')
                  : text(buyer.identifier, 20, 'buyer.identifier'),
              fiscalName: text(buyer.fiscalName, 150, 'buyer.fiscalName'),
            };
          })(),
        }
      : {}),
    ...(root.incomeType !== undefined
      ? { incomeType: oneOf(root.incomeType, ['01', '02', '03', '04', '05', '06'], 'incomeType') }
      : {}),
    payment: {
      type: oneOf(payment.type, [1, 2], 'payment.type'),
      ...(payment.dueOn !== undefined ? { dueOn: date(payment.dueOn, 'payment.dueOn') } : {}),
    },
    ...(root.reference !== undefined
      ? {
          reference: (() => {
            const ref = object(root.reference, ['encf', 'issuedOn', 'code', 'reason'], 'reference');
            try {
              parseEncf(ref.encf as string);
            } catch {
              throw new FiscalContractError('INVALID_ENCF', 'reference.encf');
            }
            return {
              encf: ref.encf as string,
              issuedOn: date(ref.issuedOn, 'reference.issuedOn'),
              code: oneOf(ref.code, [1, 2, 3], 'reference.code'),
              reason: text(ref.reason, 90, 'reference.reason'),
            };
          })(),
        }
      : {}),
    lines: (() => {
      requireFiscal(
        Array.isArray(root.lines) && root.lines.length > 0 && root.lines.length <= 1000,
        'INVALID_LINE_COUNT',
        'lines',
      );
      const ids = new Set<string>();
      return Array.from(root.lines, (raw, index): FiscalLine => {
        const path = `lines[${index}]`;
        const line = object(
          raw,
          [
            'sourceLineId',
            'description',
            'kind',
            'quantity',
            'unitPrice',
            'billingIndicator',
            'discount',
            'withholding',
          ],
          path,
        );
        const sourceLineId = text(line.sourceLineId, 200, `${path}.sourceLineId`);
        requireFiscal(!ids.has(sourceLineId), 'DUPLICATE_LINE', `${path}.sourceLineId`);
        ids.add(sourceLineId);
        const quantity = decimal(line.quantity, 2, `${path}.quantity`);
        requireFiscal(scaledDecimal(quantity, 2) > 0n, 'NONPOSITIVE_QUANTITY', `${path}.quantity`);
        return {
          sourceLineId,
          description: text(line.description, 80, `${path}.description`),
          kind: oneOf(line.kind, ['GOOD', 'SERVICE'], `${path}.kind`),
          quantity,
          unitPrice: decimal(line.unitPrice, 4, `${path}.unitPrice`),
          billingIndicator: oneOf(line.billingIndicator, [1, 2, 3, 4], `${path}.billingIndicator`),
          discount: decimal(
            line.discount === undefined ? '0' : line.discount,
            2,
            `${path}.discount`,
          ),
          ...(line.withholding !== undefined
            ? {
                withholding: (() => {
                  const ret = object(line.withholding, ['itbis', 'isr'], `${path}.withholding`);
                  return {
                    itbis: decimal(ret.itbis, 2, `${path}.withholding.itbis`),
                    isr: decimal(ret.isr, 2, `${path}.withholding.isr`),
                  };
                })(),
              }
            : {}),
        };
      });
    })(),
    expectedTotals: {
      net: decimal(totals.net, 2, 'expectedTotals.net'),
      itbis: decimal(totals.itbis, 2, 'expectedTotals.itbis'),
      total: decimal(totals.total, 2, 'expectedTotals.total'),
      itbisWithheld: decimal(totals.itbisWithheld, 2, 'expectedTotals.itbisWithheld'),
      isrWithheld: decimal(totals.isrWithheld, 2, 'expectedTotals.isrWithheld'),
    },
  };
  return deepFreeze(result);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Scope is supplied by an authenticated caller, never taken from the request body. */
export function snapshotFiscalRequest(scope: FiscalScope, input: unknown) {
  assertScope(scope);
  try {
    assertFiscalEnvironmentEnabled(scope);
  } catch {
    throw new FiscalContractError('PRODUCTION_DISABLED', 'scope.environment');
  }
  const savedScope = {
    tenantId: scope.tenantId,
    issuerRnc: scope.issuerRnc,
    environment: scope.environment,
  };
  const request = parseFiscalRequest(input);
  requireFiscal(request.issuer.rnc === savedScope.issuerRnc, 'ISSUER_SCOPE_MISMATCH', 'issuer.rnc');
  const payloadSha256 = createHash('sha256')
    .update(canonical({ scope: savedScope, request }), 'utf8')
    .digest('hex');
  return deepFreeze({ scope: savedScope, request, payloadSha256 });
}

/** Exact UTF-8 evidence used for the digest; database must not reserialize jsonb. */
export function serializeFiscalSnapshot(scope: FiscalScope, input: unknown): string {
  const snapshot = snapshotFiscalRequest(scope, input);
  return canonical({ scope: snapshot.scope, request: snapshot.request });
}
