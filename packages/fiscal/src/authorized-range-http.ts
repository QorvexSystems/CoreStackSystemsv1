import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { assertScope, type FiscalScope } from './catalog.ts';
import { FiscalContractError } from './contract.ts';
import {
  readAuthorizedRanges,
  readAcceptedPrintedRepresentation,
  readProductionDocumentStatus,
  registerAuthorizedRange,
} from './authorized-range-repository.ts';
import { registerFiscalRequest } from './request-repository.ts';
import type { FiscalRegistrationConnection } from './request-repository.ts';

const digest = (value: string) => createHash('sha256').update(value).digest();

export function createAuthorizedRangeServer(config: {
  scope: FiscalScope;
  bearerToken: string;
  connection: FiscalRegistrationConnection;
  tls: { cert: string; key: string };
}) {
  assertScope(config.scope);
  if (config.scope.environment !== 'production') throw new Error('PRODUCTION_SCOPE_REQUIRED');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(config.bearerToken)) throw new Error('INVALID_SERVICE_TOKEN');
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
    res.setHeader('Connection', 'close');
    reply(res, status, { error: code });
    res.once('finish', () => req.destroy());
  };
  const server = createHttpsServer(
    { cert: config.tls.cert, key: config.tls.key, minVersion: 'TLSv1.2', maxHeaderSize: 8192 },
    (req, res) => {
      void (async () => {
        if (req.method === 'GET' && req.url === '/health/live') {
          reply(res, 200, { status: 'ok', mode: 'authorized-range-registration', sendable: false });
          return;
        }
        if (!timingSafeEqual(tokenDigest, digest(req.headers.authorization ?? ''))) {
          reject(req, res, 401, 'UNAUTHORIZED');
          return;
        }
        if (req.method === 'GET' && req.url === '/internal/v1/authorized-ranges') {
          try {
            reply(res, 200, { ranges: await readAuthorizedRanges(config.connection) });
          } catch {
            reply(res, 503, { error: 'RANGE_STATUS_UNAVAILABLE' });
          }
          return;
        }
        const statusRoute =
          req.method === 'GET' &&
          /^\/internal\/v1\/documents\/([1-9][0-9]{0,18})\/status$/.exec(req.url ?? '');
        if (statusRoute) {
          try {
            const status = await readProductionDocumentStatus(config.connection, statusRoute[1]!);
            reply(res, status ? 200 : 404, status ?? { error: 'NOT_FOUND' });
          } catch {
            reply(res, 503, { error: 'DOCUMENT_STATUS_UNAVAILABLE' });
          }
          return;
        }
        const representationRoute =
          req.method === 'GET' &&
          /^\/internal\/v1\/documents\/([1-9][0-9]{0,18})\/printed-representation$/.exec(
            req.url ?? '',
          );
        if (representationRoute) {
          try {
            const representation = await readAcceptedPrintedRepresentation(
              config.connection,
              representationRoute[1]!,
            );
            reply(
              res,
              representation ? 200 : 404,
              representation ? { representation } : { error: 'NOT_READY' },
            );
          } catch {
            reply(res, 503, { error: 'PRINTED_REPRESENTATION_UNAVAILABLE' });
          }
          return;
        }
        const registrationRoute = req.url === '/internal/v1/authorized-ranges';
        const issuanceRoute = req.url === '/internal/v1/requests';
        if (req.method !== 'POST' || (!registrationRoute && !issuanceRoute)) {
          reject(req, res, 404, 'NOT_FOUND');
          return;
        }
        if (
          req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
          req.headers['content-encoding'] ||
          req.headers['transfer-encoding']
        ) {
          reject(req, res, 415, 'JSON_CONTENT_LENGTH_REQUIRED');
          return;
        }
        const maxBody = registrationRoute ? 4096 : 512 * 1024;
        const declared = Number(req.headers['content-length'] ?? -1);
        if (!Number.isInteger(declared) || declared < 2 || declared > maxBody) {
          reject(req, res, 413, 'BODY_SIZE_INVALID');
          return;
        }
        if (inflight >= 2) {
          reject(req, res, 503, 'BUSY');
          return;
        }
        inflight++;
        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > maxBody) {
              reject(req, res, 413, 'BODY_TOO_LARGE');
              return;
            }
            chunks.push(chunk);
          }
          if (size !== declared) {
            reply(res, 400, { error: 'CONTENT_LENGTH_MISMATCH' });
            return;
          }
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            reply(res, 400, { error: 'INVALID_JSON' });
            return;
          }
          try {
            if (registrationRoute) {
              reply(res, 200, await registerAuthorizedRange(config.connection, config.scope, body));
            } else {
              const registered = await registerFiscalRequest(config.connection, config.scope, body);
              reply(res, 200, { ...registered, persisted: true, schemaValidated: false });
            }
          } catch (error) {
            if (error instanceof FiscalContractError) {
              reply(res, 422, { error: error.code, field: error.field });
            } else {
              reply(res, 503, { error: 'REGISTRATION_UNCONFIRMED', retry: 'SAME_REGISTRATION' });
            }
          }
        } finally {
          inflight--;
        }
      })().catch(() => {
        if (!res.headersSent) reply(res, 500, { error: 'INTERNAL_ERROR' });
        else res.destroy();
      });
    },
  );
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 16;
  return server;
}
