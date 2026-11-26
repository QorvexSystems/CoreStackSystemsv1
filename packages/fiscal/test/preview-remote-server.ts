// Dedicated synthetic ERP preview, not a fiscal production runtime.
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createFiscalRegistrationServer } from '../src/http-service.ts';
import { runPreparationOnce } from '../src/preparation-worker.ts';
import { createPreviewRehearsal } from './preview-rehearsal.ts';

if (process.env.FISCAL_SYNTHETIC_PREVIEW !== 'NO_FISCAL_VALIDITY') throw new Error('PREVIEW_ONLY');
const scope = {
  tenantId: 'cmt397emm0002nm0ogb50l2q6',
  issuerRnc: '40220429126',
  environment: 'precertification' as const,
};
const pool = new Pool({
  host: 'corestack-preview-remote-db',
  port: 5432,
  database: 'corestack_preview_remote',
  user: 'preview_runtime',
  max: 3,
  password: (await readFile('/run/preview/db-password', 'utf8')).trim(),
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
});
pool.on('error', () => {});
const connection = {
  query: async (sql: string, values: readonly unknown[]) => pool.query(sql, [...values]),
};
const identity = await pool
  .query(`SELECT login_role FROM corestack_fiscal.runtime_scope WHERE false`)
  .catch((error: { code?: string }) => {
    if (error.code !== '42501') throw new Error('PREVIEW_DATABASE_NOT_READY');
    return null;
  });
// Runtime deliberately has no direct table access; identity is bound by SQL functions.
if (identity !== null) throw new Error('UNEXPECTED_DIRECT_TABLE_ACCESS');
// One owner of the synthetic identity/journal across process restarts.
const worker = await pool.connect();
const locked = await worker.query('SELECT pg_try_advisory_lock(4092026,1) AS locked');
if (!locked.rows[0]?.locked) throw Error('PREVIEW_WORKER_ALREADY_RUNNING');
const rehearsal = await createPreviewRehearsal(
  { query: (sql, values) => worker.query(sql, [...values]) },
  scope,
);
const server = createFiscalRegistrationServer({
  scope,
  connection,
  syntheticRehearsal: rehearsal.request,
  bearerToken: (await readFile('/run/preview/token', 'utf8')).trim(),
  tls: {
    cert: await readFile('/run/preview/server.crt', 'utf8'),
    key: await readFile('/run/preview/server.key', 'utf8'),
  },
});
await new Promise<void>((resolve) => server.listen(8443, '0.0.0.0', resolve));
console.log('REMOTE_PREVIEW_READY_SYNTHETIC_ONLY_NO_DGII_NETWORK');
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    stopping = true;
  });
while (!stopping) {
  try {
    await runPreparationOnce(connection, scope);
    await rehearsal.cycle();
  } catch {
    console.error('PREVIEW_WORKER_CYCLE_FAILED');
  }
  await delay(500);
}
server.closeAllConnections();
server.close();
worker.release();
await pool.end();
