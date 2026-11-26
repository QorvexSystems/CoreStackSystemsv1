import type { FiscalScope } from './catalog.ts';
import { assertScope } from './catalog.ts';
import { requireFiscal } from './contract.ts';
import { analyzeFiscalRequest } from './mapper.ts';
import type { FiscalRegistrationConnection } from './request-repository.ts';
import type { FiscalDispatchQueue } from './dispatch-worker.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

/** Called INSIDE the authorized ERP sale transaction, on the ERP database.
 * Caller owns authorization, current tax identity verification and transaction
 * retries. Never pass a pool or call this as a stand-alone issuance endpoint.
 */
export async function enqueueFiscalDispatch(
  tx: FiscalRegistrationConnection,
  scope: FiscalScope,
  input: unknown,
) {
  assertFiscalEnvironmentEnabled(scope);
  const analysis = analyzeFiscalRequest(scope, input);
  const request = analysis.request;
  requireFiscal(request.type === 31 || request.type === 32, 'UNSUPPORTED_ERP_DOCUMENT', 'type');
  const params = [scope.tenantId, scope.issuerRnc, scope.environment];
  const locked = await tx.query(
    `SELECT i.id, i."documentType" AS type,
    i.status, i."fiscalStatus" AS fiscal_status, i.ncf, i."eNcf" AS encf, i."issuedAt" AS issued_at,
    to_char(i."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS revision, t.rnc
    FROM public."Invoice" i JOIN public."Tenant" t ON t.id=i."tenantId"
    WHERE i."tenantId"=$1 AND i.id=$2 FOR UPDATE OF i, t`,
    [scope.tenantId, request.source.documentId],
  );
  const invoice = locked.rows[0];
  requireFiscal(
    locked.rows.length === 1 && invoice?.rnc === scope.issuerRnc,
    'ERP_SCOPE_MISMATCH',
    'source',
  );
  // Same frozen operation is safe to recover even if the source has moved on.
  const existing = await tx.query(
    `SELECT id::text, operation_id, payload_sha256
    FROM corestack_erp_fiscal.dispatch WHERE tenant_id=$1 AND issuer_rnc=$2 AND environment=$3
    AND (operation_id=$4 OR invoice_id=$5)`,
    [...params, request.operationId, request.source.documentId],
  );
  if (existing.rows.length) {
    requireFiscal(
      existing.rows.length === 1 &&
        existing.rows[0]!.operation_id === request.operationId &&
        existing.rows[0]!.payload_sha256 === analysis.payloadSha256,
      'ERP_DISPATCH_CONFLICT',
      'operationId',
    );
    return { id: existing.rows[0]!.id as string, reused: true };
  }
  requireFiscal(
    invoice!.revision === request.source.revision &&
      invoice!.status === 'DRAFT' &&
      invoice!.fiscal_status === 'NOT_APPLICABLE' &&
      invoice!.ncf === null &&
      invoice!.encf === null &&
      invoice!.issued_at === null &&
      invoice!.type ===
        (request.type === 31 ? 'FISCAL_CREDIT_ELECTRONIC_31' : 'CONSUMER_ELECTRONIC_32'),
    'ERP_DRAFT_CHANGED_OR_ISSUED',
    'source',
  );
  const result = await tx.query(
    `INSERT INTO corestack_erp_fiscal.dispatch
    (tenant_id,issuer_rnc,environment,invoice_id,operation_id,request_text,payload_sha256)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
    [
      ...params,
      request.source.documentId,
      request.operationId,
      JSON.stringify(request),
      analysis.payloadSha256,
    ],
  );
  requireFiscal(result.rows.length === 1, 'INVALID_DISPATCH_RESULT', 'id');
  return { id: result.rows[0]!.id as string, reused: false };
}

/** Scoped ERP DB adapter. All mutations are single statements; lease tokens
 * fence stale workers. Uses the caller's dedicated ERP connection, not VM4 DB.
 */
export function createFiscalDispatchQueue(
  connection: FiscalRegistrationConnection,
  scope: FiscalScope,
): FiscalDispatchQueue {
  assertScope(scope);
  assertFiscalEnvironmentEnabled(scope);
  const params = [scope.tenantId, scope.issuerRnc, scope.environment];
  return {
    async claim() {
      await connection.query(
        `UPDATE corestack_erp_fiscal.dispatch SET state='REVIEW_REQUIRED',
        lease_token=NULL,lease_until=NULL,last_error='ATTEMPTS_EXHAUSTED',updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND issuer_rnc=$2 AND environment=$3 AND attempts>=10
        AND ((state='RUNNING' AND lease_until<clock_timestamp()) OR state='PENDING')`,
        params,
      );
      const result = await connection.query(
        `WITH candidate AS (
        SELECT id FROM corestack_erp_fiscal.dispatch WHERE tenant_id=$1 AND issuer_rnc=$2 AND environment=$3
        AND attempts<10 AND ((state='PENDING' AND next_attempt_at<=clock_timestamp())
          OR (state='RUNNING' AND lease_until<clock_timestamp()))
        ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE corestack_erp_fiscal.dispatch d SET state='RUNNING',attempts=attempts+1,
        lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp()
        FROM candidate c WHERE d.id=c.id
        RETURNING d.id::text,d.lease_token::text,d.request_text,d.payload_sha256`,
        params,
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id as string,
        leaseToken: row.lease_token as string,
        requestText: row.request_text as string,
        payloadSha256: row.payload_sha256 as string,
      };
    },
    async acknowledge(claim, result) {
      const changed = await connection.query(
        `UPDATE corestack_erp_fiscal.dispatch SET state='REGISTERED',
        document_id=$6,encf=$7,lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND issuer_rnc=$2 AND environment=$3 AND id=$4::bigint AND lease_token=$5::uuid
        AND state='RUNNING' AND lease_until>clock_timestamp() AND payload_sha256=$8 RETURNING id`,
        [
          ...params,
          claim.id,
          claim.leaseToken,
          result.documentId,
          result.encf,
          result.payloadSha256,
        ],
      );
      return changed.rows.length === 1;
    },
    async defer(claim, reason) {
      const changed = await connection.query(
        `UPDATE corestack_erp_fiscal.dispatch SET
        state=CASE WHEN $6='UNCONFIRMED' AND attempts<10 THEN 'PENDING' ELSE 'REVIEW_REQUIRED' END,
        next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(300,30*attempts)),
        lease_token=NULL,lease_until=NULL,last_error=$6,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND issuer_rnc=$2 AND environment=$3 AND id=$4::bigint AND lease_token=$5::uuid
        AND state='RUNNING' AND lease_until>clock_timestamp() RETURNING id`,
        [...params, claim.id, claim.leaseToken, reason],
      );
      return changed.rows.length === 1;
    },
  };
}
