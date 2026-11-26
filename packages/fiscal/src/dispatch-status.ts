import type { FiscalScope } from './catalog.ts';
import { assertScope } from './catalog.ts';
import { requireFiscal } from './contract.ts';
import type { FiscalRegistrationConnection } from './request-repository.ts';
import type { validateFiscalPreparation } from './preparation-repository.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

/** Called after ERP actor authorization. Resolve the remote ID only from the
 * tenant-scoped durable outbox; never allow the browser to choose a VM4 ID.
 * Read errors propagate without changing dispatch state or allocating numbers.
 */
export async function readDispatchedInvoicePreparation(
  connection: FiscalRegistrationConnection,
  scope: FiscalScope,
  invoiceId: string,
  readRemote: (expected: {
    documentId: string;
    encf: string;
  }) => Promise<ReturnType<typeof validateFiscalPreparation>>,
) {
  assertScope(scope);
  assertFiscalEnvironmentEnabled(scope);
  requireFiscal(
    typeof invoiceId === 'string' && invoiceId.length > 0 && invoiceId.length <= 200,
    'INVALID_INVOICE_ID',
    'invoiceId',
  );
  const result = await connection.query(
    `SELECT d.state,d.document_id,d.encf
    FROM corestack_erp_fiscal.dispatch d
    JOIN public."Invoice" i ON i.id=d.invoice_id AND i."tenantId"=d.tenant_id
    WHERE d.tenant_id=$1 AND d.issuer_rnc=$2 AND d.environment=$3 AND d.invoice_id=$4`,
    [scope.tenantId, scope.issuerRnc, scope.environment, invoiceId],
  );
  requireFiscal(result.rows.length <= 1, 'INVALID_DISPATCH_RESULT', 'rows');
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  requireFiscal(
    ['PENDING', 'RUNNING', 'REGISTERED', 'REVIEW_REQUIRED'].includes(row.state as string),
    'INVALID_DISPATCH_RESULT',
    'state',
  );
  if (row.state !== 'REGISTERED')
    return { dispatchState: row.state, preparation: null, sendable: false };
  requireFiscal(
    typeof row.document_id === 'string' && typeof row.encf === 'string',
    'INVALID_DISPATCH_RESULT',
    'document',
  );
  const preparation = await readRemote({
    documentId: row.document_id as string,
    encf: row.encf as string,
  });
  requireFiscal(
    !!preparation &&
      preparation.documentId === row.document_id &&
      preparation.encf === row.encf &&
      preparation.signed === false &&
      preparation.sendable === false,
    'INVALID_PREPARATION_RESULT',
    'document',
  );
  return { dispatchState: 'REGISTERED', preparation, sendable: false };
}
