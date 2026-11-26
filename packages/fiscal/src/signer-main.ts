import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { connectFiscalDatabase, type FiscalDatabaseConfig } from './postgres-connection.ts';
import { createPkcs12FiscalSigning } from './pkcs12-fiscal-signing.ts';
import { runSigningOnce } from './signing-worker.ts';

type Config = FiscalDatabaseConfig & { expectedCertificateSha256: string };
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
try {
  const config = JSON.parse(await readFile('/run/config/fiscal-signer.json', 'utf8')) as Config;
  const [db, fiscal] = await Promise.all([
    connectFiscalDatabase(config),
    createPkcs12FiscalSigning({
      scope: config.scope,
      p12Path: '/run/secrets/signing/certificate.p12',
      passwordPath: '/run/secrets/signing/password',
      rootCertificatePath: '/run/trust/digifirma/root.crt',
      subordinateCertificatePath: '/run/trust/digifirma/subordinate.crt',
      crlPath: '/run/trust/digifirma/subordinate.crl.pem',
      expectedCertificateSha256: config.expectedCertificateSha256,
      workRoot: '/run/signing-work',
    }),
  ]);
  try {
    while (!stopping) {
      const result = await runSigningOnce(db, config.scope, fiscal.signing, fiscal.bundle);
      await writeFile('/tmp/fiscal-signer-health.json', JSON.stringify({ checkedAt: Date.now() }), { mode: 0o600 });
      if (result.result !== 'IDLE') console.log(JSON.stringify(result));
      if (result.result === 'IDLE' || result.result === 'DEFERRED') await delay(2000);
    }
  } finally {
    await fiscal.close();
    await db.close();
  }
} catch {
  console.error('FISCAL_SIGNER_STARTUP_FAILED');
  process.exitCode = 1;
}
