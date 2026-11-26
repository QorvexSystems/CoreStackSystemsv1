import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';

export type ElectronicRangeRegistration = Readonly<{
  registrationId: string;
  tenantId: string;
  issuerRnc: string;
  ecfType: number;
  startNumber: string;
  endNumber: string;
  nextNumber: string;
  authorizationNumber: string;
  authorizedAt: string | null;
  validUntil: string | null;
}>;

export type AuthoritativeElectronicRange = Readonly<{
  rangeId: string;
  registrationId: string;
  ecfType: number;
  startNumber: string;
  endNumber: string;
  nextNumber: string | null;
  remaining: string;
  used: string;
  authorizationNumber: string;
  authorizedAt: string | null;
  validUntil: string | null;
  exhausted: boolean;
}>;

export type FiscalRequestRegistrationAck = Readonly<{
  documentId: string;
  encf: string;
  payloadSha256: string;
  reused: boolean;
}>;

export type FiscalDocumentCoreStatus = Readonly<{
  documentId: string;
  sourceDocumentId: string;
  encf: string;
  preparation: string;
  signing: string;
  delivery: string;
  trackId: string | null;
  updatedAt: string;
}>;

export type ElectronicPrintedRepresentation = Readonly<{
  scope: Readonly<{ tenantId: string; issuerRnc: string; environment: 'production' }>;
  title: string;
  encf: string;
  issuer: string;
  issuerRnc: string;
  issuedOn: string;
  signedAt: string;
  securityCode: string;
  total: string;
  signedSha256: string;
  sourceSha256: string;
  qrUrl: string;
  qrVersion: 8 | 9;
  sections: ReadonlyArray<Readonly<{ title: string; fields: ReadonlyArray<Readonly<{ label: string; value: string }>> }>>;
  lines: ReadonlyArray<ReadonlyArray<Readonly<{ label: string; value: string }>>>;
  notice: string;
}>;

export class ElectronicRangeTransportError extends Error {
  constructor(
    readonly outcome: 'REJECTED' | 'UNCONFIRMED',
    readonly diagnosticCode: 'TRANSPORT' | 'ACK_PAYLOAD_HASH_MISMATCH' = 'TRANSPORT',
  ) {
    super(`ELECTRONIC_RANGE_${outcome}`);
  }
}

type RegistrationRoute = Readonly<{
  tenantId: string;
  issuerRnc: string;
  endpoint: URL;
  hostname: string;
  bearerToken: string;
  ca: string;
}>;

type ElectronicRangeRegistrationClient = {
  (input: ElectronicRangeRegistration): Promise<{ rangeId: string; reused: boolean }>;
  readRanges(tenantId: string): Promise<AuthoritativeElectronicRange[]>;
  registerFiscalRequest(
    tenantId: string,
    issuerRnc: string,
    requestBody: unknown,
    expectedPayloadSha256: string,
  ): Promise<FiscalRequestRegistrationAck>;
  readDocumentStatus(tenantId: string, documentId: string): Promise<FiscalDocumentCoreStatus>;
  readPrintedRepresentation(
    tenantId: string,
    documentId: string,
  ): Promise<ElectronicPrintedRepresentation>;
};

export function createElectronicRangeRegistrationClientFromEnvironment() {
  const routesFile = process.env.FISCAL_RANGE_REGISTRATION_ROUTES_FILE;
  if (!routesFile) return null;
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('INVALID_RANGE_REGISTRATION_CONFIG');
  }
  const parsed = JSON.parse(readFileSync(routesFile, 'utf8')) as {
    version?: unknown;
    routes?: unknown;
  };
  if (parsed.version !== 1 || !Array.isArray(parsed.routes) || parsed.routes.length > 1000) {
    throw new Error('INVALID_RANGE_REGISTRATION_CONFIG');
  }
  const routes = new Map<string, RegistrationRoute>();
  for (const candidate of parsed.routes) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('INVALID_RANGE_REGISTRATION_CONFIG');
    }
    const value = candidate as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(',') !==
        ['caFile', 'issuerRnc', 'origin', 'tenantId', 'tokenFile'].sort().join(',') ||
      typeof value.tenantId !== 'string' ||
      !/^[a-z0-9]{20,32}$/.test(value.tenantId) ||
      typeof value.issuerRnc !== 'string' ||
      !/^(?:[0-9]{9}|[0-9]{11})$/.test(value.issuerRnc) ||
      typeof value.origin !== 'string' ||
      typeof value.tokenFile !== 'string' ||
      typeof value.caFile !== 'string' ||
      routes.has(value.tenantId)
    ) {
      throw new Error('INVALID_RANGE_REGISTRATION_CONFIG');
    }
    const origin = new URL(value.origin);
    const bearerToken = readFileSync(value.tokenFile, 'utf8').trim();
    const ca = readFileSync(value.caFile, 'utf8');
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(bearerToken) ||
      !ca.includes('-----BEGIN CERTIFICATE-----')
    ) {
      throw new Error('INVALID_RANGE_REGISTRATION_CONFIG');
    }
    routes.set(value.tenantId, {
      tenantId: value.tenantId,
      issuerRnc: value.issuerRnc,
      endpoint: new URL('/internal/v1/authorized-ranges', origin),
      hostname: origin.hostname.replace(/^\[|\]$/g, ''),
      bearerToken,
      ca,
    });
  }

  const register = (async (input: ElectronicRangeRegistration) => {
    const route = routes.get(input.tenantId);
    if (!route || route.issuerRnc !== input.issuerRnc) {
      throw new ElectronicRangeTransportError('REJECTED');
    }
    const body = JSON.stringify({
      registrationId: input.registrationId,
      tenantId: input.tenantId,
      issuerRnc: input.issuerRnc,
      ecfType: input.ecfType,
      startNumber: input.startNumber,
      endNumber: input.endNumber,
      nextNumber: input.nextNumber,
      authorizationNumber: input.authorizationNumber,
      authorizedAt: input.authorizedAt,
      validUntil: input.validUntil,
    });
    if (Buffer.byteLength(body) > 4096) throw new ElectronicRangeTransportError('REJECTED');
    return new Promise<{ rangeId: string; reused: boolean }>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const req = request(route.endpoint, {
        method: 'POST',
        agent: false,
        ca: route.ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        checkServerIdentity: (_name, cert) => checkServerIdentity(route.hostname, cert),
        headers: {
          authorization: `Bearer ${route.bearerToken}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      });
      const timer = setTimeout(() => req.destroy(new Error('TRANSPORT_DEADLINE')), 15_000);
      req.once('error', () =>
        finish(() => reject(new ElectronicRangeTransportError('UNCONFIRMED'))),
      );
      req.once('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8192) res.destroy();
          else chunks.push(chunk);
        });
        res.once('error', () =>
          finish(() => reject(new ElectronicRangeTransportError('UNCONFIRMED'))),
        );
        res.once('end', () =>
          finish(() => {
            if ([400, 401, 403, 404, 409, 413, 415, 422].includes(res.statusCode ?? 0)) {
              reject(new ElectronicRangeTransportError('REJECTED'));
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
                typeof ack.rangeId !== 'string' ||
                !/^[1-9][0-9]{0,18}$/.test(ack.rangeId) ||
                ack.registrationId !== input.registrationId ||
                ack.status !== 'REGISTERED' ||
                ack.environment !== 'production' ||
                typeof ack.reused !== 'boolean'
              )
                throw new Error();
              resolve({ rangeId: ack.rangeId, reused: ack.reused });
            } catch {
              reject(new ElectronicRangeTransportError('UNCONFIRMED'));
            }
          }),
        );
      });
      req.end(body);
    });
  }) as ElectronicRangeRegistrationClient;

  register.readRanges = async (tenantId: string) => {
    const route = routes.get(tenantId);
    if (!route) throw new ElectronicRangeTransportError('REJECTED');
    return new Promise<AuthoritativeElectronicRange[]>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const req = request(route.endpoint, {
        method: 'GET',
        agent: false,
        ca: route.ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        checkServerIdentity: (_name, cert) => checkServerIdentity(route.hostname, cert),
        headers: { authorization: `Bearer ${route.bearerToken}`, accept: 'application/json' },
      });
      const timer = setTimeout(() => req.destroy(new Error('TRANSPORT_DEADLINE')), 10_000);
      req.once('error', () =>
        finish(() => reject(new ElectronicRangeTransportError('UNCONFIRMED'))),
      );
      req.once('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) res.destroy();
          else chunks.push(chunk);
        });
        res.once('error', () =>
          finish(() => reject(new ElectronicRangeTransportError('UNCONFIRMED'))),
        );
        res.once('end', () =>
          finish(() => {
            try {
              if (
                res.statusCode !== 200 ||
                res.headers['content-type']?.split(';')[0] !== 'application/json'
              )
                throw new Error();
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                ranges?: unknown;
              };
              if (!Array.isArray(value.ranges)) throw new Error();
              for (const candidate of value.ranges) {
                const range = candidate as Record<string, unknown>;
                if (
                  !range ||
                  typeof range.rangeId !== 'string' ||
                  typeof range.registrationId !== 'string' ||
                  !Number.isInteger(range.ecfType) ||
                  typeof range.startNumber !== 'string' ||
                  typeof range.endNumber !== 'string' ||
                  (range.nextNumber !== null && typeof range.nextNumber !== 'string') ||
                  typeof range.remaining !== 'string' ||
                  typeof range.used !== 'string' ||
                  typeof range.exhausted !== 'boolean'
                )
                  throw new Error();
              }
              resolve(value.ranges as AuthoritativeElectronicRange[]);
            } catch {
              reject(new ElectronicRangeTransportError('UNCONFIRMED'));
            }
          }),
        );
      });
      req.end();
    });
  };
  register.registerFiscalRequest = async (
    tenantId: string,
    issuerRnc: string,
    requestBody: unknown,
    expectedPayloadSha256: string,
  ) => {
    const route = routes.get(tenantId);
    if (!route || route.issuerRnc !== issuerRnc) {
      throw new ElectronicRangeTransportError('REJECTED');
    }
    const body = JSON.stringify(requestBody);
    const expectedType = requestBody && typeof requestBody === 'object'
      ? (requestBody as { type?: unknown }).type : undefined;
    if (expectedType !== 31 && expectedType !== 32) throw new ElectronicRangeTransportError('REJECTED');
    if (Buffer.byteLength(body) > 512 * 1024) {
      throw new ElectronicRangeTransportError('REJECTED');
    }
    const endpoint = new URL('/internal/v1/requests', route.endpoint);
    return new Promise<FiscalRequestRegistrationAck>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const req = request(endpoint, {
        method: 'POST',
        agent: false,
        ca: route.ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        checkServerIdentity: (_name, cert) => checkServerIdentity(route.hostname, cert),
        headers: {
          authorization: `Bearer ${route.bearerToken}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      });
      const timer = setTimeout(() => req.destroy(new Error('TRANSPORT_DEADLINE')), 25_000);
      req.once('error', () =>
        finish(() => reject(new ElectronicRangeTransportError('UNCONFIRMED'))),
      );
      req.once('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8192) res.destroy();
          else chunks.push(chunk);
        });
        res.once('error', () =>
          finish(() => reject(new ElectronicRangeTransportError('UNCONFIRMED'))),
        );
        res.once('end', () =>
          finish(() => {
            if ([400, 401, 403, 404, 409, 413, 415, 422].includes(res.statusCode ?? 0)) {
              reject(new ElectronicRangeTransportError('REJECTED'));
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
                !new RegExp(`^E${expectedType}[0-9]{10}$`).test(ack.encf) ||
                typeof ack.payloadSha256 !== 'string' ||
                !/^[a-f0-9]{64}$/.test(ack.payloadSha256) ||
                typeof ack.reused !== 'boolean' ||
                ack.stage !== 'RESERVED' ||
                ack.persisted !== true
              )
                throw new Error();
              if (ack.payloadSha256 !== expectedPayloadSha256) {
                throw new ElectronicRangeTransportError('UNCONFIRMED', 'ACK_PAYLOAD_HASH_MISMATCH');
              }
              resolve({
                documentId: ack.documentId,
                encf: ack.encf,
                payloadSha256: ack.payloadSha256,
                reused: ack.reused,
              });
            } catch (error) {
              reject(error instanceof ElectronicRangeTransportError
                ? error : new ElectronicRangeTransportError('UNCONFIRMED'));
            }
          }),
        );
      });
      req.end(body);
    });
  };
  register.readDocumentStatus = async (tenantId: string, documentId: string) => {
    const route = routes.get(tenantId);
    if (!route || !/^[1-9][0-9]{0,18}$/.test(documentId)) {
      throw new ElectronicRangeTransportError('REJECTED');
    }
    const endpoint = new URL(`/internal/v1/documents/${documentId}/status`, route.endpoint);
    return new Promise<FiscalDocumentCoreStatus>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const req = request(endpoint, {
        method: 'GET',
        agent: false,
        ca: route.ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        checkServerIdentity: (_name, cert) => checkServerIdentity(route.hostname, cert),
        headers: { authorization: `Bearer ${route.bearerToken}`, accept: 'application/json' },
      });
      const timer = setTimeout(() => req.destroy(new Error('TRANSPORT_DEADLINE')), 10_000);
      req.once('error', () =>
        finish(() => reject(new ElectronicRangeTransportError('UNCONFIRMED'))),
      );
      req.once('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16 * 1024) res.destroy();
          else chunks.push(chunk);
        });
        res.once('error', () =>
          finish(() => reject(new ElectronicRangeTransportError('UNCONFIRMED'))),
        );
        res.once('end', () =>
          finish(() => {
            try {
              if (
                res.statusCode !== 200 ||
                res.headers['content-type']?.split(';')[0] !== 'application/json'
              )
                throw new Error();
              const status = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (
                !status ||
                status.documentId !== documentId ||
                typeof status.sourceDocumentId !== 'string' ||
                typeof status.encf !== 'string' || !/^E(?:31|32)[0-9]{10}$/.test(status.encf) ||
                !['PENDING','RUNNING','DONE','FAILED'].includes(status.preparation) ||
                !['WAITING','REQUESTED','SIGNING','ENQUEUED','FAILED'].includes(status.signing) ||
                !['WAITING','READY','SENDING','RECONCILE','POLLING','ACCEPTED','ACCEPTED_CONDITIONALLY','REJECTED','REVIEW_REQUIRED'].includes(status.delivery) ||
                (status.trackId !== null && (typeof status.trackId !== 'string' || status.trackId.length < 1 || status.trackId.length > 200))
              )
                throw new Error();
              resolve(status as FiscalDocumentCoreStatus);
            } catch {
              reject(new ElectronicRangeTransportError('UNCONFIRMED'));
            }
          }),
        );
      });
      req.end();
    });
  };
  register.readPrintedRepresentation = async (tenantId: string, documentId: string) => {
    const route = routes.get(tenantId);
    if (!route || !/^[1-9][0-9]{0,18}$/.test(documentId)) {
      throw new ElectronicRangeTransportError('REJECTED');
    }
    const endpoint = new URL(
      `/internal/v1/documents/${documentId}/printed-representation`,
      route.endpoint,
    );
    return new Promise<ElectronicPrintedRepresentation>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const req = request(endpoint, {
        method: 'GET', agent: false, ca: route.ca, rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        checkServerIdentity: (_name, cert) => checkServerIdentity(route.hostname, cert),
        headers: { authorization: `Bearer ${route.bearerToken}`, accept: 'application/json' },
      });
      const timer = setTimeout(() => req.destroy(new Error('TRANSPORT_DEADLINE')), 10_000);
      req.once('error', () => finish(() => reject(new ElectronicRangeTransportError('UNCONFIRMED'))));
      req.once('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) res.destroy(); else chunks.push(chunk);
        });
        res.once('error', () => finish(() => reject(new ElectronicRangeTransportError('UNCONFIRMED'))));
        res.once('end', () => finish(() => {
          try {
            if (res.statusCode === 404) throw new ElectronicRangeTransportError('REJECTED');
            if (res.statusCode !== 200 || res.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error();
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { representation?: unknown };
            const model = body.representation as Record<string, unknown>;
            if (!model || model.scope === null || typeof model.scope !== 'object' ||
              typeof model.encf !== 'string' || !/^E(?:31|32)[0-9]{10}$/.test(model.encf) ||
              typeof model.issuerRnc !== 'string' || typeof model.qrUrl !== 'string' ||
              !model.qrUrl.startsWith('https://') || !Array.isArray(model.sections) ||
              !Array.isArray(model.lines) || ![8, 9].includes(model.qrVersion as number) ||
              typeof model.signedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(model.signedSha256)) throw new Error();
            resolve(model as unknown as ElectronicPrintedRepresentation);
          } catch (error) {
            reject(error instanceof ElectronicRangeTransportError ? error : new ElectronicRangeTransportError('UNCONFIRMED'));
          }
        }));
      });
      req.end();
    });
  };
  return register;
}
