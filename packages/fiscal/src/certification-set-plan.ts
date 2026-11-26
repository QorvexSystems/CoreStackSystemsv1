import { parseEncf } from './encf.ts';

export type CertificationRoute = 'ECF' | 'RFCE' | 'PORTAL';
export type CertificationPlanItem = Readonly<{
  phase: 1 | 2 | 3 | 4;
  encf: string;
  route: CertificationRoute;
  dependsOn?: readonly string[];
}>;

/** DGII certification order for RIVNU's assigned 2026-10-19 data set.
 * Phase 4 is a portal upload and is deliberately never transmitted by the API.
 */
export const RIVNU_CERTIFICATION_PLAN: readonly CertificationPlanItem[] = Object.freeze([
  ...[
    'E310000000001', 'E310000000004', 'E310000000005', 'E310000000011',
    'E320000000002', 'E320000000006',
    'E410000000001', 'E410000000010',
    'E430000000008', 'E430000000011',
    'E440000000009', 'E440000000010',
    'E450000000002', 'E450000000008',
    'E460000000008', 'E460000000009',
    'E470000000009', 'E470000000011',
  ].map((encf) => ({ phase: 1 as const, encf, route: 'ECF' as const })),
  { phase: 2, encf: 'E330000000001', route: 'ECF', dependsOn: ['E320000000006'] },
  { phase: 2, encf: 'E340000000016', route: 'ECF', dependsOn: ['E410000000010'] },
  { phase: 2, encf: 'E340000000015', route: 'ECF', dependsOn: ['E410000000001'] },
  ...['E320000000011', 'E320000000012', 'E320000000013', 'E320000000014'].map(
    (encf) => ({ phase: 3 as const, encf, route: 'RFCE' as const }),
  ),
  ...['E320000000011', 'E320000000012', 'E320000000013', 'E320000000014'].map(
    (encf) => ({ phase: 4 as const, encf, route: 'PORTAL' as const, dependsOn: [encf] }),
  ),
]);

export function validateRivnuCertificationPlan(): void {
  const apiItems = RIVNU_CERTIFICATION_PLAN.filter((item) => item.route !== 'PORTAL');
  const portalItems = RIVNU_CERTIFICATION_PLAN.filter((item) => item.route === 'PORTAL');
  const apiKeys = new Set(apiItems.map((item) => `${item.route}:${item.encf}`));
  if (apiItems.length !== 25 || apiKeys.size !== 25 || portalItems.length !== 4)
    throw Error('CERTIFICATION_PLAN_CARDINALITY_INVALID');
  for (const item of RIVNU_CERTIFICATION_PLAN) {
    const parsed = parseEncf(item.encf);
    if (
      (item.route === 'RFCE' && (item.phase !== 3 || parsed.type !== 32)) ||
      (item.route === 'PORTAL' && (item.phase !== 4 || parsed.type !== 32)) ||
      (item.route === 'ECF' && item.phase > 2)
    ) throw Error('CERTIFICATION_PLAN_ROUTE_INVALID');
    for (const dependency of item.dependsOn ?? []) {
      const previous = RIVNU_CERTIFICATION_PLAN.find(
        (candidate) => candidate.encf === dependency && candidate.phase < item.phase,
      );
      if (!previous) throw Error('CERTIFICATION_PLAN_DEPENDENCY_INVALID');
    }
  }
}

