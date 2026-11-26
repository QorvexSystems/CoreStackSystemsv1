import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@qorvex/database';
import {
  assertSyntheticPreview,
  fiscalPreviewCore,
  view,
  type PreviewPreparationRow,
} from './preview-preparation';

type Ack = {
  documentId: string;
  encf: string;
  payloadSha256: string;
  stage: 'RESERVED';
  sendable: false;
};
type Prepared = {
  documentId: string;
  encf: string;
  state: string;
  xml: string | null;
  xmlSha256: string | null;
  signed: false;
  sendable: false;
  lastErrorCode: string | null;
};
type TransportConfig = {
  origin: string;
  ca: string;
  bearerToken: string;
  timeoutMs: number;
  scope: { tenantId: string; issuerRnc: string; environment: string };
};

export async function previewRemoteClients(tenantId: string) {
  assertSyntheticPreview();
  if (tenantId !== 'cmt397emm0002nm0ogb50l2q6')
    throw new ServiceUnavailableException('PREVIEW_REMOTE_SCOPE');
  const root = resolve(__dirname, '../../../../../packages/fiscal/src');
  const [ca, token] = await Promise.all([
    readFile('/run/preview-fiscal/ca.crt', 'utf8'),
    readFile('/run/preview-fiscal/token', 'utf8'),
  ]);
  const config: TransportConfig = {
    origin: 'https://10.0.0.1:4082',
    ca,
    bearerToken: token.trim(),
    timeoutMs: 8000,
    scope: { tenantId, issuerRnc: '40220429126', environment: 'precertification' },
  };
  const registration = require(resolve(root, 'registration-client.ts')) as {
    createFiscalRegistrationClient(config: TransportConfig): (input: unknown) => Promise<Ack>;
  };
  const preparation = require(resolve(root, 'preparation-client.ts')) as {
    createFiscalPreparationClient(config: TransportConfig): (ack: Ack) => Promise<Prepared>;
  };
  return {
    scope: config.scope,
    send: registration.createFiscalRegistrationClient(config),
    read: preparation.createFiscalPreparationClient(config),
  };
}

function remoteView(row: PreviewPreparationRow, prepared: Prepared) {
  return {
    ...view(row),
    state: prepared.state === 'FAILED' ? 'FAILED' : prepared.state === 'DONE' ? 'DONE' : 'PENDING',
    executionMode: 'REMOTE_VM4',
    errorCode: prepared.lastErrorCode,
    result:
      prepared.state === 'DONE'
        ? {
            ...prepared,
            sha256: prepared.xmlSha256,
            synthetic: true,
            notice: 'PRUEBA REMOTA VM4 — SIN FIRMA NI VALIDEZ FISCAL',
          }
        : null,
  };
}

/** Called under the preview row lock. A timeout keeps the same frozen operation
 * pending; no local fallback and no replacement number. Ack and XML are persisted.
 */
export async function prepareRemotePreview(
  db: Prisma.TransactionClient,
  row: PreviewPreparationRow,
  tenantId: string,
  clients = previewRemoteClients,
) {
  assertSyntheticPreview();
  if (row.state !== 'PENDING') return view(row);
  try {
    const remote = await clients(tenantId);
    const analyzed = fiscalPreviewCore().adaptErpSalesSnapshot(remote.scope, row.snapshot);
    let ack = row.remote_ack as Ack | null;
    if (!ack) {
      const linked = await db.$queryRawUnsafe<Array<{ state: string }>>(
        `SELECT state FROM corestack_erp_fiscal.dispatch WHERE tenant_id=$1 AND invoice_id=$2 AND operation_id=$3`,
        tenantId,
        row.snapshot.id,
        row.snapshot.operationId,
      );
      if (linked.length) {
        const root = resolve(__dirname, '../../../../../packages/fiscal/src');
        const repository = require(resolve(root, 'dispatch-repository.ts')) as {
          createFiscalDispatchQueue(connection: object, scope: object): object;
        };
        const worker = require(resolve(root, 'dispatch-worker.ts')) as {
          runDispatchOnce(queue: object, scope: object, send: typeof remote.send): Promise<unknown>;
        };
        const queue = repository.createFiscalDispatchQueue(
          {
            query: async (sql: string, values: readonly string[]) => ({
              rows: await db.$queryRawUnsafe(sql, ...values),
            }),
          },
          remote.scope,
        );
        if (linked[0].state !== 'REGISTERED')
          await worker.runDispatchOnce(queue, remote.scope, remote.send);
        const registered = await db.$queryRawUnsafe<Ack[]>(
          `SELECT document_id AS "documentId",encf,payload_sha256 AS "payloadSha256",
             'RESERVED' AS stage,false AS sendable FROM corestack_erp_fiscal.dispatch
           WHERE tenant_id=$1 AND invoice_id=$2 AND operation_id=$3 AND state='REGISTERED'`,
          tenantId,
          row.snapshot.id,
          row.snapshot.operationId,
        );
        if (!registered[0]) return { ...view(row), executionMode: 'REMOTE_VM4' };
        ack = registered[0];
      } else {
        // Historical preview rows predate persisted invoice drafts/outbox.
        ack = await remote.send(analyzed.request);
      }
      await db.$executeRawUnsafe(
        `UPDATE corestack_preview_ecf.preparation SET remote_ack=$1::jsonb
        WHERE id=$2::bigint AND tenant_id=$3 AND remote_ack IS NULL`,
        JSON.stringify(ack),
        row.id,
        tenantId,
      );
    }
    if (ack.payloadSha256 !== analyzed.payloadSha256) throw new Error('ACK_MISMATCH');
    const result = remoteView(row, await remote.read(ack));
    await db.$executeRawUnsafe(
      `UPDATE corestack_preview_ecf.preparation SET state=$1,result=$2::jsonb,error_code=$3
      WHERE id=$4::bigint AND tenant_id=$5 AND state='PENDING'`,
      result.state,
      JSON.stringify(result.result),
      result.errorCode,
      row.id,
      tenantId,
    );
    return result;
  } catch {
    // Uncertain delivery and local config faults must not discard a persisted operation.
    await db.$executeRawUnsafe(
      `UPDATE corestack_preview_ecf.preparation SET error_code='REMOTE_UNCONFIRMED'
      WHERE id=$1::bigint AND tenant_id=$2 AND state='PENDING'`,
      row.id,
      tenantId,
    );
    return { ...view(row), executionMode: 'REMOTE_VM4', errorCode: 'REMOTE_UNCONFIRMED' };
  }
}

/** GET reads remote immutable evidence only; does not enqueue/reserve or mutate. */
export async function readRemotePreview(row: PreviewPreparationRow, tenantId: string) {
  assertSyntheticPreview();
  if (row.state !== 'PENDING' || !row.remote_ack) return view(row);
  try {
    const remote = await previewRemoteClients(tenantId);
    return remoteView(row, await remote.read(row.remote_ack as Ack));
  } catch {
    throw new ServiceUnavailableException('REMOTE_PREPARATION_UNAVAILABLE');
  }
}
