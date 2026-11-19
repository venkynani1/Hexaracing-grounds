import { describe, expect, it } from 'vitest';
import {
  BEATS,
  EVENT_DURATION_MS,
  JOIN_CODE_ALPHABET,
  MAX_SCORE,
  PHASES,
  SCORING_CAPS,
  beatsBetween,
  compareTeams,
  createRng,
  deriveTotals,
  generateJoinCode,
  normalizeJoinCode,
  phaseAt,
  tieBreakHash,
  type RankableTeam,
} from '../src';

const MIN = 60_000;

describe('timeline', () => {
  it('matches the SPEC Part 11 table at every boundary', () => {
    const table: [number, string][] = [
      [0, 'IGNITION'], [3 * MIN - 1, 'IGNITION'], [3 * MIN, 'CITY_SPRINT'], [10 * MIN, 'TRAFFIC_TACTICS'],
      [17 * MIN, 'FUEL_CRISIS'], [24 * MIN, 'UNKNOWN_ZONE'], [33 * MIN, 'REDLINE_OVERDRIVE'],
      [42 * MIN, 'FINAL_APPROACH'], [50 * MIN, 'HEXAWARE_GATE'], [55 * MIN, 'WELCOME_CONVOY'],
      [58 * MIN, 'CHAMPIONSHIP_REVEAL'], [60 * MIN - 1, 'CHAMPIONSHIP_REVEAL'],
    ];
    for (const [ms, id] of table) expect(phaseAt(ms), `at ${ms}`).toBe(id);
    expect(phaseAt(EVENT_DURATION_MS)).toBeNull();
    expect(phaseAt(-1)).toBeNull();
    expect(PHASES).toHaveLength(10);
  });

  it('fires each beat exactly once across arbitrary tick boundaries', () => {
    const fired: string[] = [];
    let prev = -1;
    for (let t = 0; t <= EVENT_DURATION_MS; t += 7_919) {
      fired.push(...beatsBetween(prev, t).map((b) => b.id));
      prev = t;
    }
    fired.push(...beatsBetween(prev, EVENT_DURATION_MS).map((b) => b.id));
    expect(fired).toEqual(BEATS.map((b) => b.id));
  });
});

describe('join codes', () => {
  it('excludes ambiguous characters', () => {
    for (const ch of '01OIL') expect(JOIN_CODE_ALPHABET).not.toContain(ch);
  });
  it('generates 6-char codes from the safe alphabet', () => {
    const rng = createRng(1);
    for (let i = 0; i < 500; i++) {
      const code = generateJoinCode(rng.int);
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    }
  });
  it('normalises input and rejects invalid codes', () => {
    expect(normalizeJoinCode(' ab-c 234 ')).toBe('ABC234');
    expect(normalizeJoinCode('ABC23O')).toBeNull();
    expect(normalizeJoinCode('ABC23')).toBeNull();
    expect(normalizeJoinCode(42)).toBeNull();
  });
});

describe('seeded rng', () => {
  it('is reproducible per seed and stream, and differs across them', () => {
    const seq = (s: number, stream: string) => {
      const r = createRng(s, stream);
      return Array.from({ length: 8 }, () => r.int(1000));
    };
    expect(seq(42, 'a')).toEqual(seq(42, 'a'));
    expect(seq(42, 'a')).not.toEqual(seq(42, 'b'));
    expect(seq(42, 'a')).not.toEqual(seq(43, 'a'));
  });
  it('stays in range', () => {
    const r = createRng('x');
    for (let i = 0; i < 10_000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('scoring', () => {
  it('caps sum to 1000', () => {
    expect(Object.values(SCORING_CAPS).reduce((a, b) => a + b, 0)).toBe(MAX_SCORE);
  });
  it('derives capped totals', () => {
    const t = deriveTotals([
      { category: 'CODING', points: 150 },
      { category: 'CODING', points: 100 },
      { category: 'DRIVING', points: 25 },
    ]);
    expect(t.byCategory.CODING).toBe(200);
    expect(t.total).toBe(225);
  });
  it('applies the tie-break order', () => {
    const base = (id: string, over: Partial<RankableTeam['byCategory']>, gate: number | null = null): RankableTeam => {
      const { byCategory, total } = deriveTotals(
        Object.entries(over).map(([category, points]) => ({ category: category as never, points: points! })),
      );
      return { teamId: id, byCategory, total, finalGateSubmittedAt: gate, tieHash: tieBreakHash(1, id) };
    };
    const a = base('a', { TEAM_ASSESSMENTS: 100, CODING: 50 });
    const b = base('b', { TEAM_ASSESSMENTS: 50, CODING: 100 });
    expect([b, a].sort(compareTeams).map((t) => t.teamId)).toEqual(['a', 'b']);
    const c = base('c', { CODING: 100, DRIVING: 50 });
    const d = base('d', { CODING: 50, DRIVING: 100 });
    expect([d, c].sort(compareTeams).map((t) => t.teamId)).toEqual(['c', 'd']);
    const e = base('e', { DRIVING: 10 }, 2000);
    const f = base('f', { DRIVING: 10 }, 1000);
    expect([e, f].sort(compareTeams).map((t) => t.teamId)).toEqual(['f', 'e']);
    const g = base('g', {});
    const h = base('h', {});
    const sorted = [g, h].sort(compareTeams).map((t) => t.teamId);
    expect(sorted).toEqual([h, g].sort(compareTeams).map((t) => t.teamId));
  });
});
