import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FiscalScope } from './catalog.ts';
import { assertScope } from './catalog.ts';
import { FiscalContractError, requireFiscal, serializeFiscalSnapshot } from './contract.ts';
import type { DraftSchemaValidator } from './draft.ts';
import { analyzeFiscalRequest, prepareMappedEcfDraft } from './mapper.ts';
import type { FiscalRegistrationConnection } from './request-repository.ts';
import {
  SchemaUnavailableError,
  SchemaValidationError,
  XmllintDraftValidator,
} from './xsd-validator.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

type Claim = {
  jobId: string;
  documentId: string;
  claimToken: string;
  snapshotText: string;
  payloadSha256: string;
  encf: string;
  validUntil: string | null;
  plannedSignatureAt: string;
};

function checkedClaim(input: unknown): Claim {
  requireFiscal(!!input && typeof input === 'object', 'INVALID_CLAIM', 'claim');
  const c = input as Record<string, unknown>;
  for (const field of ['jobId', 'documentId'])
    requireFiscal(
      typeof c[field] === 'string' && /^[1-9][0-9]*$/.test(c[field] as string),
      'INVALID_CLAIM',
      field,
    );
  requireFiscal(
    typeof c.claimToken === 'string' && /^[0-9a-f-]{36}$/.test(c.claimToken),
    'INVALID_CLAIM',
    'claimToken',
  );
  for (const field of ['snapshotText', 'payloadSha256', 'encf', 'plannedSignatureAt'])
    requireFiscal(typeof c[field] === 'string', 'INVALID_CLAIM', field);
  requireFiscal(
    c.validUntil === null || typeof c.validUntil === 'string',
    'INVALID_CLAIM',
    'validUntil',
  );
  return c as Claim;
}

/** One bounded job, no signing/sending. A supervisor may call again after IDLE.
 * Claims expire server-side; an obsolete worker cannot store or fail a newer attempt.
 * Database exceptions never become fiscal error messages or logged XML.
 */
export async function runPreparationOnce(
  connection: FiscalRegistrationConnection,
  trustedScope: FiscalScope,
  validator: DraftSchemaValidator = new XmllintDraftValidator(),
) {
  assertScope(trustedScope);
  assertFiscalEnvironmentEnabled(trustedScope);
  const rows = (await connection.query('SELECT corestack_fiscal.claim_preparation() AS claim', []))
    .rows;
  requireFiscal(rows.length === 1, 'INVALID_CLAIM', 'rows');
  if (rows[0]!.claim === null) return Object.freeze({ result: 'IDLE' as const, sendable: false });
  const claim = checkedClaim(rows[0]!.claim);
  let artifact: Awaited<ReturnType<typeof prepareMappedEcfDraft>>;
  let schemaHash: string;
  let invalidSnapshot = true;
  try {
    requireFiscal(
      Buffer.byteLength(claim.snapshotText, 'utf8') <= 524288,
      'INVALID_SNAPSHOT',
      'size',
    );
    const saved = JSON.parse(claim.snapshotText);
    const analysis = analyzeFiscalRequest(trustedScope, saved.request);
    requireFiscal(
      serializeFiscalSnapshot(trustedScope, analysis.request) === claim.snapshotText &&
        analysis.payloadSha256 === claim.payloadSha256,
      'INVALID_SNAPSHOT',
      'digest',
    );
    invalidSnapshot = false;
    artifact = await prepareMappedEcfDraft(
      trustedScope,
      analysis.request,
      {
        scope: analysis.scope,
        operationId: analysis.request.operationId,
        payloadSha256: analysis.payloadSha256,
        encf: claim.encf,
        businessDate: analysis.request.issuedOn,
        validUntil: claim.validUntil,
      },
      claim.plannedSignatureAt,
      validator,
    );
    const schema = await readFile(
      new URL(`../schemas/ecf-${analysis.request.type}.xsd`, import.meta.url),
    );
    schemaHash = createHash('sha256').update(schema).digest('hex');
    const manifest = JSON.parse(
      await readFile(new URL('../schemas/manifest.json', import.meta.url), 'utf8'),
    );
    requireFiscal(
      manifest.files[`ecf-${analysis.request.type}.xsd`]?.sha256 === schemaHash,
      'SCHEMA_INTEGRITY',
      'schema',
    );
  } catch (error) {
    const code = invalidSnapshot
      ? 'INVALID_SNAPSHOT'
      : error instanceof SchemaValidationError || error instanceof FiscalContractError
        ? 'INVALID_XML'
        : error instanceof SchemaUnavailableError
          ? 'SCHEMA_UNAVAILABLE'
          : 'WORKER_UNAVAILABLE';
    try {
      const result = await connection.query(
        'SELECT corestack_fiscal.fail_preparation($1::bigint,$2::uuid,$3::text) AS state',
        [claim.jobId, claim.claimToken, code],
      );
      const state = result.rows[0]?.state;
      requireFiscal(state === 'PENDING' || state === 'FAILED', 'INVALID_JOB_RESULT', 'state');
      return Object.freeze({ result: state, documentId: claim.documentId, code, sendable: false });
    } catch {
      // Stale lease or unknown DB outcome: let the lease/recovery mechanism decide.
      return Object.freeze({
        result: 'UNCERTAIN' as const,
        documentId: claim.documentId,
        sendable: false,
      });
    }
  }
  try {
    const result = await connection.query(
      'SELECT corestack_fiscal.complete_preparation($1::bigint,$2::uuid,$3::text,$4::text,$5::text,$6::text) AS stored',
      [
        claim.jobId,
        claim.claimToken,
        artifact.xml,
        artifact.sha256,
        schemaHash,
        artifact.plannedSubmissionRoute,
      ],
    );
    requireFiscal(result.rows[0]?.stored === true, 'INVALID_JOB_RESULT', 'stored');
  } catch {
    // Never mark FAILED after an ambiguous COMMIT; the artifact may already exist.
    return Object.freeze({
      result: 'UNCERTAIN' as const,
      documentId: claim.documentId,
      sendable: false,
    });
  }
  return Object.freeze({
    result: 'UNSIGNED_XML_STORED' as const,
    documentId: claim.documentId,
    xmlSha256: artifact.sha256,
    sendable: false,
  });
}
