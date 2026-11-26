import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { createPkcs12FiscalSigning } from './pkcs12-fiscal-signing.ts';
import { createPkcs12XmlSigner } from './pkcs12-signer.ts';
import { createDgiiClient, createDgiiHttpsTransport } from './dgii-client.ts';
import { createDeliveryGateway } from './delivery-gateway.ts';
import type { DeliveryClaim, DeliveryOutcome } from './delivery-worker.ts';
import {
  RIVNU_SIMULATION_PLAN,
  validateRivnuSimulationPlan,
  type SimulationPlanItem,
} from './rivnu-simulation-plan.ts';

const signedRoot = '/signed';
const evidenceRoot = '/evidence';
const configPath = '/run/config/fiscal-signer.json';
const scope = Object.freeze({
  tenantId: 'cmt397emm0002nm0ogb50l2q6',
  issuerRnc: '40220429126',
  environment: 'certification' as const,
});
const expectedManifestSha256 = 'dd7425eb1ed92ef9ca3354a65f31bb19588c0dcb5ac0eaad67ef59d08e159370';
const expectedReportSha256 = '366ad3f61a6a6062c3ce305be335536ba0288e90505d0200bae46cad27a36949';
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
type ReportEntry = {
  phase: number;
  route: 'ECF' | 'RFCE';
  type: number;
  encf: string;
  signedSha256: string;
  total: string;
};
type SigningReport = {
  profile: string;
  manifestSha256: string;
  scope: typeof scope;
  certificateSha256: string;
  ecf: ReportEntry[];
  rfce: { phase: number; encf: string; signedSha256: string; securityCode: string }[];
  portalUploads: string[];
};

const statePath = (item: { encf: string; route: string }) =>
  `${evidenceRoot}/state/${item.route}-${item.encf}.json`;

async function readState(item: SimulationPlanItem): Promise<State | null> {
  if (item.route === 'PORTAL') return null;
  try {
    const state = JSON.parse(await readFile(statePath(item), 'utf8')) as State;
    ensure(
      state.encf === item.encf &&
        state.route === item.route &&
        state.phase === item.phase &&
        /^[a-f0-9]{64}$/.test(state.xmlSha256) &&
        ['SUBMISSION_INTENT', 'UNCONFIRMED', 'PROCESSING', 'ACCEPTED',
          'ACCEPTED_CONDITIONALLY', 'REJECTED', 'REVIEW_REQUIRED'].includes(state.status) &&
        Number.isFinite(Date.parse(state.updatedAt)) &&
        (state.trackId === undefined || /^[A-Za-z0-9-]{1,200}$/.test(state.trackId)),
      'SIMULATION_EVIDENCE_STATE_INVALID',
    );
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function saveState(state: State): Promise<void> {
  const body = JSON.stringify(state, null, 2) + '\n';
  const target = statePath(state);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
  await rename(temporary, target);
  const event = `${evidenceRoot}/events/${new Date().toISOString().replace(/[:.]/g, '-')}-${state.route}-${state.encf}-${randomUUID()}.json`;
  await writeFile(event, body, { mode: 0o600, flag: 'wx' });
}

const accepted = (state: State | null) => state?.status === 'ACCEPTED';
const xmlPath = (item: SimulationPlanItem) => item.route === 'RFCE'
  ? `${signedRoot}/rfce-signed/RFCE-${item.encf}.xml`
  : `${signedRoot}/ecf-signed/${item.encf}.xml`;
const safeCode = (error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,120}$/.test(message) ? message : 'SIMULATION_DELIVERY_FAILED';
};

let fiscal: Awaited<ReturnType<typeof createPkcs12FiscalSigning>> | undefined;
let seedSigner: Awaited<ReturnType<typeof createPkcs12XmlSigner>> | undefined;
let lockCreated = false;
let stage = 'INITIALIZATION';
try {
  validateRivnuSimulationPlan();
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    scope: typeof scope;
    expectedCertificateSha256: string;
  };
  ensure(JSON.stringify(config.scope) === JSON.stringify(scope), 'SIMULATION_SCOPE_INVALID');
  stage = 'SIGNED_REPORT';
  const reportText = await readFile(`${signedRoot}/signing-report.json`, 'utf8');
  ensure(digest(reportText) === expectedReportSha256, 'SIMULATION_REPORT_HASH_MISMATCH');
  const report = JSON.parse(reportText) as SigningReport;
  ensure(
    report.profile === 'RIVNU_SIMULATION_20261019_ATTEMPT3_V1' &&
      report.manifestSha256 === expectedManifestSha256 &&
      JSON.stringify(report.scope) === JSON.stringify(scope) &&
      report.certificateSha256 === config.expectedCertificateSha256 &&
      report.ecf.length === 25 &&
      report.rfce.length === 4 &&
      report.portalUploads.length === 4,
    'SIMULATION_REPORT_INVALID',
  );
  stage = 'EVIDENCE_INITIALIZATION';
  await mkdir(`${evidenceRoot}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${evidenceRoot}/events`, { recursive: true, mode: 0o700 });
  await mkdir(`${evidenceRoot}/.run-lock`, { mode: 0o700 });
  lockCreated = true;

  const apiPlan = RIVNU_SIMULATION_PLAN.filter(
    (item): item is SimulationPlanItem & { route: 'ECF' | 'RFCE' } => item.route !== 'PORTAL',
  );
  const states = new Map<string, State | null>();
  for (const item of apiPlan) {
    const state = await readState(item);
    const entry = item.route === 'RFCE'
      ? report.rfce.find((candidate) => candidate.encf === item.encf)
      : report.ecf.find((candidate) => candidate.encf === item.encf);
    ensure(entry && (!state || state.xmlSha256 === entry.signedSha256),
      'SIMULATION_EVIDENCE_HASH_MISMATCH');
    states.set(`${item.route}:${item.encf}`, state);
  }
  const blocked = [...states.values()].find((state) => state && [
    'SUBMISSION_INTENT', 'UNCONFIRMED', 'ACCEPTED_CONDITIONALLY', 'REJECTED', 'REVIEW_REQUIRED',
  ].includes(state.status));
  if (blocked) {
    console.error(`SIMULATION_MANUAL_REVIEW_REQUIRED route=${blocked.route} encf=${blocked.encf} state=${blocked.status}`);
    process.exitCode = 2;
  } else {
    const pending = [...states.values()].find((state) => state?.status === 'PROCESSING');
    const next = apiPlan.find((item) => {
      if (states.get(`${item.route}:${item.encf}`)) return false;
      return apiPlan
        .filter((candidate) => candidate.phase < item.phase)
        .every((candidate) => accepted(states.get(`${candidate.route}:${candidate.encf}`) ?? null)) &&
        (item.dependsOn ?? []).every((dependency) =>
          [...states.values()].some((state) => state?.encf === dependency && accepted(state)),
        );
    });
    const selected = pending
      ? apiPlan.find((item) => item.encf === pending.encf && item.route === pending.route)
      : next;
    if (!selected) {
      console.log([...states.values()].every(accepted)
        ? 'RIVNU_SIMULATION_API_SET_ACCEPTED_PORTAL_E32_UPLOAD_READY'
        : 'RIVNU_SIMULATION_WAITING_FOR_PHASE_PREREQUISITES');
    } else {
      const xml = await readFile(xmlPath(selected), 'utf8');
      const entry = selected.route === 'RFCE'
        ? report.rfce.find((candidate) => candidate.encf === selected.encf)
        : report.ecf.find((candidate) => candidate.encf === selected.encf);
      ensure(entry?.signedSha256 === digest(xml), 'SIMULATION_SIGNED_XML_HASH_MISMATCH');
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
      if (!prior) await saveState({
        encf: selected.encf,
        route: selected.route,
        phase: selected.phase,
        xmlSha256: claim.sha256,
        status: 'SUBMISSION_INTENT',
        updatedAt: new Date().toISOString(),
      });
      stage = prior ? 'RECONCILIATION' : 'SUBMISSION';
      const observation = prior ? await gateway.reconcile(claim) : await gateway.send(claim);
      const state: State = {
        encf: selected.encf,
        route: selected.route,
        phase: selected.phase,
        xmlSha256: claim.sha256,
        status: observation.outcome,
        ...(observation.trackId ? { trackId: observation.trackId } : {}),
        updatedAt: new Date().toISOString(),
      };
      await saveState(state);
      console.log(`RIVNU_SIMULATION_STEP_RECORDED route=${state.route} encf=${state.encf} state=${state.status}`);
      console.log('Run the same command again to reconcile or advance exactly one document.');
    }
  }
} catch (error) {
  console.error(`RIVNU_SIMULATION_DELIVERY_STOPPED stage=${stage} code=${safeCode(error)}`);
  process.exitCode = 1;
} finally {
  await seedSigner?.close();
  await fiscal?.close();
  if (lockCreated) {
    try { await rmdir(`${evidenceRoot}/.run-lock`); } catch {}
  }
}
