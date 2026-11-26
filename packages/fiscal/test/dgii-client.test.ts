import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createDgiiClient,
  createDgiiHttpsTransport,
  dgiiEndpoint,
  interpretDgiiResult,
  validateDgiiHttpRequest,
  type DgiiHttpRequest,
  type SignedXmlVerifier,
} from '../src/dgii-client.ts';
import type { FiscalScope } from '../src/catalog.ts';

const scope: FiscalScope = {
  tenantId: 'synthetic-client',
  issuerRnc: '101010101',
  environment: 'precertification',
};
const xml = '<SyntheticSignedFixture>á &amp; prueba</SyntheticSignedFixture>';
const epoch = Date.parse('2026-09-22T12:00:00Z');

test('late authentication response cannot replace the newest session', async () => {
  type Response = { status: number; contentType: string; body: Buffer };
  let finishFirst!: (value: Response) => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let authentications = 0;
  const authResponse = (token: string): Response => ({
    status: 200,
    contentType: 'application/json',
    body: Buffer.from(
      JSON.stringify({
        token,
        expedido: new Date(epoch).toISOString(),
        expira: new Date(epoch + 3600000).toISOString(),
      }),
    ),
  });
  const client = createDgiiClient(
    scope,
    async (input) => {
      if (input.operation === 'authenticate') {
        if (++authentications === 1) {
          started();
          return new Promise<Response>((resolve) => {
            finishFirst = resolve;
          });
        }
        return authResponse('new-token');
      }
      assert.equal(input.headers.authorization, 'Bearer new-token');
      return { status: 200, contentType: 'application/json', body: Buffer.from('{}') };
    },
    mockVerifier,
    () => epoch,
  );
  const old = client.authenticate(xml);
  const rejected = assert.rejects(old, /SUPERSEDED/);
  await firstStarted;
  await client.authenticate(xml);
  finishFirst(authResponse('old-token'));
  await rejected;
  await client.result('track');
});

test('late 401 for old token cannot clear renewed authentication', async () => {
  type Response = { status: number; contentType: string; body: Buffer };
  let finishOld!: (value: Response) => void;
  let started!: () => void;
  const queryStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let authentications = 0;
  const client = createDgiiClient(
    scope,
    async (input) => {
      if (input.operation === 'authenticate')
        return {
          status: 200,
          contentType: 'application/json',
          body: Buffer.from(
            JSON.stringify({
              token: `token-${++authentications}`,
              expedido: new Date(epoch).toISOString(),
              expira: new Date(epoch + 3600000).toISOString(),
            }),
          ),
        };
      if (input.headers.authorization === 'Bearer token-1') {
        started();
        return new Promise<Response>((resolve) => {
          finishOld = resolve;
        });
      }
      assert.equal(input.headers.authorization, 'Bearer token-2');
      return { status: 200, contentType: 'application/json', body: Buffer.from('{}') };
    },
    mockVerifier,
    () => epoch,
  );
  await client.authenticate(xml);
  const rejected = assert.rejects(client.result('old-track'), /AUTHENTICATION_REJECTED/);
  await queryStarted;
  await client.authenticate(xml);
  finishOld({ status: 401, contentType: 'application/json', body: Buffer.from('{}') });
  await rejected;
  await client.result('new-track');
});
// Deliberate mock verifier: these fixtures are NOT signed, and never leave this test.
const mockVerifier: SignedXmlVerifier = async (s, kind, bytes) => ({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  actorRnc: s.issuerRnc,
  encf: kind === 'RFCE' ? 'E320000000001' : 'E310000000001',
  total: '118.00',
});
function harness(
  options: {
    verifier?: SignedXmlVerifier;
    status?: number;
    payload?: unknown;
    contentType?: string;
  } = {},
) {
  const calls: DgiiHttpRequest[] = [];
  let clock = epoch;
  const client = createDgiiClient(
    scope,
    async (input) => {
      validateDgiiHttpRequest(input);
      calls.push(input);
      if (input.operation === 'authenticate')
        return {
          status: 200,
          contentType: 'application/json',
          body: Buffer.from(
            JSON.stringify({
              token: 'synthetic-token',
              expedido: new Date(epoch).toISOString(),
              expira: new Date(epoch + 3600000).toISOString(),
            }),
          ),
        };
      return {
        status: options.status ?? 200,
        contentType: options.contentType ?? 'application/json',
        body: Buffer.from(JSON.stringify(options.payload ?? { trackId: 'synthetic-track' })),
      };
    },
    options.verifier ?? mockVerifier,
    () => clock,
  );
  return {
    client,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test('fixed DGII hosts and production fails closed without activation manifest', () => {
  assert.equal(
    dgiiEndpoint(scope, 'ecf').href,
    'https://ecf.dgii.gov.do/testecf/recepcion/api/facturaselectronicas',
  );
  assert.equal(
    dgiiEndpoint({ ...scope, environment: 'certification' }, 'rfce').href,
    'https://fc.dgii.gov.do/certecf/recepcionfc/api/recepcion/ecf',
  );
  assert.throws(
    () => dgiiEndpoint({ ...scope, environment: 'production' }, 'seed'),
    /PRODUCTION_ACTIVATION_REQUIRED/,
  );
  assert.throws(
    () => dgiiEndpoint({ ...scope, environment: 'certification' }, 'annul'),
    /UNAVAILABLE/,
  );
  assert.throws(() => dgiiEndpoint(scope, 'constructor' as never), /INVALID_DGII_OPERATION/);
  assert.throws(() => createDgiiHttpsTransport(scope, false), /NETWORK_DISABLED/);
});

test('transport input rejects host override, wrong method and unapproved queries before network', () => {
  const base: DgiiHttpRequest = {
    operation: 'seed',
    method: 'GET',
    headers: { accept: 'application/xml' },
  };
  validateDgiiHttpRequest(base);
  assert.throws(
    () => validateDgiiHttpRequest({ ...base, headers: { host: 'evil.invalid' } }),
    /HEADER/,
  );
  assert.throws(
    () => validateDgiiHttpRequest({ ...base, headers: { accept: 'xml\r\nHost: evil' } }),
    /HEADER/,
  );
  assert.throws(() => validateDgiiHttpRequest({ ...base, method: 'POST' }), /METHOD/);
  assert.throws(
    () => validateDgiiHttpRequest({ ...base, query: { redirect: 'https://evil.invalid' } }),
    /QUERY/,
  );
  assert.throws(() => validateDgiiHttpRequest({ ...base, body: Buffer.from('x') }), /BODY/);
  assert.throws(() => validateDgiiHttpRequest({ ...base, operation: 'result' }), /QUERY/);
});

test('authentication preserves multipart XML, caches token privately and submits exactly once', async () => {
  const h = harness();
  const authentication = await h.client.authenticate(xml);
  assert.deepEqual(authentication, { expiresAt: epoch + 3600000 });
  assert.equal(h.calls[0].headers.authorization, undefined);
  const response = await h.client.submit('ECF', xml);
  assert.deepEqual(response, { trackId: 'synthetic-track' }); // no acceptance inferred
  assert.equal(h.calls.length, 2);
  const sent = h.calls[1];
  assert.equal(sent.headers.authorization, 'Bearer synthetic-token');
  assert.equal(sent.headers['content-length'], String(sent.body!.length));
  assert.ok(sent.body!.includes(Buffer.from(`\r\n\r\n${xml}\r\n`)));
  assert.ok(sent.body!.includes(Buffer.from('name="xml"; filename="101010101E310000000001.xml"')));
});

test('token expiry, isolation and missing authentication block transmission', async () => {
  const h = harness();
  await assert.rejects(h.client.result('track'), /AUTHENTICATION_REQUIRED/);
  assert.equal(h.calls.length, 0);
  await h.client.authenticate(xml);
  await assert.rejects(harness().client.result('track'), /AUTHENTICATION_REQUIRED/);
  h.advance(3600000 - 30000);
  await assert.rejects(h.client.submit('ECF', xml), /AUTHENTICATION_REQUIRED/);
  assert.equal(h.calls.length, 1);
});

test('401 clears token; errors and redirects never trigger POST retries', async () => {
  for (const status of [401, 403, 302, 429, 500]) {
    const h = harness({ status });
    await h.client.authenticate(xml);
    await assert.rejects(
      h.client.submit('ECF', xml),
      status === 401 || status === 403 ? /AUTHENTICATION_REJECTED/ : /RESPONSE_UNCONFIRMED/,
    );
    assert.equal(h.calls.length, 2);
    if (status === 401 || status === 403) {
      await assert.rejects(h.client.result('track'), /AUTHENTICATION_REQUIRED/);
      assert.equal(h.calls.length, 2);
    }
  }
});

test('commercial approval preserves DGII structured rejection returned with HTTP 400', async () => {
  const rejection = {
    codigo: '02',
    estado: 'Aprobacion Comercial Rechazada.',
    mensaje: [null],
  };
  const h = harness({ status: 400, payload: rejection });
  await h.client.authenticate(xml);
  assert.deepEqual(await h.client.submit('ACECF', xml), rejection);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].operation, 'approval');
});

test('unverified, altered, wrong actor or dangerous XML is never uploaded', async () => {
  for (const verifier of [
    async () => {
      throw new Error('INVALID_SIGNATURE');
    },
    async () => ({ sha256: '0'.repeat(64), actorRnc: scope.issuerRnc }),
    async () => ({ sha256: createHash('sha256').update(xml).digest('hex'), actorRnc: '999999999' }),
  ] satisfies SignedXmlVerifier[]) {
    const h = harness({ verifier });
    await assert.rejects(h.client.authenticate(xml));
    assert.equal(h.calls.length, 0);
  }
  const h = harness();
  await assert.rejects(h.client.authenticate('<!DOCTYPE x><x/>'), /INVALID_SIGNED_XML/);
  assert.equal(h.calls.length, 0);
});

test('E32 reception channel boundary is exact in cents', async () => {
  for (const [kind, total, allowed] of [
    ['ECF', '249999.99', false],
    ['ECF', '250000.00', true],
    ['RFCE', '249999.99', true],
    ['RFCE', '250000.00', false],
  ] as const) {
    const h = harness({
      verifier: async (s, k, bytes) => ({
        ...(await mockVerifier(s, k, bytes)),
        encf: 'E320000000001',
        total,
      }),
    });
    await h.client.authenticate(xml);
    if (allowed) {
      await h.client.submit(kind, xml);
      assert.equal(h.calls[1].operation, kind === 'ECF' ? 'ecf' : 'rfce');
    } else {
      await assert.rejects(h.client.submit(kind, xml), /WRONG_DGII_RECEPTION_CHANNEL/);
      assert.equal(h.calls.length, 1);
    }
  }
});

test('queries carry scoped identifiers and reject invalid track/RFCE values', async () => {
  const h = harness();
  await h.client.authenticate(xml);
  await h.client.result('track-123');
  assert.deepEqual(h.calls[1].query, { trackid: 'track-123' });
  await h.client.rfceResult('E320000000001', 'aB+/12');
  assert.deepEqual(h.calls[2].query, {
    RNC_Emisor: scope.issuerRnc,
    ENCF: 'E320000000001',
    Cod_Seguridad_eCF: 'aB+/12',
  });
  await assert.rejects(h.client.result('track&x=y'), /INVALID_TRACK/);
  await assert.rejects(h.client.rfceResult('E310000000001', 'abcdef'), /INVALID_RFCE/);
  assert.equal(h.calls.length, 3);
});

test('seed retains exact UTF-8 bytes; invalid encodings rejected', async () => {
  for (const original of [
    '<?xml version="1.0" encoding="utf-8"?><SemillaModel>á</SemillaModel>',
    '\uFEFF<SemillaModel>z</SemillaModel>',
  ]) {
    const c = createDgiiClient(
      scope,
      async () => ({
        status: 200,
        contentType: 'text/xml; charset=utf-8',
        body: Buffer.from(original),
      }),
      mockVerifier,
    );
    assert.equal(await c.seed(), original);
  }
  const c = createDgiiClient(
    scope,
    async () => ({ status: 200, contentType: 'text/xml', body: Buffer.from([0xc3, 0x28]) }),
    mockVerifier,
  );
  await assert.rejects(c.seed(), /INVALID_DGII_ENCODING/);
});

test('malformed authentication and JSON never authorize later sends', async () => {
  for (const payload of [
    [],
    null,
    { token: 'ok', expedido: 'bad', expira: 'bad' },
    { token: 'x\r\ny', expedido: '2026-09-22T12:00:00Z', expira: '2026-09-22T13:00:00Z' },
  ]) {
    const c = createDgiiClient(
      scope,
      async () => ({
        status: 200,
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(payload)),
      }),
      mockVerifier,
      () => epoch,
    );
    await assert.rejects(c.authenticate(xml));
    await assert.rejects(c.result('track'), /AUTHENTICATION_REQUIRED/);
  }
});

test('result interpretation binds invoice identity and never releases a reserved eNCF', () => {
  const expected = { rnc: scope.issuerRnc, encf: 'E310000000001', trackId: 'track' };
  for (let codigo = 0; codigo <= 4; codigo++) {
    const result = interpretDgiiResult(
      { ...expected, eNCF: expected.encf, codigo, secuenciaUtilizada: false },
      expected,
    );
    assert.equal(result.fiscalAccepted, codigo === 1 || codigo === 4);
    assert.equal(result.sequenceReuse, 'MANUAL_REVIEW_ONLY');
  }
  assert.throws(
    () => interpretDgiiResult({ ...expected, codigo: 1, rnc: '999999999' }, expected),
    /IDENTITY/,
  );
  assert.throws(() => interpretDgiiResult({ ...expected, codigo: 7 }, expected), /UNKNOWN/);
  assert.throws(
    () => interpretDgiiResult({ ...expected, codigo: 1, secuenciaUtilizada: 'false' }, expected),
    /SEQUENCE/,
  );
});

test('track lookup binds issuer and document, parses bounded response list', async () => {
  const h = harness({ payload: [{ trackId: 'track-1' }, { trackId: 'track-2' }] });
  await h.client.authenticate(xml);
  assert.deepEqual(await h.client.trackIds('E310000000001'), ['track-1', 'track-2']);
  assert.deepEqual(h.calls[1].query, { rncemisor: scope.issuerRnc, encf: 'E310000000001' });
  assert.equal(h.calls[1].method, 'GET');
});
test('track lookup rejects malformed lists and is unavailable in certification', async () => {
  for (const payload of [
    { trackId: 'track' },
    [{ trackId: 'bad&track' }],
    Array.from({ length: 1001 }, () => ({ trackId: 'track' })),
  ]) {
    const h = harness({ payload });
    await h.client.authenticate(xml);
    await assert.rejects(h.client.trackIds('E310000000001'), /INVALID_TRACK_LIST/);
  }
  assert.throws(
    () => dgiiEndpoint({ ...scope, environment: 'certification' }, 'trackIds'),
    /UNAVAILABLE/,
  );
});
