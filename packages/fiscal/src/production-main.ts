import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { connectFiscalDatabase, type FiscalDatabaseConfig } from './postgres-connection.ts';
import { createPkcs12FiscalSigning } from './pkcs12-fiscal-signing.ts';
import { runPreparationOnce } from './preparation-worker.ts';
import { runSigningOnce } from './signing-worker.ts';
import { createDgiiClient, createDgiiHttpsTransport } from './dgii-client.ts';
import { createDeliveryGateway } from './delivery-gateway.ts';
import { runDeliveryOnce, type DeliveryGateway } from './delivery-worker.ts';

type Config = FiscalDatabaseConfig & { expectedCertificateSha256: string };
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });

try {
  const config = JSON.parse(
    await readFile('/run/config/fiscal-production.json', 'utf8'),
  ) as Config;
  const db = await connectFiscalDatabase(config);
  const fiscal = await createPkcs12FiscalSigning({
    scope: config.scope,
    p12Path: '/run/secrets/signing/certificate.p12',
    passwordPath: '/run/secrets/signing/password',
    rootCertificatePath: '/run/trust/digifirma/root.crt',
    subordinateCertificatePath: '/run/trust/digifirma/subordinate.crt',
    crlPath: '/run/trust/digifirma/subordinate.crl.pem',
    expectedCertificateSha256: config.expectedCertificateSha256,
    workRoot: '/run/signing-work',
  });
  const client = createDgiiClient(
    config.scope,
    createDgiiHttpsTransport(config.scope, true),
    fiscal.verify,
  );
  const remoteGateway = createDeliveryGateway(config.scope, client, fiscal.verify);
  let authenticatedUntil = 0;

  const authenticate = async () => {
    if (authenticatedUntil > Date.now() + 60_000) return;
    const seed = await client.seed();
    const session = await client.authenticate(await fiscal.signSeed(seed));
    authenticatedUntil = session.expiresAt;
  };

  const withAuthentication = async <T>(operation: () => Promise<T>) => {
    try {
      await authenticate();
      return await operation();
    } catch (error) {
      authenticatedUntil = 0;
      throw error;
    }
  };
  // runDeliveryOnce claims durable work before invoking this gateway. Therefore
  // an idle service never opens a DGII connection merely to remain healthy.
  const gateway: DeliveryGateway = {
    send: (claim) => withAuthentication(() => remoteGateway.send(claim)),
    reconcile: (claim) => withAuthentication(() => remoteGateway.reconcile(claim)),
  };
  const writeHealth = () =>
    writeFile(
      '/tmp/fiscal-production-health.json',
      JSON.stringify({ checkedAt: Date.now() }),
      { mode: 0o600 },
    );

  await writeHealth();

  try {
    while (!stopping) {
      let worked = false;
      let stage: 'PREPARATION' | 'SIGNING' | 'DELIVERY' = 'PREPARATION';
      try {
        const prepared = await runPreparationOnce(db, config.scope);
        worked ||= prepared.result !== 'IDLE';
        stage = 'SIGNING';
        const signed = await runSigningOnce(
          db,
          config.scope,
          fiscal.signing,
          fiscal.bundle,
          fiscal.printVerify,
        );
        worked ||= signed.result !== 'IDLE';
        stage = 'DELIVERY';
        const delivered = await runDeliveryOnce(db, config.scope, gateway);
        worked ||= delivered.result !== 'IDLE';
        await writeHealth();
        if (worked) {
          console.log('RIVNU_FISCAL_PRODUCTION_CYCLE_RECORDED');
        } else {
          await delay(1500);
        }
      } catch {
        authenticatedUntil = 0;
        console.error(`RIVNU_FISCAL_PRODUCTION_CYCLE_DEFERRED stage=${stage}`);
        await delay(5000);
      }
    }
  } finally {
    await fiscal.close();
    await db.close();
  }
} catch {
  console.error('RIVNU_FISCAL_PRODUCTION_STARTUP_FAILED');
  process.exitCode = 1;
}
