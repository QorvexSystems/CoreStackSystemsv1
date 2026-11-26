import { request } from 'node:https';
import { randomBytes, createHash } from 'node:crypto';
import { assertScope, type FiscalScope } from './catalog.ts';
import { parseEncf } from './encf.ts';
import { scaledDecimal } from './decimal.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

export type DgiiOperation =
  | 'seed'
  | 'authenticate'
  | 'ecf'
  | 'rfce'
  | 'approval'
  | 'annul'
  | 'result'
  | 'trackIds'
  | 'rfceResult';
const paths: Record<DgiiOperation, string> = {
  seed: 'autenticacion/api/autenticacion/semilla',
  authenticate: 'autenticacion/api/autenticacion/validarsemilla',
  ecf: 'recepcion/api/facturaselectronicas',
  rfce: 'recepcionfc/api/recepcion/ecf',
  approval: 'aprobacioncomercial/api/aprobacioncomercial',
  annul: 'anulacionrangos/api/operaciones/anularrango',
  result: 'consultaresultado/api/consultas/estado',
  trackIds: 'consultatrackids/api/trackids/consulta',
  rfceResult: 'consultarfce/api/Consultas/Consulta',
};
const assert = (ok: unknown, code: string): void => {
  if (!ok) throw new Error(code);
};
export function dgiiEndpoint(scope: FiscalScope, operation: DgiiOperation) {
  assertScope(scope);
  assertFiscalEnvironmentEnabled(scope);
  assert(Object.hasOwn(paths, operation), 'INVALID_DGII_OPERATION');
  // No certification URL for annulments is advertised by the reviewed manual.
  assert(
    !(['annul', 'trackIds'].includes(operation) && scope.environment === 'certification'),
    'DGII_SERVICE_UNAVAILABLE_IN_ENVIRONMENT',
  );
  const host = operation === 'rfce' || operation === 'rfceResult' ? 'fc' : 'ecf';
  const environmentPath =
    scope.environment === 'precertification'
      ? 'testecf'
      : scope.environment === 'certification'
        ? 'certecf'
        : 'ecf';
  return new URL(`https://${host}.dgii.gov.do/${environmentPath}/${paths[operation]}`);
}
export type DgiiHttpRequest = {
  operation: DgiiOperation;
  query?: Record<string, string>;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: Buffer;
};
export type DgiiTransport = (
  input: DgiiHttpRequest,
) => Promise<{ status: number; contentType: string; body: Buffer }>;

function utf8(body: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new Error('INVALID_DGII_ENCODING');
  }
}

/** Validate even injected transport inputs before opening a socket. */
export function validateDgiiHttpRequest(input: DgiiHttpRequest): void {
  assert(Object.hasOwn(paths, input.operation), 'INVALID_DGII_OPERATION');
  const get = ['seed', 'result', 'rfceResult', 'trackIds'].includes(input.operation);
  assert(input.method === (get ? 'GET' : 'POST'), 'INVALID_DGII_METHOD');
  assert(
    get ? input.body === undefined : Buffer.isBuffer(input.body) && input.body.length > 0,
    'INVALID_DGII_BODY',
  );
  assert(!input.body || input.body.length <= 3 * 1024 * 1024, 'DGII_REQUEST_TOO_LARGE');
  const keys =
    input.operation === 'result'
      ? ['trackid']
      : input.operation === 'rfceResult'
        ? ['RNC_Emisor', 'ENCF', 'Cod_Seguridad_eCF']
        : input.operation === 'trackIds'
          ? ['rncemisor', 'encf']
          : [];
  assert(
    Object.keys(input.query ?? {}).length === keys.length &&
      keys.every(
        (key) =>
          typeof input.query?.[key] === 'string' &&
          input.query[key].length > 0 &&
          input.query[key].length <= 200,
      ),
    'INVALID_DGII_QUERY',
  );
  for (const [key, value] of Object.entries(input.headers)) {
    assert(
      ['accept', 'authorization', 'content-type', 'content-length'].includes(key) &&
        typeof value === 'string' &&
        !/[\r\n]/.test(value),
      'INVALID_DGII_HEADER',
    );
  }
  if (!get)
    assert(
      input.headers['content-length'] === String(input.body!.length) &&
        /^multipart\/form-data; boundary=corestack-[a-f0-9]{48}$/.test(
          input.headers['content-type'] ?? '',
        ),
      'INVALID_DGII_MULTIPART',
    );
}

/** Opt-in only; not wired to preview/runtime. HTTPS system trust, fixed hosts,
 * bounded deadline/body, no redirect or automatic retry (especially POST).
 */
export function createDgiiHttpsTransport(scope: FiscalScope, enabled: boolean): DgiiTransport {
  const savedScope = Object.freeze({ ...scope });
  dgiiEndpoint(savedScope, 'seed');
  assert(
    enabled === true && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
    'DGII_NETWORK_DISABLED',
  );
  return async (input) => {
    validateDgiiHttpRequest(input);
    const url = dgiiEndpoint(savedScope, input.operation);
    for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value);
    assert(!input.body || input.body.length <= 3 * 1024 * 1024, 'DGII_REQUEST_TOO_LARGE');
    return new Promise((resolve, reject) => {
      const fail = () => reject(new Error('DGII_TRANSPORT_UNCONFIRMED'));
      const req = request(url, {
        method: input.method,
        headers: input.headers,
        agent: false,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      });
      const timer = setTimeout(() => req.destroy(new Error('DEADLINE')), 25000);
      req.once('error', () => {
        clearTimeout(timer);
        fail();
      });
      req.once('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
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
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks),
          });
        });
      });
      req.end(input.body);
    });
  };
}

/** Production implementation must verify XMLDSig, signer/delegation, complete
 * signed document identity AND signed XSD. No permissive default implementation.
 */
export type SignedXmlVerifier = (
  scope: FiscalScope,
  kind: 'ECF' | 'RFCE' | 'ACECF' | 'ANECF' | 'SEMILLA',
  xml: string,
) => Promise<{
  sha256: string;
  actorRnc: string;
  encf?: string;
  total?: string;
  securityCode?: string;
}>;
export function createDgiiClient(
  scope: FiscalScope,
  transport: DgiiTransport,
  verifySignedXml: SignedXmlVerifier,
  now: () => number = Date.now,
) {
  const savedScope = Object.freeze({ ...scope });
  dgiiEndpoint(savedScope, 'seed');
  let token: { value: string; expires: number } | null = null;
  let authenticationGeneration = 0;
  async function call(input: DgiiHttpRequest, authenticated: boolean) {
    const headers = { ...input.headers };
    const usedToken = authenticated ? token : null;
    if (authenticated) {
      assert(token && token.expires > now() + 30000, 'DGII_AUTHENTICATION_REQUIRED');
      headers.authorization = `Bearer ${token!.value}`;
    }
    const response = await transport({ ...input, headers });
    if (response.status === 401 || response.status === 403) {
      // A delayed rejection of an old request must not invalidate a new session.
      if (authenticated && token === usedToken) token = null;
      throw new Error('DGII_AUTHENTICATION_REJECTED');
    }
    const structuredCommercialRejection =
      input.operation === 'approval' && response.status === 400;
    assert(
      (response.status >= 200 && response.status < 300) || structuredCommercialRejection,
      'DGII_RESPONSE_UNCONFIRMED',
    );
    assert(response.body.length <= 2 * 1024 * 1024, 'DGII_RESPONSE_TOO_LARGE');
    return response;
  }
  async function json(input: DgiiHttpRequest, authenticated: boolean) {
    const response = await call(input, authenticated);
    assert(
      response.contentType.split(';')[0].trim() === 'application/json',
      'DGII_RESPONSE_UNCONFIRMED',
    );
    try {
      const value: unknown = JSON.parse(utf8(response.body));
      assert(
        value && typeof value === 'object' && !Array.isArray(value),
        'DGII_RESPONSE_UNCONFIRMED',
      );
      return value as Record<string, unknown>;
    } catch {
      throw new Error('DGII_RESPONSE_UNCONFIRMED');
    }
  }
  async function upload(
    operation: DgiiOperation,
    kind: Parameters<SignedXmlVerifier>[1],
    xml: string,
    authenticated: boolean,
  ) {
    assert(
      typeof xml === 'string' && Buffer.byteLength(xml) <= 2 * 1024 * 1024 && !/<!/i.test(xml),
      'INVALID_SIGNED_XML',
    );
    dgiiEndpoint(savedScope, operation);
    const evidence = await verifySignedXml(savedScope, kind, xml);
    assert(
      evidence.actorRnc === savedScope.issuerRnc &&
        evidence.sha256 === createHash('sha256').update(xml).digest('hex'),
      'SIGNED_EVIDENCE_MISMATCH',
    );
    let filename = `${savedScope.issuerRnc}${kind}.xml`;
    if (kind === 'ECF' || kind === 'RFCE') {
      const parsed = parseEncf(evidence.encf!);
      const total = scaledDecimal(evidence.total, 2);
      assert(
        kind === 'RFCE'
          ? parsed.type === 32 && total < 25000000n
          : parsed.type !== 32 || total >= 25000000n,
        'WRONG_DGII_RECEPTION_CHANNEL',
      );
      filename = `${savedScope.issuerRnc}${evidence.encf}.xml`;
    }
    const boundary = `corestack-${randomBytes(24).toString('hex')}`;
    assert(!xml.includes(boundary), 'MULTIPART_BOUNDARY_COLLISION');
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="xml"; filename="${filename}"\r\nContent-Type: text/xml\r\n\r\n${xml}\r\n--${boundary}--\r\n`,
      'utf8',
    );
    return json(
      {
        operation,
        method: 'POST',
        body,
        headers: {
          accept: 'application/json',
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(body.length),
        },
      },
      authenticated,
    );
  }
  return {
    async seed() {
      const response = await call(
        { operation: 'seed', method: 'GET', headers: { accept: 'application/xml' } },
        false,
      );
      const xml = utf8(response.body);
      assert(
        ['application/xml', 'text/xml'].includes(response.contentType.split(';')[0].trim()) &&
          !/<!/i.test(xml),
        'INVALID_DGII_SEED',
      );
      return xml; // preserve exactly for the signer; no reserialization
    },
    async authenticate(signedSeed: string) {
      const generation = ++authenticationGeneration;
      token = null;
      const response = await upload('authenticate', 'SEMILLA', signedSeed, false);
      assert(generation === authenticationGeneration, 'DGII_AUTHENTICATION_SUPERSEDED');
      const expires = typeof response.expira === 'string' ? Date.parse(response.expira) : NaN;
      const issued = typeof response.expedido === 'string' ? Date.parse(response.expedido) : NaN;
      assert(
        typeof response.token === 'string' &&
          /^[A-Za-z0-9._~+\/-]{1,8192}={0,2}$/.test(response.token) &&
          Number.isFinite(issued) &&
          Number.isFinite(expires) &&
          issued <= now() + 60000 &&
          expires > now() + 30000 &&
          expires > issued,
        'INVALID_DGII_AUTHENTICATION',
      );
      token = { value: response.token as string, expires };
      return { expiresAt: expires }; // never return/log token
    },
    async submit(kind: 'ECF' | 'RFCE' | 'ACECF' | 'ANECF', signedXml: string) {
      assert(['ECF', 'RFCE', 'ACECF', 'ANECF'].includes(kind), 'INVALID_DGII_DOCUMENT');
      const operation = { ECF: 'ecf', RFCE: 'rfce', ACECF: 'approval', ANECF: 'annul' }[
        kind
      ] as DgiiOperation;
      return upload(operation, kind, signedXml, true); // acknowledgment != fiscal acceptance
    },
    async result(trackId: string) {
      assert(
        typeof trackId === 'string' && /^[A-Za-z0-9-]{1,200}$/.test(trackId),
        'INVALID_TRACK_ID',
      );
      return json(
        {
          operation: 'result',
          method: 'GET',
          query: { trackid: trackId },
          headers: { accept: 'application/json' },
        },
        true,
      );
    },
    async trackIds(encf: string) {
      parseEncf(encf);
      dgiiEndpoint(savedScope, 'trackIds');
      const response = await call(
        {
          operation: 'trackIds',
          method: 'GET',
          query: { rncemisor: savedScope.issuerRnc, encf },
          headers: { accept: 'application/json' },
        },
        true,
      );
      assert(
        response.contentType.split(';')[0].trim() === 'application/json',
        'DGII_RESPONSE_UNCONFIRMED',
      );
      let value: unknown;
      try {
        value = JSON.parse(utf8(response.body));
      } catch {
        throw new Error('DGII_RESPONSE_UNCONFIRMED');
      }
      assert(Array.isArray(value) && value.length <= 1000, 'INVALID_TRACK_LIST');
      return (value as unknown[]).map((item) => {
        assert(item && typeof item === 'object' && !Array.isArray(item), 'INVALID_TRACK_LIST');
        const id = (item as Record<string, unknown>).trackId;
        assert(typeof id === 'string' && /^[A-Za-z0-9-]{1,200}$/.test(id), 'INVALID_TRACK_LIST');
        return id as string;
      });
    },
    async rfceResult(encf: string, securityCode: string) {
      assert(
        parseEncf(encf).type === 32 &&
          typeof securityCode === 'string' &&
          /^[A-Za-z0-9+/]{6}$/.test(securityCode),
        'INVALID_RFCE_QUERY',
      );
      return json(
        {
          operation: 'rfceResult',
          method: 'GET',
          query: { RNC_Emisor: savedScope.issuerRnc, ENCF: encf, Cod_Seguridad_eCF: securityCode },
          headers: { accept: 'application/json' },
        },
        true,
      );
    },
  };
}

/** Scope-bound result interpretation. Never automatically frees/reuses a number. */
export function interpretDgiiResult(
  value: Record<string, unknown>,
  expected: { rnc: string; encf: string; trackId?: string },
) {
  assert(
    value.rnc === expected.rnc &&
      (value.eNCF ?? value.encf) === expected.encf &&
      (expected.trackId === undefined || value.trackId === expected.trackId),
    'DGII_RESULT_IDENTITY_MISMATCH',
  );
  assert(
    Number.isInteger(value.codigo) && [0, 1, 2, 3, 4].includes(value.codigo as number),
    'UNKNOWN_DGII_RESULT',
  );
  assert(
    value.secuenciaUtilizada === undefined || typeof value.secuenciaUtilizada === 'boolean',
    'INVALID_SEQUENCE_USAGE',
  );
  const code = value.codigo as number;
  return {
    state: ['NOT_FOUND', 'ACCEPTED', 'REJECTED', 'PROCESSING', 'ACCEPTED_CONDITIONALLY'][code],
    fiscalAccepted: code === 1 || code === 4,
    sequenceReuse: 'MANUAL_REVIEW_ONLY' as const,
    sequenceUsed: typeof value.secuenciaUtilizada === 'boolean' ? value.secuenciaUtilizada : null,
  };
}
