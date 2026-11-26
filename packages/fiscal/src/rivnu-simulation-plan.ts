import { parseEncf } from './encf.ts';

export type SimulationRoute = 'ECF' | 'RFCE' | 'PORTAL';
export type SimulationPlanItem = Readonly<{
  phase: 1 | 2 | 3 | 4;
  encf: string;
  route: SimulationRoute;
  dependsOn?: readonly string[];
}>;

const encf = (type: number, sequence: number) => `E${type}${String(sequence).padStart(10, '0')}`;

export const RIVNU_SIMULATION_PLAN: readonly SimulationPlanItem[] = Object.freeze([
  ...[300001, 300002, 300003, 300004].map((sequence) => ({
    phase: 1 as const, encf: encf(31, sequence), route: 'ECF' as const,
  })),
  ...[300001, 300002].map((sequence) => ({
    phase: 1 as const, encf: encf(32, sequence), route: 'ECF' as const,
  })),
  ...([41, 43, 44, 45, 46, 47] as const).flatMap((type) =>
    [300001, 300002].map((sequence) => ({
      phase: 1 as const, encf: encf(type, sequence), route: 'ECF' as const,
    })),
  ),
  {
    phase: 2, encf: encf(33, 300001), route: 'ECF', dependsOn: [encf(31, 300001)],
  },
  {
    phase: 2, encf: encf(34, 300001), route: 'ECF', dependsOn: [encf(41, 300001)],
  },
  {
    phase: 2, encf: encf(34, 300002), route: 'ECF', dependsOn: [encf(41, 300002)],
  },
  ...[300003, 300004, 300005, 300006].map((sequence) => ({
    phase: 3 as const, encf: encf(32, sequence), route: 'RFCE' as const,
  })),
  ...[300003, 300004, 300005, 300006].map((sequence) => ({
    phase: 4 as const,
    encf: encf(32, sequence),
    route: 'PORTAL' as const,
    dependsOn: [encf(32, sequence)],
  })),
]);

export function validateRivnuSimulationPlan(): void {
  const api = RIVNU_SIMULATION_PLAN.filter((item) => item.route !== 'PORTAL');
  const portal = RIVNU_SIMULATION_PLAN.filter((item) => item.route === 'PORTAL');
  if (
    api.length !== 25 ||
    new Set(api.map((item) => `${item.route}:${item.encf}`)).size !== 25 ||
    portal.length !== 4
  ) throw Error('SIMULATION_PLAN_CARDINALITY_INVALID');
  for (const item of RIVNU_SIMULATION_PLAN) {
    const parsed = parseEncf(item.encf);
    if (
      (item.route === 'ECF' && item.phase > 2) ||
      (item.route === 'RFCE' && (item.phase !== 3 || parsed.type !== 32)) ||
      (item.route === 'PORTAL' && (item.phase !== 4 || parsed.type !== 32))
    ) throw Error('SIMULATION_PLAN_ROUTE_INVALID');
    for (const dependency of item.dependsOn ?? []) {
      if (!RIVNU_SIMULATION_PLAN.some(
        (candidate) => candidate.encf === dependency && candidate.phase < item.phase,
      )) throw Error('SIMULATION_PLAN_DEPENDENCY_INVALID');
    }
  }
}
