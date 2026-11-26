import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { analyzeFiscalRequest } from './mapper.ts';
import { parseEncf } from './encf.ts';
import { assertScope } from './catalog.ts';
import type { FiscalScope } from './catalog.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

export class FiscalTransportError extends Error {
  readonly outcome: 'REJECTED' | 'UNCONFIRMED';
  constructor(outcome: 'REJECTED' | 'UNCONFIRMED') {
    super(`FISCAL_REGISTRATION_${outcome}`);
    this.outcome = outcome;
  }
}

/** Single bounded attempt. The durable producer owns retries and must retain its
 * operation/snapshot even after a timeout or lost acknowledgment. No redirects,
 * ambient proxy, insecure TLS toggle, body-provided destination or automatic retry.
 */
export function createFiscalRegistrationClient(config: {
  origin: string;
  ca: string;
  bearerToken: string;
  scope: FiscalScope;
  timeoutMs?: number;
}) {
  assertScope(config.scope);
  assertFiscalEnvironmentEnabled(config.scope);
  const origin = new URL(config.origin);
  const timeoutMs = config.timeoutMs ?? 25_000;
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !config.ca.includes('-----BEGIN CERTIFICATE-----') ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(config.bearerToken) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30_000 ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  )
    throw new Error('INVALID_FISCAL_TRANSPORT_CONFIG');
  const scope = Object.freeze({ ...config.scope });
  const ca = config.ca;
  const authorization = `Bearer ${config.bearerToken}`;
  const hostname = origin.hostname.replace(/^\[|\]$/g, '');
  const endpoint = new URL('/internal/v1/requests', origin);

  return async (input: unknown) => {
    const analysis = analyzeFiscalRequest(scope, input);
    const body = JSON.stringify(analysis.request);
    if (Buffer.byteLength(body) > 512 * 1024) throw new Error('FISCAL_REQUEST_TOO_LARGE');
    return new Promise<
      Readonly<{
        documentId: string;
        encf: string;
        payloadSha256: string;
        reused: boolean;
        stage: 'RESERVED';
        sendable: false;
      }>
    >((resolve, reject) => {
      const fail = () => reject(new FiscalTransportError('UNCONFIRMED'));
      const req = request(endpoint, {
        method: 'POST',
        agent: false,
        ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        checkServerIdentity: (_name, cert) => checkServerIdentity(hostname, cert),
        headers: {
          authorization,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      });
      const timer = setTimeout(() => req.destroy(new Error('TRANSPORT_DEADLINE')), timeoutMs);
      req.once('error', () => {
        clearTimeout(timer);
        fail();
      });
      req.once('response', (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8192) {
            res.destroy();
            req.destroy();
            clearTimeout(timer);
            fail();
          } else chunks.push(chunk);
        });
        res.once('error', () => {
          clearTimeout(timer);
          fail();
        });
        res.once('end', () => {
          clearTimeout(timer);
          if ([400, 401, 403, 404, 413, 415, 422].includes(res.statusCode ?? 0)) {
            reject(new FiscalTransportError('REJECTED'));
            return;
          }
          try {
            if (
              res.statusCode !== 200 ||
              res.headers['content-type']?.split(';')[0] !== 'application/json'
            )
              throw new Error();
            const ack = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (
              !ack ||
              typeof ack.documentId !== 'string' ||
              !/^[1-9][0-9]*$/.test(ack.documentId) ||
              typeof ack.encf !== 'string' ||
              parseEncf(ack.encf).type !== analysis.request.type ||
              ack.payloadSha256 !== analysis.payloadSha256 ||
              typeof ack.reused !== 'boolean' ||
              ack.stage !== 'RESERVED' ||
              ack.sendable !== false ||
              ack.persisted !== true ||
              ack.schemaValidated !== false
            )
              throw new Error();
            resolve(
              Object.freeze({
                documentId: ack.documentId,
                encf: ack.encf,
                payloadSha256: ack.payloadSha256,
                reused: ack.reused,
                stage: 'RESERVED',
                sendable: false,
              }),
            );
          } catch {
            fail();
          }
        });
      });
      req.end(body);
    });
  };
}
