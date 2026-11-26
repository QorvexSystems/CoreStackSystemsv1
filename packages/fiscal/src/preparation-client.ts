import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { createFiscalRegistrationClient } from './registration-client.ts';
import {
  assertPreparationDocumentId,
  validateFiscalPreparation,
} from './preparation-repository.ts';

export class FiscalPreparationTransportError extends Error {
  readonly outcome: 'REJECTED' | 'UNCONFIRMED';
  constructor(outcome: 'REJECTED' | 'UNCONFIRMED') {
    super(`FISCAL_PREPARATION_${outcome}`);
    this.outcome = outcome;
  }
}

/** Private read channel only. Callers obtain documentId/eNCF from their own
 * authorized persisted registration, never from an unscoped browser parameter.
 * No redirects, retry loops, ambient proxy or insecure TLS mode.
 */
export function createFiscalPreparationClient(
  config: Parameters<typeof createFiscalRegistrationClient>[0],
) {
  createFiscalRegistrationClient(config); // identical fail-closed transport configuration
  const origin = new URL(config.origin);
  const hostname = origin.hostname.replace(/^\[|\]$/g, '');
  const ca = config.ca;
  const authorization = `Bearer ${config.bearerToken}`;
  const timeoutMs = config.timeoutMs ?? 25_000;
  return async (expected: { documentId: string; encf: string }) => {
    assertPreparationDocumentId(expected.documentId);
    if (!/^E(?:31|32|33|34|41|43|44|45|46|47)[0-9]{10}$/.test(expected.encf))
      throw new Error('INVALID_EXPECTED_ENCF');
    const endpoint = new URL(`/internal/v1/documents/${expected.documentId}/preparation`, origin);
    return new Promise<ReturnType<typeof validateFiscalPreparation>>((resolve, reject) => {
      const fail = () => reject(new FiscalPreparationTransportError('UNCONFIRMED'));
      const req = request(endpoint, {
        method: 'GET',
        agent: false,
        ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        checkServerIdentity: (_name, cert) => checkServerIdentity(hostname, cert),
        headers: { authorization, accept: 'application/json' },
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
          // JSON escaping can expand XML; both envelope and decoded XML are bounded.
          if (size > 16 * 1024 * 1024) {
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
          if ([401, 403].includes(res.statusCode ?? 0)) {
            reject(new FiscalPreparationTransportError('REJECTED'));
            return;
          }
          // An absent registered document is not permission to reserve a new e-NCF.
          if (res.statusCode === 404) {
            fail();
            return;
          }
          try {
            if (
              res.statusCode !== 200 ||
              res.headers['content-type']?.split(';')[0] !== 'application/json'
            )
              throw new Error();
            const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (
              raw.signed !== false ||
              raw.sendable !== false ||
              raw.schemaValidated !== (raw.state === 'DONE')
            )
              throw new Error();
            const result = validateFiscalPreparation(raw, expected.documentId);
            if (!result || result.encf !== expected.encf) throw new Error();
            resolve(result);
          } catch {
            fail();
          }
        });
      });
      req.end();
    });
  };
}
