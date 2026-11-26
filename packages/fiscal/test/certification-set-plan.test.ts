import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RIVNU_CERTIFICATION_PLAN,
  validateRivnuCertificationPlan,
} from '../src/certification-set-plan.ts';

test('RIVNU certification plan separates API and portal channels in DGII order', () => {
  assert.doesNotThrow(validateRivnuCertificationPlan);
  assert.equal(RIVNU_CERTIFICATION_PLAN.filter((item) => item.phase === 1).length, 18);
  assert.equal(RIVNU_CERTIFICATION_PLAN.filter((item) => item.phase === 2).length, 3);
  assert.equal(RIVNU_CERTIFICATION_PLAN.filter((item) => item.phase === 3).length, 4);
  assert.equal(RIVNU_CERTIFICATION_PLAN.filter((item) => item.phase === 4).length, 4);
  assert.ok(
    RIVNU_CERTIFICATION_PLAN.filter((item) => item.phase === 4).every(
      (item) => item.route === 'PORTAL',
    ),
  );
});

test('credit/debit notes are gated by acceptance of their referenced originals', () => {
  const dependencies = Object.fromEntries(
    RIVNU_CERTIFICATION_PLAN.filter((item) => item.phase === 2).map((item) => [
      item.encf,
      item.dependsOn,
    ]),
  );
  assert.deepEqual(dependencies, {
    E330000000001: ['E320000000006'],
    E340000000016: ['E410000000010'],
    E340000000015: ['E410000000001'],
  });
});

