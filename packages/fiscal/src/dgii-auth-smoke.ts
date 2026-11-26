import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertScope, type FiscalScope } from './catalog.ts';
import { createDgiiClient, createDgiiHttpsTransport } from './dgii-client.ts';
import type { DgiiHttpRequest } from './dgii-client.ts';
import { createPkcs12XmlSigner } from './pkcs12-signer.ts';

type Config = Readonly<{ scope: FiscalScope; expectedCertificateSha256: string }>;
let signer: Awaited<ReturnType<typeof createPkcs12XmlSigner>> | undefined;
let stage = 'CONFIG';
let lastResponse: Readonly<{
  operation: string;
  status: number;
  contentType: string;
  bytes: number;
  classification: string;
  safeReason?: string;
}> | undefined;
const classify = (body: Buffer) => {
  const text = body.toString('utf8').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (text.includes('certificado') && (text.includes('no valid') || text.includes('invalid'))) return 'CERTIFICATE_NOT_ACCEPTED';
  if (text.includes('firma') && (text.includes('no valid') || text.includes('invalid'))) return 'SIGNATURE_NOT_ACCEPTED';
  if (text.includes('no habilitad') || text.includes('no autorizad')) return 'ISSUER_NOT_ENABLED';
  if (text.includes('semilla') && (text.includes('vencid') || text.includes('expir'))) return 'SEED_EXPIRED';
  return 'UNCLASSIFIED_DGII_RESPONSE';
};
const safeReason = (body: Buffer) => {
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    for (const key of ['message', 'mensaje', 'error', 'detail', 'title']) {
      const candidate = record[key];
      if (typeof candidate !== 'string' || candidate.length < 1 || candidate.length > 300) continue;
      const redacted = candidate
        .replace(/\b\d{9,11}\b/g, '[REDACTED_ID]')
        .replace(/[A-Za-z0-9+/=_-]{40,}/g, '[REDACTED_VALUE]')
        .replace(/[\r\n\t]/g, ' ');
      if (/^[\p{L}\p{N} .,:;()_\-/áéíóúÁÉÍÓÚñÑüÜ¿?¡!\[\]]+$/u.test(redacted)) return redacted;
    }
  } catch {}
  return undefined;
};
try {
  const config = JSON.parse(await readFile('/run/config/fiscal-signer.json', 'utf8')) as Config;
  assertScope(config.scope);
  if (config.scope.environment !== 'certification') throw Error('SMOKE_REQUIRES_CERTIFICATION');
  stage = 'SIGNER_INITIALIZATION';
  signer = await createPkcs12XmlSigner({
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
      contentType: response.contentType.split(';')[0].trim().toLowerCase(),
      bytes: response.body.length,
      classification: response.status >= 200 && response.status < 300
        ? 'SUCCESS_RESPONSE'
        : classify(response.body),
      ...(response.status >= 400 ? { safeReason: safeReason(response.body) } : {}),
    };
    return response;
  };
  const client = createDgiiClient(
    config.scope,
    observedTransport,
    async (scope, kind, xml) => {
      if (kind !== 'SEMILLA' || scope.issuerRnc !== config.scope.issuerRnc)
        throw Error('AUTH_SIGNATURE_SCOPE_MISMATCH');
      await signer!.verify(xml);
      return {
        sha256: createHash('sha256').update(xml).digest('hex'),
        actorRnc: config.scope.issuerRnc,
      };
    },
  );
  stage = 'SEED_REQUEST';
  const seed = await client.seed();
  stage = 'SEED_SIGNATURE';
  const signedSeed = await signer.sign(seed);
  stage = 'AUTHENTICATION_REQUEST';
  const authenticated = await client.authenticate(signedSeed);
  console.log('DGII_CERTIFICATION_AUTHENTICATION_SUCCEEDED');
  console.log(`Token expiry: ${new Date(authenticated.expiresAt).toISOString()}`);
  console.log('No token, seed, signature, certificate data or fiscal document was logged or retained.');
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  const code = /^[A-Z][A-Z0-9_]{2,100}$/.test(message) ? message : 'UNCLASSIFIED_FAILURE';
  console.error('DGII_CERTIFICATION_AUTHENTICATION_FAILED');
  console.error(`Safe diagnostic: stage=${stage} code=${code}`);
  if (lastResponse)
    console.error(
      `DGII response metadata: operation=${lastResponse.operation} status=${lastResponse.status} ` +
      `contentType=${lastResponse.contentType || 'none'} bytes=${lastResponse.bytes} ` +
      `classification=${lastResponse.classification}` +
      (lastResponse.safeReason ? ` reason=${JSON.stringify(lastResponse.safeReason)}` : ''),
    );
  process.exitCode = 1;
} finally {
  await signer?.close();
}
