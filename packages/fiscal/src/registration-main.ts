import { readFile } from 'node:fs/promises';
import { connectFiscalDatabase } from './postgres-connection.ts';
import type { FiscalDatabaseConfig } from './postgres-connection.ts';
import { createFiscalRegistrationServer } from './http-service.ts';

// Separate entrypoint. Fixed private mount paths, TLS mandatory, no fiscal keys.
try {
  const config = JSON.parse(
    await readFile('/run/config/fiscal-registration.json', 'utf8'),
  ) as FiscalDatabaseConfig;
  const [bearerToken, cert, key] = await Promise.all([
    readFile('/run/secrets/fiscal_registration_token', 'utf8'),
    readFile('/run/secrets/registration-server.crt', 'utf8'),
    readFile('/run/secrets/registration-server.key', 'utf8'),
  ]);
  const connection = await connectFiscalDatabase(config);
  try {
    const server = createFiscalRegistrationServer({
      scope: config.scope,
      bearerToken: bearerToken.trim(),
      connection,
      tls: { cert, key },
    });
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      server.close(() => {
        void connection.close().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
      setTimeout(() => process.exit(1), 30_000).unref();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    server.once('error', () => {
      console.error('FISCAL_REGISTRATION_LISTENER_FAILED');
      shutdown();
    });
    server.listen(8443, '0.0.0.0', () =>
      console.log('FISCAL_REGISTRATION_TLS_LISTENING_UNSIGNED_ONLY'),
    );
  } catch {
    await connection.close();
    throw new Error('REGISTRATION_START_FAILED');
  }
} catch {
  console.error('FISCAL_REGISTRATION_STARTUP_FAILED');
  process.exitCode = 1;
}
