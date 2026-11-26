import { ECF_TYPES, assertScope, type EcfType, type FiscalScope } from './catalog.ts';
import { FiscalContractError, requireFiscal } from './contract.ts';
import type { FiscalRegistrationConnection } from './request-repository.ts';

export type AuthorizedRangeInput = Readonly<{
  registrationId: string;
  tenantId: string;
  issuerRnc: string;
  ecfType: EcfType;
  startNumber: string;
  endNumber: string;
  nextNumber: string;
  authorizationNumber: string;
  authorizedAt: string | null;
  validUntil: string | null;
}>;

const date = /^\d{4}-\d{2}-\d{2}$/;
const number = /^[1-9][0-9]{0,9}$/;
const validDate = (value: string) => {
  if (!date.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};

export function parseAuthorizedRangeInput(
  scope: FiscalScope,
  input: unknown,
): AuthorizedRangeInput {
  assertScope(scope);
  requireFiscal(scope.environment === 'production', 'PRODUCTION_SCOPE_REQUIRED', 'scope');
  requireFiscal(
    !!input && typeof input === 'object' && !Array.isArray(input),
    'INVALID_RANGE',
    'body',
  );
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expected = [
    'authorizationNumber',
    'authorizedAt',
    'ecfType',
    'endNumber',
    'issuerRnc',
    'nextNumber',
    'registrationId',
    'startNumber',
    'tenantId',
    'validUntil',
  ].sort();
  requireFiscal(JSON.stringify(keys) === JSON.stringify(expected), 'INVALID_RANGE', 'fields');
  requireFiscal(
    typeof value.registrationId === 'string' && /^[a-z0-9]{20,32}$/.test(value.registrationId),
    'INVALID_RANGE',
    'registrationId',
  );
  requireFiscal(value.tenantId === scope.tenantId, 'SCOPE_MISMATCH', 'tenantId');
  requireFiscal(value.issuerRnc === scope.issuerRnc, 'SCOPE_MISMATCH', 'issuerRnc');
  requireFiscal(ECF_TYPES.includes(value.ecfType as EcfType), 'INVALID_RANGE', 'ecfType');
  for (const field of ['startNumber', 'endNumber', 'nextNumber'] as const) {
    requireFiscal(
      typeof value[field] === 'string' && number.test(value[field]),
      'INVALID_RANGE',
      field,
    );
  }
  const first = BigInt(value.startNumber as string);
  const last = BigInt(value.endNumber as string);
  const next = BigInt(value.nextNumber as string);
  requireFiscal(first <= last && last <= 9_999_999_999n, 'INVALID_RANGE', 'range');
  requireFiscal(next >= first && next <= last, 'INVALID_RANGE', 'nextNumber');
  requireFiscal(
    typeof value.authorizationNumber === 'string' &&
      value.authorizationNumber === value.authorizationNumber.trim() &&
      value.authorizationNumber.length >= 1 &&
      value.authorizationNumber.length <= 120,
    'INVALID_RANGE',
    'authorizationNumber',
  );
  for (const field of ['authorizedAt', 'validUntil'] as const) {
    requireFiscal(
      value[field] === null || (typeof value[field] === 'string' && validDate(value[field])),
      'INVALID_RANGE',
      field,
    );
  }
  if (value.authorizedAt && value.validUntil) {
    requireFiscal(value.validUntil >= value.authorizedAt, 'INVALID_RANGE', 'validUntil');
  }
  return Object.freeze(value as AuthorizedRangeInput);
}

export async function registerAuthorizedRange(
  connection: FiscalRegistrationConnection,
  scope: FiscalScope,
  input: unknown,
) {
  const range = parseAuthorizedRangeInput(scope, input);
  let result: Awaited<ReturnType<FiscalRegistrationConnection['query']>>;
  try {
    result = await connection.query(
      `SELECT range_id::text, reused
       FROM corestack_fiscal.register_authorized_range(
         $1::text,$2::text,$3::text,$4::smallint,$5::bigint,$6::bigint,$7::bigint,
         $8::text,NULLIF($9::text,'')::date,NULLIF($10::text,'')::date
       )`,
      [
        range.registrationId,
        range.tenantId,
        range.issuerRnc,
        String(range.ecfType),
        range.startNumber,
        range.endNumber,
        range.nextNumber,
        range.authorizationNumber,
        range.authorizedAt ?? '',
        range.validUntil ?? '',
      ],
    );
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === '23P01' || code === '23505') {
      throw new FiscalContractError('AUTHORIZED_RANGE_CONFLICT', 'range');
    }
    if (code === '22023' || code === '28000') {
      throw new FiscalContractError('AUTHORIZED_RANGE_REJECTED', 'range');
    }
    throw error;
  }
  requireFiscal(result.rows.length === 1, 'INVALID_PERSISTENCE_RESULT', 'rows');
  const row = result.rows[0]!;
  requireFiscal(
    typeof row.range_id === 'string' &&
      /^[1-9][0-9]{0,18}$/.test(row.range_id) &&
      typeof row.reused === 'boolean',
    'INVALID_PERSISTENCE_RESULT',
    'range',
  );
  return Object.freeze({
    rangeId: row.range_id as string,
    registrationId: range.registrationId,
    reused: row.reused as boolean,
    status: 'REGISTERED' as const,
    environment: 'production' as const,
  });
}

export async function readAuthorizedRanges(connection: FiscalRegistrationConnection) {
  const result = await connection.query(
    'SELECT corestack_fiscal.read_authorized_ranges() AS ranges',
    [],
  );
  requireFiscal(result.rows.length === 1, 'INVALID_PERSISTENCE_RESULT', 'ranges');
  const ranges = result.rows[0]?.ranges;
  requireFiscal(Array.isArray(ranges), 'INVALID_PERSISTENCE_RESULT', 'ranges');
  return Object.freeze(ranges);
}

export async function readProductionDocumentStatus(
  connection: FiscalRegistrationConnection,
  documentId: string,
) {
  requireFiscal(/^[1-9][0-9]{0,18}$/.test(documentId), 'INVALID_DOCUMENT_ID', 'documentId');
  const result = await connection.query(
    'SELECT corestack_fiscal.read_document_status($1::bigint) AS status',
    [documentId],
  );
  requireFiscal(result.rows.length === 1, 'INVALID_PERSISTENCE_RESULT', 'status');
  return result.rows[0]?.status ?? null;
}

export async function readAcceptedPrintedRepresentation(
  connection: FiscalRegistrationConnection,
  documentId: string,
) {
  requireFiscal(/^[1-9][0-9]{0,18}$/.test(documentId), 'INVALID_DOCUMENT_ID', 'documentId');
  const result = await connection.query(
    'SELECT corestack_fiscal.read_accepted_printed_representation($1::bigint) AS representation',
    [documentId],
  );
  requireFiscal(result.rows.length === 1, 'INVALID_PERSISTENCE_RESULT', 'representation');
  return result.rows[0]?.representation ?? null;
}
