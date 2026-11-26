import { createHash } from 'node:crypto';
import { parseEncf } from './encf.ts';
import { requireFiscal } from './contract.ts';
import type { FiscalRegistrationConnection } from './request-repository.ts';

/** Scope comes from the provisioned DB login, never an HTTP tenant parameter.
 * Return unsigned preparation evidence only; not an issuance/DGII status.
 */
export async function readFiscalPreparation(
  connection: FiscalRegistrationConnection,
  documentId: string,
) {
  assertPreparationDocumentId(documentId);
  const result = await connection.query(
    'SELECT corestack_fiscal.read_preparation($1::bigint) AS preparation',
    [documentId],
  );
  requireFiscal(result.rows.length === 1, 'INVALID_PREPARATION_RESULT', 'rows');
  return validateFiscalPreparation(result.rows[0]!.preparation, documentId);
}

export function assertPreparationDocumentId(documentId: string) {
  requireFiscal(
    /^[1-9][0-9]{0,18}$/.test(documentId) && BigInt(documentId) <= 9223372036854775807n,
    'INVALID_DOCUMENT_ID',
    'documentId',
  );
}

/** Validate the same evidence at both database and HTTP boundaries. */
export function validateFiscalPreparation(value: unknown, documentId: string) {
  assertPreparationDocumentId(documentId);
  if (value === null) return null;
  requireFiscal(
    !!value && typeof value === 'object' && !Array.isArray(value),
    'INVALID_PREPARATION_RESULT',
    'document',
  );
  const row = value as Record<string, unknown>;
  requireFiscal(
    row.documentId === documentId &&
      typeof row.encf === 'string' &&
      row.sendable === false &&
      ['PENDING', 'RUNNING', 'DONE', 'FAILED'].includes(row.state as string) &&
      Number.isInteger(row.attempts) &&
      (row.attempts as number) >= 0 &&
      (row.attempts as number) <= 5,
    'INVALID_PREPARATION_RESULT',
    'state',
  );
  parseEncf(row.encf as string);
  const done = row.state === 'DONE';
  if (done) {
    requireFiscal(
      typeof row.xml === 'string' &&
        Buffer.byteLength(row.xml) <= 8 * 1024 * 1024 &&
        typeof row.schemaSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(row.schemaSha256) &&
        row.xmlSha256 === createHash('sha256').update(row.xml).digest('hex'),
      'INVALID_PREPARATION_RESULT',
      'artifact',
    );
  } else {
    requireFiscal(
      row.xml === null && row.xmlSha256 === null && row.schemaSha256 === null,
      'INVALID_PREPARATION_RESULT',
      'artifact',
    );
  }
  return Object.freeze({
    documentId,
    encf: row.encf as string,
    state: row.state as 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED',
    attempts: row.attempts as number,
    lastErrorCode:
      typeof row.lastErrorCode === 'string' && /^[A-Z_]{1,64}$/.test(row.lastErrorCode)
        ? row.lastErrorCode
        : null,
    xml: done ? (row.xml as string) : null,
    xmlSha256: done ? (row.xmlSha256 as string) : null,
    schemaSha256: done ? (row.schemaSha256 as string) : null,
    schemaValidated: done,
    signed: false as const,
    sendable: false as const,
  });
}
