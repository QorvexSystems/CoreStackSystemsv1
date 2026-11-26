import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import { createServer } from 'node:https';
import { dirname, join, resolve, sep } from 'node:path';
import { scopeKey, type FiscalScope } from './catalog.ts';
import {
  certificationHash,
  runCertificationCycle,
  validateCertificationPlan,
  type CertificationDocument,
  type CertificationDocumentState,
  type CertificationPlan,
} from './certification-automation.ts';
import { createPkcs12FiscalSigning } from './pkcs12-fiscal-signing.ts';
import {
  createPkcs12XmlSigner,
  unsignedXmlFromGeneratedSignature,
  type Pkcs12SignerConfig,
} from './pkcs12-signer.ts';
import { createDgiiClient, createDgiiHttpsTransport } from './dgii-client.ts';
import { createDeliveryGateway } from './delivery-gateway.ts';
import {
  preparePrintedRepresentation,
  renderPrintedRepresentation,
} from './printed-representation.ts';
import { parseSerializedXml } from './xml.ts';

type Config = {
  scope: FiscalScope;
  signer: Omit<Pkcs12SignerConfig, 'scope'>;
  inputRoot: string;
  evidenceRoot: string;
  tokenFile: string;
  tlsCertificateFile: string;
  tlsKeyFile: string;
  listenHost: string;
  listenPort: number;
  approvedCases: Array<{ caseId: string; plans: Record<string, string> }>;
};
type Request = {
  caseId: string;
  tenantId: string;
  issuerRnc: string;
  environment: 'certification';
  stepNumber: number;
  certificateSha256: string;
};
const ensure: (value: unknown, code: string) => asserts value = (value, code) => {
  if (!value) throw Error(code);
};
const config: Config = JSON.parse(
  await readFile(
    process.env.CERTIFICATION_RUNNER_CONFIG ?? '/run/config/certification-runner.json',
    'utf8',
  ),
);
ensure(
  config.scope.environment === 'certification' &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(config.scope.tenantId) &&
    /^(?:\d{9}|\d{11})$/.test(config.scope.issuerRnc) &&
    /^[a-f0-9]{64}$/.test(config.signer.expectedCertificateSha256) &&
    config.signer.workRoot === '/tmp/fiscal-signer' &&
    config.listenHost === '0.0.0.0' &&
    config.listenPort === 8445 &&
    resolve(config.inputRoot) === '/input' &&
    resolve(config.evidenceRoot) === '/evidence' &&
    Array.isArray(config.approvedCases),
  'CERTIFICATION_RUNNER_CONFIG_INVALID',
);
const token = (await readFile(config.tokenFile, 'utf8')).trim();
ensure(/^[A-Za-z0-9_-]{43,128}$/.test(token), 'CERTIFICATION_RUNNER_TOKEN_INVALID');
const allowed = new Map<string, Record<string, string>>();
for (const item of config.approvedCases) {
  ensure(
    /^[a-zA-Z0-9_-]{1,100}$/.test(item.caseId) &&
      !allowed.has(item.caseId) &&
      Object.entries(item.plans).every(
        ([step, hash]) => ['2', '3', '4'].includes(step) && /^[a-f0-9]{64}$/.test(hash),
      ),
    'CERTIFICATION_RUNNER_APPROVAL_INVALID',
  );
  allowed.set(item.caseId, item.plans);
}
let busy = false;
const codeOf = (error: unknown) =>
  error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)
    ? error.message
    : 'CERTIFICATION_EXECUTION_FAILED';

async function readInputFile(path: string, max = 2 * 1024 * 1024) {
  const canonical = await realpath(path);
  ensure(canonical.startsWith(`${config.inputRoot}${sep}`), 'CERTIFICATION_INPUT_PATH_REJECTED');
  const file = await lstat(path);
  ensure(
    file.isFile() && !file.isSymbolicLink() && file.size > 0 && file.size <= max,
    'CERTIFICATION_INPUT_FILE_INVALID',
  );
  return readFile(path, 'utf8');
}
async function atomicFile(path: string, body: string, exclusive = false) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!exclusive) await rename(target, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function existing(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function loadPlan(request: Request, number = request.stepNumber) {
  const digest = allowed.get(request.caseId)?.[String(number)];
  if (!digest) return null;
  const root = join(config.inputRoot, request.caseId, `step-${number}`);
  const raw = await readInputFile(join(root, 'manifest.json'));
  ensure(certificationHash(raw) === digest, 'CERTIFICATION_MANIFEST_HASH_MISMATCH');
  const plan = JSON.parse(raw) as CertificationPlan;
  validateCertificationPlan(plan, {
    caseId: request.caseId,
    scope: config.scope,
    stepNumber: number,
    certificateSha256: request.certificateSha256,
  });
  return { root, raw, plan, digest };
}
async function encodeQr(url: string, version: 8 | 9) {
  return new Promise<string>((resolveQr, reject) => {
    const child = spawn(
      'qrencode',
      [
        '-t',
        'SVG',
        '-m',
        '0',
        '-s',
        '1',
        '-l',
        'L',
        '-v',
        String(version),
        '--strict-version',
        '-o',
        '-',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } },
    );
    const parts: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (part: Buffer) => {
      size += part.length;
      if (size > 262144) child.kill('SIGKILL');
      else parts.push(part);
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(Error('CERTIFICATION_QR_FAILED'));
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (status !== 0) {
        reject(Error('CERTIFICATION_QR_FAILED'));
        return;
      }
      const svg = Buffer.concat(parts)
        .toString('utf8')
        .replace(/<\?xml[^>]*>\s*/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
      resolveQr(svg);
    });
    child.stdin.end(url);
  });
}

async function execute(request: Request) {
  ensure(
    request.environment === 'certification' &&
      request.tenantId === config.scope.tenantId &&
      request.issuerRnc === config.scope.issuerRnc &&
      request.certificateSha256 === config.signer.expectedCertificateSha256 &&
      /^[a-zA-Z0-9_-]{1,100}$/.test(request.caseId) &&
      [2, 3, 4, 5].includes(request.stepNumber),
    'CERTIFICATION_REQUEST_SCOPE_INVALID',
  );
  const loaded = await loadPlan(request, request.stepNumber === 5 ? 4 : request.stepNumber);
  if (!loaded) return { status: 'WAITING_INPUT', code: 'CERTIFICATION_APPROVED_PLAN_REQUIRED' };
  const { root, plan, digest } = loaded;
  const stateRoot = join(config.evidenceRoot, request.caseId, `step-${plan.stepNumber}`);
  const signerConfig = { ...config.signer, scope: config.scope };
  await mkdir(config.signer.workRoot ?? '/tmp', { recursive: true, mode: 0o700 });
  await mkdir('/tmp/seed-signer', { recursive: true, mode: 0o700 });
  const fiscal = await createPkcs12FiscalSigning(signerConfig);
  let signer: Awaited<ReturnType<typeof createPkcs12XmlSigner>> | undefined;
  try {
    signer = await createPkcs12XmlSigner({ ...signerConfig, workRoot: '/tmp/seed-signer' });
    if (request.stepNumber === 5) {
      const reports: Array<{ encf: string; sha256: string }> = [];
      for (const doc of plan.documents) {
        const raw = await existing(join(stateRoot, `${doc.id}.json`));
        ensure(raw, 'CERTIFICATION_SIMULATION_NOT_COMPLETE');
        const state = JSON.parse(raw) as CertificationDocumentState;
        ensure(
          state.status === 'ACCEPTED' &&
            state.planSha256 === digest &&
            certificationHash(state.signedXml) === state.signedSha256,
          'CERTIFICATION_PRINT_SOURCE_INVALID',
        );
        const signed =
          doc.route === 'RFCE'
            ? await readFile(join(stateRoot, `${doc.id}-ecf.xml`), 'utf8')
            : state.signedXml;
        const proof = await fiscal.verify(config.scope, 'ECF', signed);
        ensure(proof.encf === doc.encf, 'CERTIFICATION_PRINT_IDENTITY_MISMATCH');
        if (doc.route === 'RFCE')
          await fiscal.bundle(config.scope, {
            route: 'RFCE',
            unsignedEcfXml: unsignedXmlFromGeneratedSignature(signed),
            signedEcfXml: signed,
            submissionXml: state.signedXml,
          });
        const model = await preparePrintedRepresentation(
          config.scope,
          parseSerializedXml(unsignedXmlFromGeneratedSignature(signed)),
          signed,
          fiscal.printVerify,
        );
        const html = renderPrintedRepresentation(
          model,
          await encodeQr(model.qrUrl, model.qrVersion),
        );
        await atomicFile(
          join(config.evidenceRoot, request.caseId, 'printed', `${doc.encf}.html`),
          html,
        );
        reports.push({ encf: doc.encf, sha256: certificationHash(html) });
      }
      const report = JSON.stringify(reports);
      await atomicFile(join(config.evidenceRoot, request.caseId, 'printed', 'report.json'), report);
      return {
        status: 'SUCCEEDED',
        code: 'CERTIFICATION_PRINTED_SET_READY',
        reportSha256: certificationHash(report),
      };
    }
    const client = createDgiiClient(
      config.scope,
      createDgiiHttpsTransport(config.scope, true),
      fiscal.verify,
    );
    let authenticated = false;
    const authenticate = async () => {
      if (authenticated) return;
      await client.authenticate(await fiscal.signSeed(await client.seed()));
      authenticated = true;
    };
    const gateway = createDeliveryGateway(config.scope, client, fiscal.verify);
    const outcome = await runCertificationCycle(
      plan,
      digest,
      {
        readInput: (doc) => readInputFile(join(root, doc.file)),
        async sign(doc, xml) {
          if (doc.route === 'ACECF') return signer!.sign(xml);
          let unsigned = xml;
          if (!unsigned.includes('<FechaHoraFirma>')) {
            const date = new Intl.DateTimeFormat('en-GB', {
              timeZone: 'America/Santo_Domingo',
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hourCycle: 'h23',
            })
              .format(new Date())
              .replace(/\//g, '-')
              .replace(', ', ' ');
            ensure(unsigned.endsWith('</ECF>'), 'CERTIFICATION_ECF_ROOT_INVALID');
            unsigned = unsigned.slice(0, -6) + `<FechaHoraFirma>${date}</FechaHoraFirma></ECF>`;
          }
          const signed = await fiscal.signing.signEcf(config.scope, unsigned);
          if (doc.route === 'ECF') return signed;
          await atomicFile(join(stateRoot, `${doc.id}-ecf.xml`), signed);
          return fiscal.signing.signConsumptionSummary(config.scope, unsigned, signed);
        },
        async verify(doc, signed) {
          const proof = await fiscal.verify(config.scope, doc.route, signed);
          ensure(
            proof.encf === doc.encf && proof.actorRnc === config.scope.issuerRnc,
            'CERTIFICATION_SIGNED_IDENTITY_INVALID',
          );
          if (doc.route === 'RFCE') {
            const template = unsignedXmlFromGeneratedSignature(signed).replace(
              /<CodigoSeguridadeCF>[A-Za-z0-9+/]{6}<\/CodigoSeguridadeCF>/,
              '<CodigoSeguridadeCF>ABC123</CodigoSeguridadeCF>',
            );
            ensure(
              certificationHash(template) === doc.rfceTemplateSha256,
              'CERTIFICATION_RFCE_WORKBOOK_MISMATCH',
            );
          }
        },
        async send(doc, state) {
          await authenticate();
          if (doc.route === 'ACECF') {
            const response = await client.submit('ACECF', state.signedXml);
            const code = String(response.codigo);
            ensure(
              ['01', '02', '1', '2'].includes(code) && typeof response.estado === 'string',
              'CERTIFICATION_APPROVAL_RESPONSE_UNCONFIRMED',
            );
            return { status: ['01', '1'].includes(code) ? 'ACCEPTED' : 'REJECTED' };
          }
          const result = await gateway.send({
            documentId: String(plan.documents.indexOf(doc) + 1),
            encf: doc.encf,
            claimToken: randomUUID(),
            action: 'SEND',
            route: doc.route,
            xml: state.signedXml,
            sha256: state.signedSha256,
            trackId: null,
            scope: config.scope,
          });
          return {
            status:
              result.outcome === 'ACCEPTED'
                ? 'ACCEPTED'
                : result.outcome === 'PROCESSING'
                  ? 'PROCESSING'
                  : result.outcome === 'REJECTED'
                    ? 'REJECTED'
                    : 'REVIEW_REQUIRED',
            ...(result.trackId ? { trackId: result.trackId } : {}),
          };
        },
        async reconcile(doc, state) {
          ensure(doc.route !== 'ACECF', 'CERTIFICATION_APPROVAL_MANUAL_REVIEW_REQUIRED');
          await authenticate();
          const result = await gateway.reconcile({
            documentId: String(plan.documents.indexOf(doc) + 1),
            encf: doc.encf,
            claimToken: randomUUID(),
            action: 'RECONCILE',
            route: doc.route,
            xml: state.signedXml,
            sha256: state.signedSha256,
            trackId: state.trackId ?? null,
            scope: config.scope,
          });
          return {
            status:
              result.outcome === 'ACCEPTED'
                ? 'ACCEPTED'
                : result.outcome === 'PROCESSING'
                  ? 'PROCESSING'
                  : result.outcome === 'REJECTED'
                    ? 'REJECTED'
                    : 'REVIEW_REQUIRED',
            ...(result.trackId ? { trackId: result.trackId } : {}),
          };
        },
      },
      {
        async read(id) {
          const raw = await existing(join(stateRoot, `${id}.json`));
          return raw ? JSON.parse(raw) : null;
        },
        write: (state) => atomicFile(join(stateRoot, `${state.id}.json`), JSON.stringify(state)),
        async reserve(doc, planSha256) {
          const path = join(config.evidenceRoot, 'reservations', `${doc.route}-${doc.encf}.json`);
          const binding = JSON.stringify({
            caseId: request.caseId,
            stepNumber: plan.stepNumber,
            id: doc.id,
            planSha256,
            scope: scopeKey(config.scope),
          });
          try {
            await atomicFile(path, binding, true);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            ensure(
              (await readFile(path, 'utf8')) === binding,
              'CERTIFICATION_SEQUENCE_ALREADY_USED',
            );
          }
        },
      },
    );
    if (outcome.status === 'SUCCEEDED') {
      const report = [];
      for (const doc of plan.documents) {
        const state = JSON.parse(
          await readFile(join(stateRoot, `${doc.id}.json`), 'utf8'),
        ) as CertificationDocumentState;
        report.push({
          id: doc.id,
          encf: doc.encf,
          route: doc.route,
          signedSha256: state.signedSha256,
          status: state.status,
          trackId: state.trackId ?? null,
        });
        if (doc.route === 'RFCE') {
          const signedEcf = await readFile(join(stateRoot, `${doc.id}-ecf.xml`), 'utf8');
          await fiscal.bundle(config.scope, {
            route: 'RFCE',
            unsignedEcfXml: unsignedXmlFromGeneratedSignature(signedEcf),
            signedEcfXml: signedEcf,
            submissionXml: state.signedXml,
          });
          await atomicFile(
            join(
              config.evidenceRoot,
              request.caseId,
              `portal-step-${plan.stepNumber}`,
              `${config.scope.issuerRnc}${doc.encf}.xml`,
            ),
            signedEcf,
          );
        }
      }
      const body = JSON.stringify(report);
      ensure(
        certificationHash(body) === outcome.reportSha256,
        'CERTIFICATION_REPORT_HASH_MISMATCH',
      );
      await atomicFile(join(stateRoot, 'report.json'), body);
    }
    return outcome;
  } finally {
    await signer?.close();
    await fiscal.close();
  }
}
const server = createServer(
  {
    cert: await readFile(config.tlsCertificateFile),
    key: await readFile(config.tlsKeyFile),
    minVersion: 'TLSv1.2',
    maxHeaderSize: 8192,
  },
  async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    const supplied = createHash('sha256')
      .update(req.headers.authorization ?? '')
      .digest();
    const correct = createHash('sha256').update(`Bearer ${token}`).digest();
    if (!timingSafeEqual(supplied, correct)) {
      res.writeHead(401).end('{}');
      req.resume();
      return;
    }
    if (req.method === 'GET' && req.url === '/health/live') {
      res.end('{"status":"ok"}');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/internal/v1/certification/step') {
      res.writeHead(404).end('{}');
      req.resume();
      return;
    }
    if (busy) {
      res.writeHead(409).end('{}');
      req.resume();
      return;
    }
    busy = true;
    let input: Request | undefined;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        ensure(size <= 4096, 'CERTIFICATION_BODY_TOO_LARGE');
        chunks.push(chunk);
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request;
      const result = await execute(input);
      res.end(JSON.stringify({ ...input, ...result }));
    } catch (error) {
      const code = codeOf(error);
      console.warn(JSON.stringify({ event: 'CERTIFICATION_RUNNER_FAILED', code }));
      res.end(JSON.stringify({ ...input, status: 'FAILED', code }));
    } finally {
      busy = false;
    }
  },
);
server.requestTimeout = 110_000;
server.headersTimeout = 10_000;
server.listen(config.listenPort, config.listenHost, () =>
  console.log('CERTIFICATION_RUNNER_READY'),
);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close());
