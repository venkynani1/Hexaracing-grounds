import type { ScoringCategory } from './enums';

/** Category caps (SPEC Part 16). Sum must equal MAX_SCORE. */
export const SCORING_CAPS: Record<ScoringCategory, number> = {
  DRIVING: 250,
  CODING: 200,
  DECEPTION: 150,
  CAPTAIN_STRATEGY: 100,
  TEAM_ASSESSMENTS: 150,
  FUEL_MANAGEMENT: 50,
  HEXAWARE_GATE: 100,
};

export const MAX_SCORE = 1000;

export interface ScoringEventLike {
  category: ScoringCategory;
  points: number;
}

export type CategoryTotals = Record<ScoringCategory, number>;

/**
 * Championship weighting (event brief §13, configurable): each group contributes weight × (capped group points /
 * group maximum). Raw category points stay in the ledger and in `byCategory`; only the headline total is weighted.
 * Weights sum to MAX_SCORE so the scale is unchanged (0–1000).
 */
export const SCORING_WEIGHTS: { id: string; label: string; weight: number; categories: ScoringCategory[] }[] = [
  { id: 'missions', label: 'Cooperative mission completion', weight: 400, categories: ['TEAM_ASSESSMENTS', 'FUEL_MANAGEMENT'] },
  { id: 'puzzles', label: 'Puzzle accuracy and efficiency', weight: 250, categories: ['CODING', 'DECEPTION'] },
  { id: 'driving', label: 'Driving and navigation', weight: 150, categories: ['DRIVING'] },
  { id: 'rival', label: 'Rival strategy', weight: 100, categories: ['CAPTAIN_STRATEGY'] },
  { id: 'gate', label: 'Final gate assessment', weight: 100, categories: ['HEXAWARE_GATE'] },
];

/** Derive capped per-category totals and the weighted total from scoring events. Never stored, only derived. */
export function deriveTotals(events: readonly ScoringEventLike[]): { byCategory: CategoryTotals; total: number; byGroup: Record<string, number> } {
  const byCategory = Object.fromEntries(Object.keys(SCORING_CAPS).map((k) => [k, 0])) as CategoryTotals;
  for (const e of events) byCategory[e.category] += e.points;
  for (const k of Object.keys(byCategory) as ScoringCategory[]) byCategory[k] = Math.max(0, Math.min(SCORING_CAPS[k], byCategory[k]));
  const byGroup: Record<string, number> = {};
  let total = 0;
  for (const g of SCORING_WEIGHTS) {
    const max = g.categories.reduce((a, c) => a + SCORING_CAPS[c], 0);
    const got = g.categories.reduce((a, c) => a + byCategory[c], 0);
    const v = max ? (g.weight * got) / max : 0;
    byGroup[g.id] = Math.round(v * 10) / 10;
    total += v;
  }
  return { byCategory, total: Math.round(total), byGroup };
}

export interface RankableTeam {
  teamId: string;
  total: number;
  byCategory: CategoryTotals;
  /** Server timestamp (ms) of final gate submission; null if none. */
  finalGateSubmittedAt: number | null;
  /** Predeclared deterministic hash of (seed, teamId), see tieBreakHash. */
  tieHash: string;
}

/**
 * Ranking order (SPEC Part 16 + DESIGN §8):
 * total desc → team assessments → coding → driving → earliest final gate submission → tieHash asc.
 */
export function compareTeams(a: RankableTeam, b: RankableTeam): number {
  return (
    b.total - a.total ||
    b.byCategory.TEAM_ASSESSMENTS - a.byCategory.TEAM_ASSESSMENTS ||
    b.byCategory.CODING - a.byCategory.CODING ||
    b.byCategory.DRIVING - a.byCategory.DRIVING ||
    (a.finalGateSubmittedAt ?? Number.MAX_SAFE_INTEGER) - (b.finalGateSubmittedAt ?? Number.MAX_SAFE_INTEGER) ||
    (a.tieHash < b.tieHash ? -1 : a.tieHash > b.tieHash ? 1 : 0)
  );
}
