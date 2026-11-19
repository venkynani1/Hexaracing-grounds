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

/** Derive capped per-category totals from scoring events. Totals are never stored, only derived. */
export function deriveTotals(events: readonly ScoringEventLike[]): { byCategory: CategoryTotals; total: number } {
  const byCategory = Object.fromEntries(Object.keys(SCORING_CAPS).map((k) => [k, 0])) as CategoryTotals;
  for (const e of events) byCategory[e.category] += e.points;
  let total = 0;
  for (const k of Object.keys(byCategory) as ScoringCategory[]) {
    byCategory[k] = Math.max(0, Math.min(SCORING_CAPS[k], byCategory[k]));
    total += byCategory[k];
  }
  return { byCategory, total };
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
