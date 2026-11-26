import type { FiscalScope } from './catalog.ts';
import { requireFiscal, serializeFiscalSnapshot } from './contract.ts';
import { parseEncf } from './encf.ts';
import { analyzeFiscalRequest } from './mapper.ts';

/** Driver port; implementation must enforce TLS, dedicated DB login and timeouts. */
export interface FiscalRegistrationConnection {
  query(
    sql: string,
    values: readonly string[],
  ): Promise<{ rows: readonly Record<string, unknown>[] }>;
}

/** Not used by preflight yet. Caller scope must come from authenticated provisioning.
 * A lost database response is retried with the SAME operation and snapshot.
 * Never creates ranges, signs XML, sends to DGII or invents a replacement ID.
 */
export async function registerFiscalRequest(
  connection: FiscalRegistrationConnection,
  trustedScope: FiscalScope,
  input: unknown,
) {
  const analysis = analyzeFiscalRequest(trustedScope, input);
  const snapshotText = serializeFiscalSnapshot(analysis.scope, analysis.request);
  const result = await connection.query(
    'SELECT document_id::text, encf, reused FROM corestack_fiscal.register_request($1::text, $2::text)',
    [snapshotText, analysis.payloadSha256],
  );
  requireFiscal(result.rows.length === 1, 'INVALID_PERSISTENCE_RESULT', 'rows');
  const row = result.rows[0]!;
  requireFiscal(
    typeof row.document_id === 'string' &&
      /^[1-9][0-9]*$/.test(row.document_id) &&
      typeof row.encf === 'string' &&
      typeof row.reused === 'boolean',
    'INVALID_PERSISTENCE_RESULT',
    'document',
  );
  requireFiscal(
    parseEncf(row.encf as string).type === analysis.request.type,
    'INVALID_PERSISTENCE_RESULT',
    'encf',
  );
  return Object.freeze({
    documentId: row.document_id as string,
    encf: row.encf as string,
    reused: row.reused as boolean,
    payloadSha256: analysis.payloadSha256,
    stage: 'RESERVED' as const,
    sendable: false as const,
  });
}
