import { readFile } from 'node:fs/promises';
import { createFiscalPreflightServer } from './http-service.ts';

// No secret fallback, no .env loading, no DB/signing credentials in this image.
try {
  const config = JSON.parse(await readFile('/run/fiscal/config.json', 'utf8'));
  if (!config || Object.keys(config).sort().join(',') !== 'environment,issuerRnc,tenantId') {
    throw new Error('INVALID_CONFIG');
  }
  const bearerToken = (await readFile('/run/secrets/fiscal_preflight_token', 'utf8')).trim();
  const server = createFiscalPreflightServer({ scope: config, bearerToken });
  server.listen(8080, '0.0.0.0', () => {
    process.stdout.write('Fiscal offline preflight listening; issuance disabled.\n');
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch {
  process.stderr.write(
    'Fiscal preflight startup rejected: verify mounted configuration and secret.\n',
  );
  process.exitCode = 1;
}
