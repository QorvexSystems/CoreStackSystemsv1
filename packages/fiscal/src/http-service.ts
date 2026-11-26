import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { RequestListener } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { assertScope } from './catalog.ts';
import type { FiscalScope } from './catalog.ts';
import { FiscalContractError } from './contract.ts';
import { adaptErpSalesSnapshot } from './erp-sales-adapter.ts';
import type { ErpSalesSnapshot } from './erp-sales-adapter.ts';
import { analyzeFiscalRequest } from './mapper.ts';
import { registerFiscalRequest } from './request-repository.ts';
import type { FiscalRegistrationConnection } from './request-repository.ts';
import { readFiscalPreparation } from './preparation-repository.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

const maxBodyBytes = 512 * 1024;
const digest = (value: string) => createHash('sha256').update(value).digest();

/** Internal, stateless preflight only. One provisioned tenant/RNC/environment per
 * instance and credential. Not a DGII receiver, signing service or issuance API.
 */
export function createFiscalPreflightServer(config: { scope: FiscalScope; bearerToken: string }) {
  return createInternalServer(config);
}

/** Separate opt-in receiver for a future private ERP transport. The connection
 * must be provisioned and scope-verified before listening. Never deploy over
 * plaintext across hosts: a verified TLS transport is required at the boundary.
 * This factory does not enable registration in the existing preflight service.
 */
export function createFiscalRegistrationServer(config: {
  scope: FiscalScope;
  bearerToken: string;
  connection: FiscalRegistrationConnection;
  tls?: { cert: string; key: string };
  syntheticRehearsal?: (documentId: string, start: boolean) => Promise<unknown>;
}) {
  if (!config.connection || typeof config.connection.query !== 'function') {
    throw new Error('MISSING_REGISTRATION_CONNECTION');
  }
  return createInternalServer(config, config.connection, config.tls, config.syntheticRehearsal);
}

function createInternalServer(
  config: { scope: FiscalScope; bearerToken: string },
  connection?: FiscalRegistrationConnection,
  tls?: { cert: string; key: string },
  rehearsal?: (documentId: string, start: boolean) => Promise<unknown>,
) {
  assertScope(config.scope);
  assertFiscalEnvironmentEnabled(config.scope);
  if (
    rehearsal &&
    (process.env.FISCAL_SYNTHETIC_PREVIEW !== 'NO_FISCAL_VALIDITY' ||
      config.scope.tenantId !== 'cmt397emm0002nm0ogb50l2q6' ||
      config.scope.issuerRnc !== '40220429126' ||
      config.scope.environment !== 'precertification')
  )
    throw new Error('PREVIEW_ONLY');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(config.bearerToken)) throw new Error('INVALID_SERVICE_TOKEN');
  const scope = Object.freeze({ ...config.scope });
  const tokenDigest = digest(`Bearer ${config.bearerToken}`);
  let inflight = 0;

  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  };
  const reject = (req: IncomingMessage, res: ServerResponse, status: number, code: string) => {
    // Do not keep draining an untrusted/unbounded upload after rejecting it.
    res.setHeader('Connection', 'close');
    reply(res, status, { error: code });
    res.once('finish', () => req.destroy());
  };
  const handler: RequestListener = (req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/health/live') {
        reply(res, 200, {
          status: 'ok',
          mode: rehearsal
            ? 'synthetic-rehearsal-no-dgii-network'
            : connection
              ? 'unsigned-registration'
              : 'offline-preflight',
          sendable: false,
        });
        return;
      }
      if (!timingSafeEqual(tokenDigest, digest(req.headers.authorization ?? ''))) {
        reject(req, res, 401, 'UNAUTHORIZED');
        return;
      }
      const rehearsalRoute =
        /^\/internal\/v1\/documents\/([1-9][0-9]{0,18})\/synthetic-rehearsal$/.exec(req.url ?? '');
      if (rehearsal && rehearsalRoute && ['GET', 'POST'].includes(req.method ?? '')) {
        if (inflight >= 4) {
          reject(req, res, 503, 'BUSY');
          return;
        }
        if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) {
          reject(req, res, 400, 'EMPTY_BODY_REQUIRED');
          return;
        }
        inflight++;
        try {
          const result = await rehearsal(rehearsalRoute[1]!, req.method === 'POST');
          reply(res, result ? 200 : 404, result ?? { error: 'NOT_FOUND' });
        } catch {
          reply(res, 503, { error: 'SYNTHETIC_REHEARSAL_UNAVAILABLE' });
        } finally {
          inflight--;
        }
        return;
      }
      const preparationRoute =
        req.method === 'GET' &&
        /^\/internal\/v1\/documents\/([1-9][0-9]{0,18})\/preparation$/.exec(req.url ?? '');
      if (connection && preparationRoute) {
        if (inflight >= 4) {
          reject(req, res, 503, 'BUSY');
          return;
        }
        inflight++;
        try {
          const result = await readFiscalPreparation(connection, preparationRoute[1]!);
          reply(res, result ? 200 : 404, result ?? { error: 'NOT_FOUND' });
        } catch (error) {
          reply(
            res,
            error instanceof FiscalContractError && error.code === 'INVALID_DOCUMENT_ID'
              ? 400
              : 503,
            {
              error:
                error instanceof FiscalContractError && error.code === 'INVALID_DOCUMENT_ID'
                  ? 'INVALID_DOCUMENT_ID'
                  : 'PREPARATION_UNAVAILABLE',
            },
          );
        } finally {
          inflight--;
        }
        return;
      }
      if (
        req.method !== 'POST' ||
        !(
          connection
            ? ['/internal/v1/requests']
            : ['/internal/v1/analyze', '/internal/v1/sales-drafts/analyze']
        ).includes(req.url ?? '')
      ) {
        reject(req, res, 404, 'NOT_FOUND');
        return;
      }
      if (
        req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
        req.headers['content-encoding']
      ) {
        reject(req, res, 415, 'JSON_ONLY');
        return;
      }
      if (Number(req.headers['content-length'] ?? 0) > maxBodyBytes) {
        reject(req, res, 413, 'BODY_TOO_LARGE');
        return;
      }
      if (inflight >= 4) {
        reject(req, res, 503, 'BUSY');
        return;
      }
      inflight++;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > maxBodyBytes) {
            reject(req, res, 413, 'BODY_TOO_LARGE');
            return;
          }
          chunks.push(chunk);
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          reply(res, 400, { error: 'INVALID_JSON' });
          return;
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          reply(res, 400, { error: 'INVALID_BODY' });
          return;
        }
        if (connection) {
          try {
            const registered = await registerFiscalRequest(connection, scope, body);
            reply(res, 200, { ...registered, persisted: true, schemaValidated: false });
          } catch (error) {
            if (
              error instanceof FiscalContractError &&
              error.code !== 'INVALID_PERSISTENCE_RESULT'
            ) {
              throw error;
            }
            // A timeout can happen AFTER commit. Never claim rollback or create
            // a new operation. The producer must replay its frozen request.
            reply(res, 503, {
              error: 'REGISTRATION_UNCONFIRMED',
              retry: 'SAME_OPERATION_AND_PAYLOAD',
              sendable: false,
            });
          }
          return;
        }
        const result =
          req.url === '/internal/v1/analyze'
            ? analyzeFiscalRequest(scope, body)
            : adaptErpSalesSnapshot(scope, body as ErpSalesSnapshot);
        reply(res, 200, {
          profile: result.profile,
          type: result.request.type,
          payloadSha256: result.payloadSha256,
          totals: result.amounts.totals,
          sendable: false,
          persisted: false,
          schemaValidated: false,
        });
      } catch (error) {
        if (error instanceof FiscalContractError) {
          reply(res, 422, { error: error.code, field: error.field });
        } else {
          // Never expose request data, internal paths, tokens or stack traces.
          reply(res, 400, { error: 'INVALID_PREFLIGHT_INPUT' });
        }
      } finally {
        inflight--;
      }
    })().catch(() => {
      if (!res.headersSent) reply(res, 500, { error: 'INTERNAL_ERROR' });
      else res.destroy();
    });
  };
  const server = tls
    ? createHttpsServer(
        { cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2', maxHeaderSize: 8192 },
        handler,
      )
    : createServer({ maxHeaderSize: 8192 }, handler);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.timeout = 15_000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 32;
  return server;
}
