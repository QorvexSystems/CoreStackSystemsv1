import { readFile } from 'node:fs/promises';
import { connectAuthorizedRangeDatabase } from './authorized-range-postgres.ts';
import { createAuthorizedRangeServer } from './authorized-range-http.ts';

try {
  const config = JSON.parse(await readFile('/run/config/fiscal-range-registration.json', 'utf8'));
  const [bearerToken, cert, key] = await Promise.all([
    readFile('/run/secrets/fiscal_range_registration_token', 'utf8'),
    readFile('/run/secrets/range-registration-server.crt', 'utf8'),
    readFile('/run/secrets/range-registration-server.key', 'utf8'),
  ]);
  const connection = await connectAuthorizedRangeDatabase(config);
  const server = createAuthorizedRangeServer({
    scope: config.scope,
    bearerToken: bearerToken.trim(),
    connection,
    tls: { cert, key },
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close(
      () =>
        void connection.close().then(
          () => process.exit(0),
          () => process.exit(1),
        ),
    );
    setTimeout(() => process.exit(1), 30_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.listen(8443, '0.0.0.0', () => console.log('FISCAL_RANGE_REGISTRATION_READY'));
} catch {
  console.error('FISCAL_RANGE_REGISTRATION_STARTUP_FAILED');
  process.exitCode = 1;
}
