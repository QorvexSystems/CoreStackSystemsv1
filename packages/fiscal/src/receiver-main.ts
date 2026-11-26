import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { createPkcs12XmlSigner } from './pkcs12-signer.ts';
import { createFiscalReceiverHandler, type FiscalReceiverConfig } from './fiscal-receiver.ts';
import { verifyIncomingSignedXml } from './receiver-xml-verifier.ts';

type Config = FiscalReceiverConfig & Readonly<{
  expectedCertificateSha256: string;
  expectedIncomingCertificateSha256: string;
  listenHost: string;
  listenPort: number;
}>;

let signer: Awaited<ReturnType<typeof createPkcs12XmlSigner>> | undefined;
try {
  const config = JSON.parse(await readFile('/run/config/fiscal-receiver.json', 'utf8')) as Config;
  if (config.listenHost !== '10.0.0.1' || config.listenPort !== 8444)
    throw Error('RECEIVER_LISTEN_SCOPE_INVALID');
  if (config.scope.environment !== 'certification' ||
      !/^[a-f0-9]{64}$/.test(config.expectedIncomingCertificateSha256))
    throw Error('RECEIVER_INCOMING_CERTIFICATE_PIN_INVALID');
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
  const handler = createFiscalReceiverHandler(config, {
    signer,
    verifyIncoming: (xml) => verifyIncomingSignedXml(
      xml,
      '/run/trust/dgii/communication-root.pem',
      config.expectedIncomingCertificateSha256,
    ),
  });
  const server = createServer(
    {
      cert: await readFile('/run/secrets/tls/server.crt'),
      key: await readFile('/run/secrets/tls/server.key'),
      minVersion: 'TLSv1.2',
      requestCert: false,
    },
    (request, response) => {
      const peer = request.socket.remoteAddress?.replace(/^::ffff:/, '');
      const path = new URL(request.url ?? '/', 'https://receiver.invalid').pathname;
      const localHealth = path === '/health/live' && (peer === '127.0.0.1' || peer === '::1' || peer === '10.0.0.1');
      if (peer !== '10.0.0.2' && !localHealth) {
        response.writeHead(403, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
        response.end('{"error":"forbidden"}');
        return;
      }
      void handler(request, response);
    },
  );
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 40;
  server.listen(config.listenPort, config.listenHost, () => console.log('FISCAL_RECEIVER_READY'));
  const stop = () => server.close(async () => { await signer?.close(); process.exit(0); });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch {
  await signer?.close();
  console.error('FISCAL_RECEIVER_STARTUP_FAILED');
  process.exitCode = 1;
}

