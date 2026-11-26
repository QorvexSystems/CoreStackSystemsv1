import assert from 'node:assert/strict';
import test from 'node:test';
import {
  certificationHash,
  runCertificationCycle,
  validateCertificationPlan,
  type CertificationAutomationAdapter,
  type CertificationDocumentState,
  type CertificationPlan,
} from '../src/certification-automation.ts';

const scope = {
  tenantId: 'synthetic-certification',
  issuerRnc: '101010632',
  environment: 'certification' as const,
};
const xml = '<synthetic/>';
const fingerprint = 'a'.repeat(64);
const plan: CertificationPlan = {
  version: 1,
  caseId: 'synthetic-case',
  scope,
  stepNumber: 2,
  sourceSha256: 'b'.repeat(64),
  certificateSha256: fingerprint,
  documents: [
    {
      id: 'first',
      encf: 'E310000000001',
      route: 'ECF',
      file: 'first.xml',
      sha256: certificationHash(xml),
      dependsOn: [],
    },
    {
      id: 'second',
      encf: 'E340000000001',
      route: 'ECF',
      file: 'second.xml',
      sha256: certificationHash(xml),
      dependsOn: ['first'],
    },
  ],
};
const expected = { caseId: plan.caseId, scope, stepNumber: 2, certificateSha256: fingerprint };
function fixture() {
  const states = new Map<string, CertificationDocumentState>();
  let posts = 0;
  let polls = 0;
  const store = {
    read: async (id: string) => structuredClone(states.get(id) ?? null),
    write: async (state: CertificationDocumentState) => {
      states.set(state.id, structuredClone(state));
    },
    reserve: async () => undefined,
  };
  const adapter: CertificationAutomationAdapter = {
    readInput: async () => xml,
    sign: async () => '<signed/>',
    verify: async () => undefined,
    send: async (doc) => {
      posts++;
      assert.equal(states.get(doc.id)?.status, 'SUBMISSION_INTENT');
      return { status: 'PROCESSING', trackId: 'synthetic-track' };
    },
    reconcile: async () => {
      polls++;
      return { status: 'ACCEPTED' };
    },
  };
  return { states, store, adapter, posts: () => posts, polls: () => polls };
}
test('certification is strictly scoped, rejects production, path traversal and dependency cycles', () => {
  validateCertificationPlan(plan, expected);
  for (const modified of [
    { ...plan, scope: { ...scope, environment: 'production' } },
    { ...plan, scope: { ...scope, tenantId: 'other' } },
    { ...plan, certificateSha256: 'c'.repeat(64) },
    { ...plan, documents: [{ ...plan.documents[0]!, file: '../secret.xml' }] },
    { ...plan, documents: [{ ...plan.documents[0]!, dependsOn: ['first'] }] },
  ]) {
    assert.throws(() => validateCertificationPlan(modified as CertificationPlan, expected));
  }
});
test('one POST per document; dependencies reconcile before proceeding; final report is deterministic', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) {
    assert.equal(
      (await runCertificationCycle(plan, fingerprint, f.adapter, f.store)).status,
      'PROCESSING',
    );
    if (i === 0) assert.equal(f.states.has('second'), false);
  }
  const result = await runCertificationCycle(plan, fingerprint, f.adapter, f.store);
  assert.equal(result.status, 'SUCCEEDED');
  assert.match(result.reportSha256!, /^[a-f0-9]{64}$/);
  assert.deepEqual(result, await runCertificationCycle(plan, fingerprint, f.adapter, f.store));
  assert.equal(f.posts(), 2);
  assert.equal(f.polls(), 2);
});
test('ambiguous POST is never replayed after restart', async () => {
  const f = fixture();
  let posts = 0;
  f.adapter.send = async () => {
    posts++;
    throw Error('HTTP_DISCONNECTED');
  };
  await assert.rejects(runCertificationCycle(plan, fingerprint, f.adapter, f.store));
  assert.equal(f.states.get('first')?.status, 'SUBMISSION_INTENT');
  assert.deepEqual(await runCertificationCycle(plan, fingerprint, f.adapter, f.store), {
    status: 'FAILED',
    code: 'CERTIFICATION_SUBMISSION_UNCONFIRMED',
  });
  assert.equal(posts, 1);
});
test('input changes, persisted XML tampering and changed plans fail before another POST', async () => {
  const f = fixture();
  f.adapter.readInput = async () => 'changed';
  await assert.rejects(
    runCertificationCycle(plan, fingerprint, f.adapter, f.store),
    /HASH_MISMATCH/,
  );
  assert.equal(f.posts(), 0);
  f.adapter.readInput = async () => xml;
  await runCertificationCycle(plan, fingerprint, f.adapter, f.store);
  f.states.get('first')!.signedXml += 'tampered';
  await assert.rejects(
    runCertificationCycle(plan, fingerprint, f.adapter, f.store),
    /BINDING_INVALID/,
  );
  assert.equal(f.posts(), 1);
});
test('rejection stops all later documents', async () => {
  const f = fixture();
  f.adapter.send = async () => ({ status: 'REJECTED' });
  assert.equal(
    (await runCertificationCycle(plan, fingerprint, f.adapter, f.store)).status,
    'FAILED',
  );
  assert.equal(
    (await runCertificationCycle(plan, fingerprint, f.adapter, f.store)).status,
    'FAILED',
  );
  assert.equal(f.states.has('second'), false);
});
