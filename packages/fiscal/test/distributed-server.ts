// Rehearsal harness, not a production entrypoint. No VM3 config/credentials.
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createFiscalRegistrationServer } from '../src/http-service.ts';
import { runPreparationOnce } from '../src/preparation-worker.ts';

if (process.env.FISCAL_DISPOSABLE_REHEARSAL !== 'YES_NO_REAL_DATA')
  throw new Error('REHEARSAL_ONLY');
const scope = {
  tenantId: 'synthetic-distributed',
  issuerRnc: '101010641',
  environment: 'precertification' as const,
};
// Trust authentication exists ONLY on this disposable, internal Docker network;
// no published PostgreSQL port, no real DB/password. This is not a VM3 TLS test.
const pool = new Pool({
  host: 'corestack-disposable-fiscal-db',
  port: 5432,
  database: 'corestack_disposable_rehearsal',
  user: 'rehearsal_runtime',
  max: 2,
});
pool.on('error', () => {});
const connection = {
  query: async (sql: string, values: readonly unknown[]) => pool.query(sql, [...values]),
};
const server = createFiscalRegistrationServer({
  scope,
  bearerToken: 'synthetic_distributed_rehearsal_token_0123456789',
  connection,
  tls: {
    cert: await readFile('/run/rehearsal.crt', 'utf8'),
    key: await readFile('/run/rehearsal.key', 'utf8'),
  },
});
await new Promise<void>((resolve) => server.listen(8443, '0.0.0.0', resolve));
console.log('SYNTHETIC_DISTRIBUTED_READY');
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    stopping = true;
  });
while (!stopping) {
  try {
    await runPreparationOnce(connection, scope);
  } catch {
    console.error('SYNTHETIC_WORKER_CYCLE_FAILED');
  }
  await delay(250);
}
server.closeAllConnections();
server.close();
await pool.end();
