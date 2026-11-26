import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createPkcs12FiscalSigning } from './pkcs12-fiscal-signing.ts';
import { createPkcs12XmlSigner } from './pkcs12-signer.ts';
import { createDgiiClient, createDgiiHttpsTransport } from './dgii-client.ts';
import { createDeliveryGateway } from './delivery-gateway.ts';
import type { DeliveryClaim, DeliveryOutcome } from './delivery-worker.ts';
import {
  RIVNU_CERTIFICATION_PLAN,
  validateRivnuCertificationPlan,
  type CertificationPlanItem,
} from './certification-set-plan.ts';

const signedRoot = '/signed';
const evidenceRoot = '/evidence';
const configPath = '/run/config/fiscal-signer.json';
const scope = Object.freeze({
  tenantId: 'cmt397emm0002nm0ogb50l2q6',
  issuerRnc: '40220429126',
  environment: 'certification' as const,
});
const expectedSourceSha256 = '35a6a606c9d95d093c38b3562a1284d2738eb295dbc538440a1a1bb4c6552457';
const expectedReportSha256 = 'eb1800d6a22c7483df037886245eba9b84de0d700ff381e9800473344e93ef04';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const ensure: (value: unknown, code: string) => asserts value = (value, code) => {
  if (!value) throw Error(code);
};
type State = Readonly<{
  encf: string;
  route: 'ECF' | 'RFCE';
  phase: number;
  xmlSha256: string;
  status: 'SUBMISSION_INTENT' | DeliveryOutcome;
  trackId?: string;
  updatedAt: string;
}>;
type SigningReport = {
  sourceSha256: string;
  scope: typeof scope;
  certificateSha256: string;
  ecf: { encf: string; signedSha256: string; total: string }[];
  rfce: { encf: string; signedSha256: string; securityCode: string }[];
};

const statePath = (encf: string, route: string) => `${evidenceRoot}/state/${route}-${encf}.json`;
async function readState(item: CertificationPlanItem): Promise<State | null> {
  if (item.route === 'PORTAL') return null;
  try {
    const state = JSON.parse(await readFile(statePath(item.encf, item.route), 'utf8')) as State;
    ensure(
      state.encf === item.encf && state.route === item.route && state.phase === item.phase &&
        /^[a-f0-9]{64}$/.test(state.xmlSha256) &&
        ['SUBMISSION_INTENT', 'UNCONFIRMED', 'PROCESSING', 'ACCEPTED',
          'ACCEPTED_CONDITIONALLY', 'REJECTED', 'REVIEW_REQUIRED'].includes(state.status) &&
        typeof state.updatedAt === 'string' && Number.isFinite(Date.parse(state.updatedAt)) &&
        (state.trackId === undefined || /^[A-Za-z0-9-]{1,200}$/.test(state.trackId)),
      'CERTIFICATION_EVIDENCE_STATE_INVALID',
    );
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function saveState(state: State): Promise<void> {
  const target = statePath(state.encf, state.route);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const body = JSON.stringify(state, null, 2) + '\n';
  await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
  await rename(temporary, target);
  const event = `${evidenceRoot}/events/${new Date().toISOString().replace(/[:.]/g, '-')}-${state.route}-${state.encf}-${randomUUID()}.json`;
  await writeFile(event, body, { mode: 0o600, flag: 'wx' });
}
function isAccepted(state: State | null): boolean {
  return state?.status === 'ACCEPTED';
}
function xmlPath(item: CertificationPlanItem): string {
  return item.route === 'RFCE'
    ? `${signedRoot}/rfce-signed/RFCE-${item.encf}.xml`
    : `${signedRoot}/ecf-signed/${item.encf}.xml`;
}
function safeCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,120}$/.test(message) ? message : 'CERTIFICATION_DELIVERY_FAILED';
}

let fiscal: Awaited<ReturnType<typeof createPkcs12FiscalSigning>> | undefined;
let seedSigner: Awaited<ReturnType<typeof createPkcs12XmlSigner>> | undefined;
let lockCreated = false;
let stage = 'INITIALIZATION';
try {
  validateRivnuCertificationPlan();
  stage = 'CONFIGURATION';
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    scope: typeof scope;
    expectedCertificateSha256: string;
  };
  ensure(JSON.stringify(config.scope) === JSON.stringify(scope), 'CERTIFICATION_SCOPE_INVALID');
  stage = 'SIGNED_REPORT';
  const reportText = await readFile(`${signedRoot}/signing-report.json`, 'utf8');
  ensure(digest(reportText) === expectedReportSha256, 'CERTIFICATION_SIGNING_REPORT_HASH_MISMATCH');
  const report = JSON.parse(reportText) as SigningReport;
  ensure(
    report.sourceSha256 === expectedSourceSha256 &&
      JSON.stringify(report.scope) === JSON.stringify(scope) &&
      report.certificateSha256 === config.expectedCertificateSha256 &&
      report.ecf.length === 25 && report.rfce.length === 4,
    'CERTIFICATION_SIGNING_REPORT_INVALID',
  );
  stage = 'EVIDENCE_INITIALIZATION';
  await mkdir(`${evidenceRoot}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${evidenceRoot}/events`, { recursive: true, mode: 0o700 });
  await mkdir(`${evidenceRoot}/.run-lock`, { mode: 0o700 });
  lockCreated = true;

  const apiPlan = RIVNU_CERTIFICATION_PLAN.filter(
    (item): item is CertificationPlanItem & { route: 'ECF' | 'RFCE' } => item.route !== 'PORTAL',
  );
  const states = new Map<string, State | null>();
  for (const item of apiPlan) {
    const state = await readState(item);
    const reportEntry = item.route === 'RFCE'
      ? report.rfce.find((entry) => entry.encf === item.encf)
      : report.ecf.find((entry) => entry.encf === item.encf);
    ensure(reportEntry && (!state || state.xmlSha256 === reportEntry.signedSha256),
      'CERTIFICATION_EVIDENCE_HASH_MISMATCH');
    states.set(`${item.route}:${item.encf}`, state);
  }
  const recoveryEncf = process.env.CERTIFICATION_RECOVER_LOCAL_PREFLIGHT;
  let recoveryComplete = false;
  if (recoveryEncf !== undefined) {
    ensure(recoveryEncf === 'E320000000006', 'CERTIFICATION_RECOVERY_TARGET_INVALID');
    const item = apiPlan.find((candidate) => candidate.route === 'ECF' && candidate.encf === recoveryEncf);
    const state = item ? states.get(`ECF:${recoveryEncf}`) : null;
    ensure(
      item && state?.status === 'SUBMISSION_INTENT' && state.trackId === undefined,
      'CERTIFICATION_LOCAL_PREFLIGHT_RECOVERY_NOT_APPLICABLE',
    );
    const recovered = `${evidenceRoot}/events/${new Date().toISOString().replace(/[:.]/g, '-')}-ECF-${recoveryEncf}-LOCAL_PREFLIGHT_FAILED_BEFORE_HTTP.json`;
    await rename(statePath(recoveryEncf, 'ECF'), recovered);
    console.log(`RIVNU_CERTIFICATION_LOCAL_PREFLIGHT_INTENT_ARCHIVED encf=${recoveryEncf}`);
    console.log('No DGII request was made and no accepted evidence was changed.');
    recoveryComplete = true;
  }
  if (!recoveryComplete) {
    const blocked = [...states.values()].find(
    (state) => state && ['SUBMISSION_INTENT', 'REJECTED', 'REVIEW_REQUIRED', 'UNCONFIRMED',
      'ACCEPTED_CONDITIONALLY'].includes(state.status),
    );
    if (blocked) {
      console.error(`CERTIFICATION_MANUAL_REVIEW_REQUIRED route=${blocked.route} encf=${blocked.encf} state=${blocked.status}`);
      process.exitCode = 2;
    } else {
      const pending = [...states.values()].find((state) => state?.status === 'PROCESSING');
      const next = apiPlan.find((item) => {
        if (states.get(`${item.route}:${item.encf}`)) return false;
        const earlier = apiPlan.filter((candidate) => candidate.phase < item.phase);
        return earlier.every((candidate) => isAccepted(states.get(`${candidate.route}:${candidate.encf}`) ?? null)) &&
          (item.dependsOn ?? []).every((encf) =>
            [...states.values()].some((state) => state?.encf === encf && isAccepted(state)),
          );
      });
      const selected = pending
        ? apiPlan.find((item) => item.encf === pending.encf && item.route === pending.route)
        : next;
      if (!selected) {
        const complete = [...states.values()].every(isAccepted);
        console.log(complete
          ? 'RIVNU_CERTIFICATION_API_SET_ACCEPTED_PORTAL_E32_UPLOAD_READY'
          : 'RIVNU_CERTIFICATION_WAITING_FOR_PHASE_PREREQUISITES');
      } else {
        const xml = await readFile(xmlPath(selected), 'utf8');
        const reportEntry = selected.route === 'RFCE'
          ? report.rfce.find((entry) => entry.encf === selected.encf)
          : report.ecf.find((entry) => entry.encf === selected.encf);
        ensure(reportEntry?.signedSha256 === digest(xml), 'CERTIFICATION_SIGNED_XML_HASH_MISMATCH');
        const signerConfig = {
          scope,
          p12Path: '/run/secrets/signing/certificate.p12',
          passwordPath: '/run/secrets/signing/password',
          rootCertificatePath: '/run/trust/digifirma/root.crt',
          subordinateCertificatePath: '/run/trust/digifirma/subordinate.crt',
          crlPath: '/run/trust/digifirma/subordinate.crl.pem',
          expectedCertificateSha256: config.expectedCertificateSha256,
          workRoot: '/run/signing-work',
        } as const;
        stage = 'SIGNER_INITIALIZATION';
        fiscal = await createPkcs12FiscalSigning(signerConfig);
        stage = 'LOCAL_DOCUMENT_VERIFICATION';
        await fiscal.verify(scope, selected.route, xml);
        seedSigner = await createPkcs12XmlSigner({ ...signerConfig, workRoot: '/run/seed-signing-work' });
        const client = createDgiiClient(
          scope,
          createDgiiHttpsTransport(scope, true),
          async (requested, kind, signedXml) => {
            if (kind !== 'SEMILLA') return fiscal!.verify(requested, kind, signedXml);
            await seedSigner!.verify(signedXml);
            return { sha256: digest(signedXml), actorRnc: scope.issuerRnc };
          },
        );
        stage = 'AUTHENTICATION';
        const seed = await client.seed();
        await client.authenticate(await seedSigner.sign(seed));
        const gateway = createDeliveryGateway(scope, client, fiscal.verify);
        const prior = states.get(`${selected.route}:${selected.encf}`) ?? null;
        const claim: DeliveryClaim = {
          documentId: String(apiPlan.indexOf(selected) + 1),
          encf: selected.encf,
          claimToken: randomUUID(),
          action: prior ? 'RECONCILE' : 'SEND',
          route: selected.route,
          xml,
          sha256: digest(xml),
          trackId: prior?.trackId ?? null,
          scope,
        };
        if (!prior) {
          await saveState({
            encf: selected.encf, route: selected.route, phase: selected.phase,
            xmlSha256: claim.sha256, status: 'SUBMISSION_INTENT', updatedAt: new Date().toISOString(),
          });
        }
        stage = prior ? 'RECONCILIATION' : 'SUBMISSION';
        const observation = prior ? await gateway.reconcile(claim) : await gateway.send(claim);
        const state: State = {
          encf: selected.encf, route: selected.route, phase: selected.phase,
          xmlSha256: claim.sha256, status: observation.outcome,
          ...(observation.trackId ? { trackId: observation.trackId } : {}),
          updatedAt: new Date().toISOString(),
        };
        await saveState(state);
        console.log(
          `RIVNU_CERTIFICATION_STEP_RECORDED route=${state.route} encf=${state.encf} state=${state.status}`,
        );
        console.log('Run the same command again to reconcile or advance exactly one document.');
      }
    }
  }
} catch (error) {
  console.error(`RIVNU_CERTIFICATION_DELIVERY_STOPPED stage=${stage} code=${safeCode(error)}`);
  process.exitCode = 1;
} finally {
  await seedSigner?.close();
  await fiscal?.close();
  if (lockCreated) {
    try { await (await import('node:fs/promises')).rmdir(`${evidenceRoot}/.run-lock`); } catch {}
  }
}
