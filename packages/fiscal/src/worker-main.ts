import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { connectFiscalDatabase } from './postgres-connection.ts';
import type { FiscalDatabaseConfig } from './postgres-connection.ts';
import { runPreparationOnce } from './preparation-worker.ts';

// No HTTP listener. Provisioned config + individual read-only secrets only.
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});
try {
  const config = JSON.parse(
    await readFile('/run/config/fiscal-worker.json', 'utf8'),
  ) as FiscalDatabaseConfig;
  const connection = await connectFiscalDatabase(config);
  try {
    while (!stopping) {
      try {
        const result = await runPreparationOnce(connection, config.scope);
        if (result.result !== 'UNCERTAIN')
          await writeFile(
            '/tmp/fiscal-worker-health.json',
            JSON.stringify({ checkedAt: Date.now() }),
            { mode: 0o600 },
          );
        if (result.result !== 'IDLE') console.log(JSON.stringify(result));
        if (result.result === 'IDLE' || result.result === 'UNCERTAIN') await delay(2000);
      } catch {
        console.error('FISCAL_WORKER_CYCLE_FAILED');
        await delay(5000);
      }
    }
  } finally {
    await connection.close();
  }
} catch {
  console.error('FISCAL_WORKER_STARTUP_FAILED');
  process.exitCode = 1;
}
