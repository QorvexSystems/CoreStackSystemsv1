import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { prepareAreCf, prepareSeed } from './auxiliary.ts';
import type { FiscalScope } from './catalog.ts';
import { parseEncf } from './encf.ts';
import type { Pkcs12Signer } from './pkcs12-signer.ts';
import type { VerifiedIncomingXml } from './receiver-xml-verifier.ts';
import { XmllintDraftValidator } from './xsd-validator.ts';

const MAX_BODY = 2 * 1024 * 1024;
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const one = (xml: string, name: string) => {
  const values = [...xml.matchAll(new RegExp(`<(?:[A-Za-z][A-Za-z0-9]*:)?${name}>([^<]+)</(?:[A-Za-z][A-Za-z0-9]*:)?${name}>`, 'g'))];
  if (values.length !== 1) throw Error('FISCAL_FIELD_INVALID');
  return values[0]![1]!.trim();
};

export type FiscalReceiverConfig = Readonly<{
  scope: FiscalScope;
  evidenceRoot: string;
  seedTtlMs?: number;
  tokenTtlMs?: number;
}>;

type Dependencies = Readonly<{
  signer: Pick<Pkcs12Signer, 'sign'>;
  verifyIncoming(xml: string): Promise<VerifiedIncomingXml>;
  now?: () => Date;
}>;

function dominicanTimestamp(date: Date) {
  const local = new Date(date.getTime() - 4 * 60 * 60 * 1000).toISOString().slice(0, 19);
  return `${local}-04:00`;
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_BODY) throw Error('BODY_TOO_LARGE');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function multipartXml(request: IncomingMessage) {
  const contentType = request.headers['content-type'] ?? '';
  const boundary = /multipart\/form-data\s*;\s*boundary=(?:"([A-Za-z0-9'()+_,\-./:=?]{1,70})"|([A-Za-z0-9'()+_,\-./:=?]{1,70}))/i.exec(contentType)?.slice(1).find(Boolean);
  if (!boundary) throw Error('MULTIPART_REQUIRED');
  const raw = await body(request);
  const marker = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let offset = 0;
  while ((offset = raw.indexOf(marker, offset)) >= 0) {
    offset += marker.length;
    if (raw.subarray(offset, offset + 2).equals(Buffer.from('--'))) break;
    if (!raw.subarray(offset, offset + 2).equals(Buffer.from('\r\n'))) throw Error('MULTIPART_INVALID');
    const next = raw.indexOf(marker, offset + 2);
    if (next < 0) throw Error('MULTIPART_INVALID');
    parts.push(raw.subarray(offset + 2, next - 2));
    offset = next;
  }
  if (parts.length !== 1) throw Error('MULTIPART_INVALID');
  const separator = parts[0]!.indexOf(Buffer.from('\r\n\r\n'));
  if (separator < 0) throw Error('MULTIPART_INVALID');
  const headers = parts[0]!.subarray(0, separator).toString('ascii');
  if (!/content-disposition:\s*form-data\s*;[^\r\n]*name="xml"/i.test(headers))
    throw Error('MULTIPART_INVALID');
  if (!/content-type:\s*(?:text|application)\/xml/i.test(headers)) throw Error('MULTIPART_INVALID');
  const xml = parts[0]!.subarray(separator + 4).toString('utf8');
  if (!xml || Buffer.from(xml).length !== parts[0]!.length - separator - 4) throw Error('XML_ENCODING_INVALID');
  return xml;
}

class EvidenceStore {
  private readonly root: string;
  constructor(root: string) { this.root = root; }
  async existing(kind: 'ecf' | 'approval', key: string, signedXml: string) {
    const statePath = join(this.root, kind, `${key}.json`);
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      if (state.signedSha256 !== hash(signedXml)) throw Error('FISCAL_REPLAY_CONFLICT');
      return typeof state.response === 'string' ? state.response : '';
    } catch (error: any) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async record(kind: 'ecf' | 'approval', key: string, signedXml: string, response?: string) {
    if (!/^[0-9A-Z-]{1,40}$/.test(key)) throw Error('EVIDENCE_KEY_INVALID');
    const directory = join(this.root, kind);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const digest = hash(signedXml);
    const statePath = join(directory, `${key}.json`);
    const existing = await this.existing(kind, key, signedXml);
    if (existing !== undefined) return existing || undefined;
    const suffix = randomBytes(8).toString('hex');
    const inputFinal = join(directory, `${key}-${digest}.xml`);
    const inputTemp = `${inputFinal}.${suffix}.tmp`;
    await writeFile(inputTemp, signedXml, { mode: 0o600, flag: 'wx' });
    await rename(inputTemp, inputFinal);
    let responsePath: string | undefined;
    if (response) {
      responsePath = join(directory, `${key}-${digest}-response.xml`);
      const responseTemp = `${responsePath}.${suffix}.tmp`;
      await writeFile(responseTemp, response, { mode: 0o600, flag: 'wx' });
      await rename(responseTemp, responsePath);
    }
    const state = JSON.stringify({ signedSha256: digest, inputPath: inputFinal, responsePath, response });
    const handle = await open(statePath, 'wx', 0o600);
    try { await handle.writeFile(state); } finally { await handle.close(); }
    return response;
  }
}

export function createFiscalReceiverHandler(config: FiscalReceiverConfig, dependencies: Dependencies) {
  if (config.scope.environment === 'production') throw Error('PRODUCTION_DISABLED');
  const now = dependencies.now ?? (() => new Date());
  const seeds = new Map<string, number>();
  const tokens = new Map<string, { actorRnc: string; expires: number }>();
  const validator = new XmllintDraftValidator();
  const store = new EvidenceStore(config.evidenceRoot);
  const seedTtl = config.seedTtlMs ?? 5 * 60_000;
  const tokenTtl = config.tokenTtlMs ?? 60 * 60_000;
  const requestWindows = new Map<string, { started: number; count: number }>();
  let activeRequests = 0;
  const clean = () => {
    const time = now().getTime();
    for (const [key, expiry] of seeds) if (expiry <= time) seeds.delete(key);
    for (const [key, value] of tokens) if (value.expires <= time) tokens.delete(key);
    for (const [key, value] of requestWindows) if (time - value.started >= 120_000) requestWindows.delete(key);
  };
  const authenticate = (request: IncomingMessage) => {
    clean();
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
    if (!match) throw Error('AUTHENTICATION_REQUIRED');
    const digest = hash(match[1]!);
    const session = tokens.get(digest);
    if (!session) throw Error('AUTHENTICATION_INVALID');
    return session;
  };
  const send = (response: ServerResponse, status: number, contentType: string, value: string) => {
    response.writeHead(status, { ...NO_STORE, 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(value) });
    response.end(value);
  };
  return async (request: IncomingMessage, response: ServerResponse) => {
    const requestPath = new URL(request.url ?? '/', 'https://receiver.invalid').pathname.toLowerCase();
    if (activeRequests >= 16) {
      send(response, 503, 'application/json', '{"error":"busy"}');
      return;
    }
    const source = typeof request.headers['x-real-ip'] === 'string' && /^[0-9a-f:.]{3,45}$/i.test(request.headers['x-real-ip'])
      ? request.headers['x-real-ip'] : request.socket.remoteAddress ?? 'unknown';
    const current = now().getTime();
    const window = requestWindows.get(source);
    if (!window || current - window.started >= 60_000) requestWindows.set(source, { started: current, count: 1 });
    else if (++window.count > 120) {
      send(response, 429, 'application/json', '{"error":"rate_limited"}');
      return;
    }
    activeRequests++;
    try {
      const path = requestPath;
      if (request.method === 'GET' && path === '/health/live') {
        send(response, 200, 'application/json', '{"status":"ok"}');
        return;
      }
      if (request.method === 'GET' && path === '/fe/autenticacion/api/semilla') {
        clean();
        if (seeds.size >= 1000) {
          send(response, 503, 'application/json', '{"error":"busy"}');
          return;
        }
        const value = randomBytes(48).toString('base64');
        seeds.set(hash(value), now().getTime() + seedTtl);
        const seed = await prepareSeed(config.scope, value, dominicanTimestamp(now()));
        send(response, 200, 'application/xml; charset=utf-8', seed.xml);
        return;
      }
      if (request.method === 'POST' && path === '/fe/autenticacion/api/validacioncertificado') {
        clean();
        const verified = await dependencies.verifyIncoming(await multipartXml(request));
        await validator.validateUnsignedAuxiliary('SEMILLA', verified.unsignedXml);
        const value = one(verified.unsignedXml, 'valor');
        const digest = hash(value);
        const expiry = seeds.get(digest);
        if (!expiry || expiry <= now().getTime()) throw Error('SEED_INVALID');
        seeds.delete(digest);
        const token = randomBytes(32).toString('base64url');
        const issued = now();
        const expires = new Date(issued.getTime() + tokenTtl);
        tokens.set(hash(token), { actorRnc: verified.actorRnc, expires: expires.getTime() });
        send(response, 200, 'application/json', JSON.stringify({ token, expira: expires.toISOString(), expedido: issued.toISOString() }));
        return;
      }
      if (request.method === 'POST' && path === '/fe/recepcion/api/ecf') {
        const session = authenticate(request);
        const signedXml = await multipartXml(request);
        const verified = await dependencies.verifyIncoming(signedXml);
        if (verified.actorRnc !== session.actorRnc) throw Error('TOKEN_CERTIFICATE_MISMATCH');
        const encf = one(verified.unsignedXml, 'eNCF');
        const type = parseEncf(encf).type;
        await validator.validateUnsignedEcf(type, verified.unsignedXml);
        const issuerRnc = one(verified.unsignedXml, 'RNCEmisor');
        const buyerRnc = one(verified.unsignedXml, 'RNCComprador');
        // A qualified natural-person certificate can represent a different
        // taxpayer. Authentication remains bound to that certificate; the
        // receiving scope is determined by the e-CF buyer identity.
        if (buyerRnc !== config.scope.issuerRnc) throw Error('ECF_SCOPE_MISMATCH');
        const key = `${issuerRnc}-${encf}`;
        const duplicate = await store.existing('ecf', key, signedXml);
        if (duplicate !== undefined) {
          send(response, 200, 'application/xml; charset=utf-8', duplicate);
          return;
        }
        const receipt = await prepareAreCf(config.scope, {
          issuerRnc, buyerRnc, encf, state: 0, at: dominicanTimestamp(now()),
        });
        const signedReceipt = await dependencies.signer.sign(receipt.xml);
        await store.record('ecf', key, signedXml, signedReceipt);
        send(response, 200, 'application/xml; charset=utf-8', signedReceipt);
        return;
      }
      if (request.method === 'POST' && path === '/fe/aprobacioncomercial/api/ecf') {
        const session = authenticate(request);
        const signedXml = await multipartXml(request);
        const verified = await dependencies.verifyIncoming(signedXml);
        if (verified.actorRnc !== session.actorRnc) throw Error('TOKEN_CERTIFICATE_MISMATCH');
        await validator.validateUnsignedAuxiliary('ACECF', verified.unsignedXml);
        const issuerRnc = one(verified.unsignedXml, 'RNCEmisor');
        const buyerRnc = one(verified.unsignedXml, 'RNCComprador');
        const encf = one(verified.unsignedXml, 'eNCF');
        // The qualified natural-person certificate can act for the buyer
        // taxpayer. Keep the approval scoped to an e-CF issued by RIVNU;
        // authentication and signature verification bind the representative.
        if (issuerRnc !== config.scope.issuerRnc) throw Error('APPROVAL_SCOPE_MISMATCH');
        await store.record('approval', `${buyerRnc}-${encf}`, signedXml);
        send(response, 200, 'text/plain; charset=utf-8', 'OK');
        return;
      }
      send(response, 404, 'application/json', '{"error":"not_found"}');
    } catch (error: any) {
      console.warn(JSON.stringify({
        event: 'FISCAL_RECEIVER_REQUEST_REJECTED',
        method: request.method ?? 'UNKNOWN',
        path: requestPath.slice(0, 256),
        code: typeof error?.message === 'string' ? error.message.slice(0, 128) : 'UNKNOWN',
      }));
      const code = error?.message === 'AUTHENTICATION_REQUIRED' || error?.message === 'AUTHENTICATION_INVALID' ? 401
        : error?.message === 'FISCAL_REPLAY_CONFLICT' ? 409
        : error?.message === 'BODY_TOO_LARGE' ? 413 : 400;
      send(response, code, 'application/json', JSON.stringify({ error: code === 401 ? 'unauthorized' : 'invalid_request' }));
    } finally {
      activeRequests--;
    }
  };
}

