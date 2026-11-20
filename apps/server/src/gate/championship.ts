import { eq } from 'drizzle-orm';
import { scoringEvents, teams, type Db } from '@redline/db';
import { compareTeams, deriveTotals, tieBreakHash, type ArrivalMode, type RankableTeam, type ScoringCategory, type Standing } from '@redline/shared';

/**
 * Championship standings derived ONLY from `scoring_events` rows in Postgres (never from stored totals).
 * Category caps applied; predeclared tie-breaks: team assessments → coding → driving → earliest final gate
 * submission (created_at of the access-code row) → hash(seed, teamId).
 */
export async function computeStandings(
  db: Db,
  eventId: string,
  seed: string,
  arrivalOf: (teamId: string) => ArrivalMode | null = () => null,
): Promise<Standing[]> {
  const ts = await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.eventId, eventId));
  const rows = await db
    .select({ teamId: scoringEvents.teamId, category: scoringEvents.category, points: scoringEvents.points, sourceType: scoringEvents.sourceType, createdAt: scoringEvents.createdAt })
    .from(scoringEvents)
    .innerJoin(teams, eq(scoringEvents.teamId, teams.id))
    .where(eq(teams.eventId, eventId));
  const ranked: (RankableTeam & { name: string })[] = ts.map((t) => {
    const mine = rows.filter((r) => r.teamId === t.id);
    const { byCategory, total } = deriveTotals(mine.map((r) => ({ category: r.category as ScoringCategory, points: r.points })));
    const gate = mine.find((r) => r.sourceType === 'gate_code');
    return { teamId: t.id, name: t.name, total, byCategory, finalGateSubmittedAt: gate ? gate.createdAt.getTime() : null, tieHash: tieBreakHash(seed, t.id) };
  });
  ranked.sort(compareTeams);
  return ranked.map((t, i) => ({ rank: i + 1, teamId: t.teamId, name: t.name, total: t.total, byCategory: t.byCategory, arrival: arrivalOf(t.teamId) }));
}
