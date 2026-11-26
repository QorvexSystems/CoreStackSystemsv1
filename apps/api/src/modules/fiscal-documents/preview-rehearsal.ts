import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import type { Prisma } from '@qorvex/database';
import { assertSyntheticPreview } from './preview-preparation';

const tenant = 'cmt397emm0002nm0ogb50l2q6';
type Expected = { documentId: string; encf: string; xmlSha256: string };
export async function callPreviewRehearsal(expected: Expected, start: boolean) {
  assertSyntheticPreview();
  if (!/^[1-9][0-9]{0,18}$/.test(expected.documentId)) throw Error('PREVIEW_DOCUMENT_ID');
  const [ca, token] = await Promise.all([
    readFile('/run/preview-fiscal/ca.crt', 'utf8'),
    readFile('/run/preview-fiscal/token', 'utf8'),
  ]);
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const fail = () => reject(Error('SYNTHETIC_REHEARSAL_UNCONFIRMED'));
    const req = request(
      `https://10.0.0.1:4082/internal/v1/documents/${expected.documentId}/synthetic-rehearsal`,
      {
        method: start ? 'POST' : 'GET',
        ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        agent: false,
        headers: {
          authorization: `Bearer ${token.trim()}`,
          accept: 'application/json',
          'content-length': '0',
        },
      },
    );
    const timer = setTimeout(() => req.destroy(), 8000);
    req.once('error', () => {
      clearTimeout(timer);
      fail();
    });
    req.once('response', (res) => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4194304) {
          res.destroy();
          req.destroy();
        } else chunks.push(chunk);
      });
      res.once('error', () => {
        clearTimeout(timer);
        fail();
      });
      res.once('end', () => {
        clearTimeout(timer);
        try {
          if (
            res.statusCode !== 200 ||
            res.headers['content-type']?.split(';')[0] !== 'application/json'
          )
            throw Error();
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (
            data.documentId !== expected.documentId ||
            data.encf !== expected.encf ||
            data.synthetic !== true ||
            data.sendable !== false ||
            ![
              'SIGNING_PENDING',
              'READY',
              'SENDING',
              'RECONCILE',
              'POLLING',
              'ACCEPTED',
              'ACCEPTED_CONDITIONALLY',
              'REJECTED',
              'REVIEW_REQUIRED',
            ].includes(data.state)
          )
            throw Error();
          if (
            data.model &&
            (data.state !== 'ACCEPTED' ||
              data.model.encf !== expected.encf ||
              data.model.sourceSha256 !== expected.xmlSha256 ||
              data.model.scope?.tenantId !== tenant ||
              data.model.scope?.issuerRnc !== '40220429126' ||
              data.model.scope?.environment !== 'precertification' ||
              !/^[a-f0-9]{64}$/.test(data.model.signedSha256))
          )
            throw Error();
          resolve(data);
        } catch {
          fail();
        }
      });
    });
    req.end();
  });
}

/** Durable preview outbox: resumes without an open browser; never changes real invoice/payment state. */
export async function recoverPreviewRehearsalOnce(
  tx: Prisma.TransactionClient,
  transport = callPreviewRehearsal,
) {
  assertSyntheticPreview();
  const rows = await tx.$queryRawUnsafe<
    Array<{
      id: string;
      remote_ack: { documentId: string; encf: string };
      result: { sha256: string };
      attempts: number;
    }>
  >(
    `SELECT p.id::text,p.remote_ack,p.result,r.attempts FROM corestack_preview_ecf.rehearsal r
     JOIN corestack_preview_ecf.preparation p ON p.id=r.preparation_id
     WHERE p.tenant_id=$1 AND NOT r.terminal AND r.attempts<60 AND r.available_at<=clock_timestamp()
     ORDER BY r.available_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
    tenant,
  );
  const row = rows[0];
  if (!row) return 'IDLE';
  await tx.$executeRawUnsafe(
    `UPDATE corestack_preview_ecf.rehearsal SET attempts=attempts+1,
    available_at=clock_timestamp()+interval '10 seconds' WHERE preparation_id=$1::bigint`,
    row.id,
  );
  try {
    // POST is idempotent and authorizes only the already persisted document, never a new e-NCF.
    const result = await transport(
      { ...row.remote_ack, xmlSha256: row.result.sha256 },
      true,
    );
    const completed =
      !!result.model ||
      !!result.errorCode ||
      ['REJECTED', 'REVIEW_REQUIRED', 'ACCEPTED_CONDITIONALLY'].includes(String(result.state));
    const exhausted = !completed && row.attempts >= 59;
    const terminal = completed || exhausted;
    await tx.$executeRawUnsafe(
      `UPDATE corestack_preview_ecf.rehearsal SET result=$1::jsonb,terminal=$2,error_code=$4
      WHERE preparation_id=$3::bigint AND NOT terminal`,
      JSON.stringify(result),
      terminal,
      row.id,
      exhausted ? 'SYNTHETIC_REVIEW_REQUIRED' : null,
    );
    return result.state;
  } catch {
    await tx.$executeRawUnsafe(
      `UPDATE corestack_preview_ecf.rehearsal SET error_code=$1,terminal=$2
      WHERE preparation_id=$3::bigint`,
      row.attempts >= 59 ? 'SYNTHETIC_REVIEW_REQUIRED' : 'REMOTE_UNCONFIRMED',
      row.attempts >= 59,
      row.id,
    );
    return 'UNCONFIRMED';
  }
}
