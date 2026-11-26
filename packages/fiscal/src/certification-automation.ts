import { createHash } from 'node:crypto';
import { assertScope, scopeKey, type FiscalScope } from './catalog.ts';
import { parseEncf } from './encf.ts';

export type CertificationDocument = Readonly<{
  id: string;
  encf: string;
  route: 'ECF' | 'RFCE' | 'ACECF';
  file: string;
  sha256: string;
  rfceTemplateSha256?: string;
  dependsOn: readonly string[];
}>;
export type CertificationPlan = Readonly<{
  version: 1;
  caseId: string;
  scope: FiscalScope;
  stepNumber: 2 | 3 | 4;
  sourceSha256: string;
  certificateSha256: string;
  documents: readonly CertificationDocument[];
}>;
export type CertificationDocumentState = {
  id: string;
  planSha256: string;
  inputSha256: string;
  signedXml: string;
  signedSha256: string;
  status:
    | 'PREPARED'
    | 'SUBMISSION_INTENT'
    | 'PROCESSING'
    | 'ACCEPTED'
    | 'REJECTED'
    | 'REVIEW_REQUIRED';
  trackId?: string;
};
export type CertificationAutomationResult = {
  status: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  code: string;
  reportSha256?: string;
};
export type CertificationAutomationAdapter = {
  readInput(document: CertificationDocument): Promise<string>;
  sign(document: CertificationDocument, xml: string): Promise<string>;
  verify(document: CertificationDocument, signedXml: string): Promise<void>;
  send(
    document: CertificationDocument,
    state: CertificationDocumentState,
  ): Promise<{
    status: CertificationDocumentState['status'];
    trackId?: string;
  }>;
  reconcile(
    document: CertificationDocument,
    state: CertificationDocumentState,
  ): Promise<{
    status: CertificationDocumentState['status'];
    trackId?: string;
  }>;
};
export type CertificationAutomationStore = {
  read(id: string): Promise<CertificationDocumentState | null>;
  /** Must persist/fsync the intent BEFORE returning; an interrupted POST is never replayed. */
  write(state: CertificationDocumentState): Promise<void>;
  reserve(document: CertificationDocument, planSha256: string): Promise<void>;
};
export const certificationHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const ensure: (value: unknown, code: string) => asserts value = (value, code) => {
  if (!value) throw Error(code);
};

export function validateCertificationPlan(
  plan: CertificationPlan,
  expected: {
    caseId: string;
    scope: FiscalScope;
    stepNumber: number;
    certificateSha256: string;
  },
) {
  assertScope(plan.scope);
  ensure(
    plan.version === 1 &&
      plan.scope.environment === 'certification' &&
      expected.scope.environment === 'certification' &&
      scopeKey(plan.scope) === scopeKey(expected.scope) &&
      plan.caseId === expected.caseId &&
      plan.stepNumber === expected.stepNumber &&
      [2, 3, 4].includes(plan.stepNumber) &&
      /^[a-f0-9]{64}$/.test(plan.certificateSha256) &&
      plan.certificateSha256 === expected.certificateSha256 &&
      /^[a-f0-9]{64}$/.test(plan.sourceSha256),
    'CERTIFICATION_PLAN_SCOPE_INVALID',
  );
  ensure(
    Array.isArray(plan.documents) && plan.documents.length > 0 && plan.documents.length <= 1000,
    'CERTIFICATION_PLAN_SIZE_INVALID',
  );
  const seen = new Set<string>();
  const numbers = new Set<string>();
  for (const item of plan.documents) {
    ensure(
      /^[A-Za-z0-9_-]{1,80}$/.test(item.id) &&
        !seen.has(item.id) &&
        /^E(?:31|32|33|34|41|43|44|45|46|47)\d{10}$/.test(item.encf) &&
        /^(?!.*\.\.)[A-Za-z0-9_-]+\.xml$/.test(item.file) &&
        /^[a-f0-9]{64}$/.test(item.sha256) &&
        (plan.stepNumber === 3 ? item.route === 'ACECF' : ['ECF', 'RFCE'].includes(item.route)) &&
        (item.route !== 'RFCE' || item.encf.startsWith('E32')) &&
        (item.route !== 'RFCE' || /^[a-f0-9]{64}$/.test(item.rfceTemplateSha256 ?? '')) &&
        Array.isArray(item.dependsOn) &&
        item.dependsOn.every((id: unknown) => typeof id === 'string' && seen.has(id)) &&
        !numbers.has(`${item.route}:${item.encf}`),
      'CERTIFICATION_DOCUMENT_INVALID',
    );
    seen.add(item.id);
    numbers.add(`${item.route}:${item.encf}`);
    const parsed = parseEncf(item.encf);
    ensure(
      plan.stepNumber !== 4 || BigInt(parsed.sequence) <= 10_000_000n,
      'CERTIFICATION_SIMULATION_SEQUENCE_OUT_OF_RANGE',
    );
  }
}

/** One document or reconciliation per cycle. No shell, LLM, production endpoint or automatic POST replay. */
export async function runCertificationCycle(
  plan: CertificationPlan,
  planSha256: string,
  adapter: CertificationAutomationAdapter,
  store: CertificationAutomationStore,
): Promise<CertificationAutomationResult> {
  const states = new Map<string, CertificationDocumentState>();
  for (const document of plan.documents) {
    const state = await store.read(document.id);
    if (!state) continue;
    ensure(
      state.id === document.id &&
        state.planSha256 === planSha256 &&
        state.inputSha256 === document.sha256 &&
        certificationHash(state.signedXml) === state.signedSha256 &&
        [
          'PREPARED',
          'SUBMISSION_INTENT',
          'PROCESSING',
          'ACCEPTED',
          'REJECTED',
          'REVIEW_REQUIRED',
        ].includes(state.status),
      'CERTIFICATION_STATE_BINDING_INVALID',
    );
    states.set(document.id, state);
  }
  const blocked = [...states.values()].find((state) =>
    ['SUBMISSION_INTENT', 'REJECTED', 'REVIEW_REQUIRED'].includes(state.status),
  );
  if (blocked)
    return {
      status: 'FAILED',
      code:
        blocked.status === 'SUBMISSION_INTENT'
          ? 'CERTIFICATION_SUBMISSION_UNCONFIRMED'
          : 'CERTIFICATION_DOCUMENT_REQUIRES_REVIEW',
    };
  const selected =
    plan.documents.find((document) => states.get(document.id)?.status === 'PROCESSING') ??
    plan.documents.find(
      (document) =>
        states.get(document.id)?.status !== 'ACCEPTED' &&
        document.dependsOn.every((id) => states.get(id)?.status === 'ACCEPTED'),
    );
  if (!selected) {
    ensure(
      states.size === plan.documents.length &&
        [...states.values()].every((state) => state.status === 'ACCEPTED'),
      'CERTIFICATION_DEPENDENCIES_UNSATISFIED',
    );
    return {
      status: 'SUCCEEDED',
      code: 'CERTIFICATION_API_SET_ACCEPTED',
      reportSha256: certificationHash(
        JSON.stringify(
          plan.documents.map((document) => {
            const state = states.get(document.id)!;
            return {
              id: document.id,
              encf: document.encf,
              route: document.route,
              signedSha256: state.signedSha256,
              status: state.status,
              trackId: state.trackId ?? null,
            };
          }),
        ),
      ),
    };
  }
  let state = states.get(selected.id);
  if (!state) {
    const xml = await adapter.readInput(selected);
    ensure(certificationHash(xml) === selected.sha256, 'CERTIFICATION_INPUT_HASH_MISMATCH');
    await store.reserve(selected, planSha256);
    const signedXml = await adapter.sign(selected, xml);
    await adapter.verify(selected, signedXml);
    state = {
      id: selected.id,
      planSha256,
      inputSha256: selected.sha256,
      signedXml,
      signedSha256: certificationHash(signedXml),
      status: 'PREPARED',
    };
    await store.write(state);
  }
  await adapter.verify(selected, state.signedXml);
  if (state.status === 'PREPARED') {
    state = { ...state, status: 'SUBMISSION_INTENT' };
    await store.write(state);
    const observation = await adapter.send(selected, state);
    ensure(
      ['PROCESSING', 'ACCEPTED', 'REJECTED', 'REVIEW_REQUIRED'].includes(observation.status),
      'CERTIFICATION_RESPONSE_UNCONFIRMED',
    );
    state = { ...state, ...observation };
  } else {
    const observation = await adapter.reconcile(selected, state);
    ensure(
      ['PROCESSING', 'ACCEPTED', 'REJECTED', 'REVIEW_REQUIRED'].includes(observation.status),
      'CERTIFICATION_RESPONSE_UNCONFIRMED',
    );
    state = { ...state, ...observation };
  }
  await store.write(state);
  return ['REJECTED', 'REVIEW_REQUIRED'].includes(state.status)
    ? { status: 'FAILED', code: 'CERTIFICATION_DOCUMENT_REQUIRES_REVIEW' }
    : { status: 'PROCESSING', code: 'CERTIFICATION_DOCUMENT_RECORDED' };
}
