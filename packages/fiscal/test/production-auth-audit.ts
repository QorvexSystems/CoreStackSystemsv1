import { readFile } from 'node:fs/promises';
import { createDgiiClient, createDgiiHttpsTransport, type DgiiHttpRequest } from '../src/dgii-client.ts';
import { createPkcs12FiscalSigning } from '../src/pkcs12-fiscal-signing.ts';
import type { FiscalDatabaseConfig } from '../src/postgres-connection.ts';

type Config = FiscalDatabaseConfig & { expectedCertificateSha256: string };

let fiscal: Awaited<ReturnType<typeof createPkcs12FiscalSigning>> | undefined;
let stage = 'CONFIG';
let lastResponse: Readonly<{
  operation: string;
  status: number;
  contentType: string;
  bytes: number;
}> | undefined;

try {
  const config = JSON.parse(
    await readFile('/run/config/fiscal-production.json', 'utf8'),
  ) as Config;
  if (config.scope.environment !== 'production') {
    throw new Error('PRODUCTION_SCOPE_REQUIRED');
  }

  stage = 'SIGNER_INITIALIZATION';
  fiscal = await createPkcs12FiscalSigning({
    scope: config.scope,
    p12Path: '/run/secrets/signing/certificate.p12',
    passwordPath: '/run/secrets/signing/password',
    rootCertificatePath: '/run/trust/digifirma/root.crt',
    subordinateCertificatePath: '/run/trust/digifirma/subordinate.crt',
    crlPath: '/run/trust/digifirma/subordinate.crl.pem',
    expectedCertificateSha256: config.expectedCertificateSha256,
    workRoot: '/run/signing-work',
  });

  stage = 'CLIENT_INITIALIZATION';
  const httpsTransport = createDgiiHttpsTransport(config.scope, true);
  const observedTransport = async (input: DgiiHttpRequest) => {
    const response = await httpsTransport(input);
    lastResponse = {
      operation: input.operation,
      status: response.status,
      contentType: response.contentType.split(';')[0]!.trim().toLowerCase(),
      bytes: response.body.length,
    };
    return response;
  };
  const client = createDgiiClient(config.scope, observedTransport, fiscal.verify);

  stage = 'SEED_REQUEST';
  const seed = await client.seed();
  stage = 'SEED_SIGNATURE';
  const signedSeed = await fiscal.signSeed(seed);
  stage = 'AUTHENTICATION_REQUEST';
  const session = await client.authenticate(signedSeed);
  if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() + 30_000) {
    throw new Error('INVALID_AUTHENTICATION_EXPIRY');
  }

  console.log('RIVNU_DGII_PRODUCTION_AUTHENTICATION_AUDIT_PASSED');
  console.log(`SessionExpiry=${new Date(session.expiresAt).toISOString()}`);
  console.log('No token, seed, signature, private key, e-NCF or fiscal document was logged or retained.');
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  const code = /^[A-Z][A-Z0-9_]{2,100}$/.test(message)
    ? message
    : 'UNCLASSIFIED_FAILURE';
  console.error(`RIVNU_DGII_PRODUCTION_AUTHENTICATION_AUDIT_FAILED stage=${stage} code=${code}`);
  if (lastResponse) {
    console.error(
      `DGIIResponse operation=${lastResponse.operation} status=${lastResponse.status} ` +
        `contentType=${lastResponse.contentType || 'none'} bytes=${lastResponse.bytes}`,
    );
  }
  process.exitCode = 1;
} finally {
  await fiscal?.close();
}
