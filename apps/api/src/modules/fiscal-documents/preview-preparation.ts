import { ServiceUnavailableException } from '@nestjs/common';
import { resolve } from 'node:path';
import type { Prisma } from '@qorvex/database';

export function assertSyntheticPreview() {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.RIVNU_PREVIEW_GUARD !== 'RIVNU_DGII_PREVIEW_ONLY'
  ) {
    throw new ServiceUnavailableException(
      'Preparación sintética disponible únicamente en el preview aislado.',
    );
  }
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new ServiceUnavailableException('PREVIEW_DATABASE_REQUIRED');
    }
    if (
      url.protocol !== 'postgresql:' ||
      url.hostname !== 'rivnu-dgii-preview-db' ||
      url.port !== '5432' ||
      url.pathname !== '/rivnu_dgii_preview' ||
      url.username !== 'rivnu_preview'
    )
      throw new ServiceUnavailableException('PREVIEW_DATABASE_REQUIRED');
  }
}

type Row = {
  execution_mode?: 'LOCAL' | 'REMOTE_VM4';
  remote_ack?: unknown;
  id: string;
  snapshot: Record<string, unknown>;
  planned_at: string;
  state: string;
  result: unknown;
  error_code: string | null;
  revision: string;
};

// Node >=22.18 strips TS natively. Fixed packaged paths only; no request-provided module paths.
export function fiscalPreviewCore() {
  assertSyntheticPreview();
  const root = resolve(__dirname, '../../../../../packages/fiscal/src');
  const adapter = require(resolve(root, 'erp-sales-adapter.ts')) as {
    adaptErpSalesSnapshot(
      scope: object,
      input: object,
    ): { request: { type: number; operationId: string; issuedOn: string }; payloadSha256: string };
  };
  const mapper = require(resolve(root, 'mapper.ts')) as {
    prepareMappedEcfDraft(
      scope: object,
      input: object,
      reservation: object,
      timestamp: string,
      validator: object,
    ): Promise<Record<string, unknown>>;
  };
  const validator = require(resolve(root, 'xsd-validator.ts')) as {
    XmllintDraftValidator: new () => object;
  };
  const dispatch = require(resolve(root, 'dispatch-repository.ts')) as {
    enqueueFiscalDispatch(
      db: {
        query(sql: string, values: readonly string[]): Promise<{ rows: Record<string, unknown>[] }>;
      },
      scope: object,
      request: object,
    ): Promise<{ id: string; reused: boolean }>;
  };
  return { ...adapter, ...mapper, ...dispatch, validator: new validator.XmllintDraftValidator() };
}

export async function prepareSyntheticSnapshot(
  db: Prisma.TransactionClient,
  row: Row,
  tenantId: string,
) {
  assertSyntheticPreview();
  if (row.state !== 'PENDING') return view(row);
  try {
    const core = fiscalPreviewCore();
    const issuer = row.snapshot.issuer as { rnc: string };
    const scope = { tenantId, issuerRnc: issuer.rnc, environment: 'precertification' };
    const analyzed = core.adaptErpSalesSnapshot(scope, row.snapshot);
    const encf = `E${analyzed.request.type}${row.id.padStart(10, '0')}`;
    const output = await core.prepareMappedEcfDraft(
      scope,
      analyzed.request,
      {
        scope,
        operationId: analyzed.request.operationId,
        payloadSha256: analyzed.payloadSha256,
        encf,
        businessDate: analyzed.request.issuedOn,
        validUntil: `${analyzed.request.issuedOn.slice(0, 4)}-12-31`,
      },
      row.planned_at,
      core.validator,
    );
    const result = {
      ...output,
      synthetic: true,
      signed: false,
      sendable: false,
      notice: 'PRUEBA SINTÉTICA — SIN VALIDEZ FISCAL — NO ENVIAR A DGII',
    };
    await db.$executeRawUnsafe(
      `UPDATE corestack_preview_ecf.preparation SET state='DONE',result=$1::jsonb WHERE id=$2::bigint AND tenant_id=$3 AND state='PENDING'`,
      JSON.stringify(result),
      row.id,
      tenantId,
    );
    return { ...view(row), state: 'DONE', result };
  } catch (error) {
    const candidate = (error as { code?: unknown }).code;
    const code =
      typeof candidate === 'string' && /^[A-Z_]{1,64}$/.test(candidate)
        ? candidate
        : 'PREPARATION_FAILED';
    await db.$executeRawUnsafe(
      `UPDATE corestack_preview_ecf.preparation SET state='FAILED',error_code=$1 WHERE id=$2::bigint AND tenant_id=$3 AND state='PENDING'`,
      code,
      row.id,
      tenantId,
    );
    return { ...view(row), state: 'FAILED', errorCode: code };
  }
}

export function view(row: Row) {
  return {
    executionMode: row.execution_mode ?? 'LOCAL',
    id: row.id,
    revision: row.revision,
    state: row.state,
    result: row.result,
    errorCode: row.error_code,
    synthetic: true,
    sendable: false,
    signed: false,
  };
}
export type PreviewPreparationRow = Row;
