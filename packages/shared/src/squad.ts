/**
 * Four-player squad mechanics (SPEC Part 8, 12; DESIGN §7–8). PUBLIC data only: schedule, rubric, buffs,
 * power-ups, waypoints and view types. Questions, answers and clues live on the server.
 */
import type { Role, ScoringCategory } from './enums';
import type { VehicleParams } from './sim/vehicle';

const MIN = 60_000;

export type ChallengeKind = 'coding' | 'four_key' | 'bluff' | 'navigation';

export interface ScheduledChallenge {
  id: string;
  kind: ChallengeKind;
  title: string;
  opensAt: number;
  closesAt: number;
  /** Bluff: entries accepted until this time, then voting. */
  writeUntil?: number;
  /** Coding: number of questions in the round. */
  questions?: number;
}

/** Synchronised deadlines: identical for every squad (elapsed LIVE ms). */
export const CHALLENGE_SCHEDULE: ScheduledChallenge[] = [
  { id: 'coding-1', kind: 'coding', title: 'Coding Round 1', opensAt: 3 * MIN, closesAt: 10 * MIN, questions: 4 },
  { id: 'fourkey-1', kind: 'four_key', title: 'Four-Key Puzzle 1', opensAt: 10 * MIN, closesAt: 17 * MIN },
  { id: 'bluff-1', kind: 'bluff', title: 'Bluff Round 1', opensAt: 10.5 * MIN, writeUntil: 13 * MIN, closesAt: 16 * MIN },
  { id: 'nav-1', kind: 'navigation', title: 'Navigation Intel', opensAt: 24 * MIN, closesAt: 31 * MIN },
  { id: 'bluff-2', kind: 'bluff', title: 'Bluff Round 2', opensAt: 25 * MIN, writeUntil: 28 * MIN, closesAt: 31 * MIN },
  { id: 'coding-2', kind: 'coding', title: 'Coding Round 2', opensAt: 33 * MIN, closesAt: 42 * MIN, questions: 4 },
  { id: 'fourkey-2', kind: 'four_key', title: 'Four-Key Puzzle 2', opensAt: 42 * MIN, closesAt: 50 * MIN },
];

/**
 * Scoring rubric for squad mechanics (identical opportunities for every squad). Category caps in scoring.ts.
 * CAPTAIN_STRATEGY's remaining 50 and FUEL_MANAGEMENT come with pit stops (M6); DRIVING (M5/M7); GATE (M7).
 */
export const SQUAD_RUBRIC = {
  coding: { category: 'CODING' as ScoringCategory, firstTry: 25, secondTry: 10, maxAttempts: 2 },
  fourKey: { category: 'TEAM_ASSESSMENTS' as ScoringCategory, byAttempt: [75, 40, 20], maxAttempts: 3 },
  bluff: { category: 'DECEPTION' as ScoringCategory, detect: 25, perFooled: 10, maxFooled: 50 },
  navigation: { category: 'CAPTAIN_STRATEGY' as ScoringCategory, firstTry: 50, secondTry: 20, maxAttempts: 2 },
  /** Per service window, first completed stop: FUEL_MANAGEMENT 25 (correct diagnosis) or 10; CAPTAIN_STRATEGY 25 if the
   *  confirmed plan covers the diagnosed system AND the Deceiver flagged the false report. */
  pit: { fuel: 25, fuelWrong: 10, strategy: 25 },
  /** Per checkpoint (10 per course): reached under own power 15, clean (no ramming penalty since the previous one) 10.
   *  Checkpoints passed during the disclosed escort score 0. */
  driving: { reach: 15, clean: 10 },
  /** Hexaware Gate 50:00–55:00: four tasks × 25. Access code by attempt 25/15/5. */
  gate: { parking: 25, debug: 25, auth: 25, code: [25, 15, 5] as readonly number[] },
} as const;

/** Max points per category reachable from the schedule above (checked against caps in tests). */
export function rubricMaxima(): Partial<Record<ScoringCategory, number>> {
  const out: Partial<Record<ScoringCategory, number>> = {};
  const add = (c: ScoringCategory, p: number) => (out[c] = (out[c] ?? 0) + p);
  for (const c of CHALLENGE_SCHEDULE) {
    if (c.kind === 'coding') add('CODING', (c.questions ?? 0) * SQUAD_RUBRIC.coding.firstTry);
    if (c.kind === 'four_key') add('TEAM_ASSESSMENTS', SQUAD_RUBRIC.fourKey.byAttempt[0]);
    if (c.kind === 'bluff') add('DECEPTION', SQUAD_RUBRIC.bluff.detect + SQUAD_RUBRIC.bluff.maxFooled);
    if (c.kind === 'navigation') add('CAPTAIN_STRATEGY', SQUAD_RUBRIC.navigation.firstTry);
  }
  add('DRIVING', 10 * (SQUAD_RUBRIC.driving.reach + SQUAD_RUBRIC.driving.clean));
  add('HEXAWARE_GATE', SQUAD_RUBRIC.gate.parking + SQUAD_RUBRIC.gate.debug + SQUAD_RUBRIC.gate.auth + SQUAD_RUBRIC.gate.code[0]!);
  // Pit stops: one scored stop per service window.
  add('FUEL_MANAGEMENT', SQUAD_RUBRIC.pit.fuel * 2);
  add('CAPTAIN_STRATEGY', SQUAD_RUBRIC.pit.strategy * 2);
  return out;
}

/* ---------------- Buffs & power-ups (applied to the real squad car on the server) ---------------- */

export const BUFFS = {
  /** Engineer reward: tuned engine. */
  engine_tune: { label: 'Engine tune', durationMs: 45_000, accelMul: 1.08, gripMul: 1 },
  /** Captain power-up: sticky compound. */
  grip_boost: { label: 'Grip boost', durationMs: 45_000, accelMul: 1, gripMul: 1.12 },
} as const;
export type BuffKind = keyof typeof BUFFS;

export const POWER_UPS = {
  nitro_refill: { label: 'Nitro refill', description: 'Refill the nitro tank to 100%.' },
  patch: { label: 'Pit-crew patch', description: 'Repair +15 health on the move.' },
  grip_boost: { label: 'Grip boost', description: '+12% grip for 45 s.' },
} as const;
export type PowerUpKind = keyof typeof POWER_UPS;
export const STARTING_POWER_UPS: Record<PowerUpKind, number> = { nitro_refill: 1, patch: 1, grip_boost: 0 };

/** Effective vehicle params with active buffs. Shared by server and client prediction. */
export function applyBuffs(p: VehicleParams, active: readonly BuffKind[]): VehicleParams {
  if (!active.length) return p;
  let accel = 1;
  let grip = 1;
  for (const b of active) {
    accel *= BUFFS[b].accelMul;
    grip *= BUFFS[b].gripMul;
  }
  return { ...p, engineAccel: p.engineAccel * accel, grip: p.grip * grip, latLimit: p.latLimit * grip };
}

/* ---------------- Captain navigation ---------------- */

/** Named waypoints on the TEST network (node ids). Real maps carry their own (`WorldMap.waypoints`). */
export const WAYPOINTS = [
  { id: 'north_gate', label: 'North Gate', node: 13 },
  { id: 'east_flyover', label: 'East Flyover', node: 11 },
  { id: 'central_junction', label: 'Central Junction', node: 5 },
  { id: 'south_market', label: 'South Market', node: 2 },
  { id: 'west_depot', label: 'West Depot', node: 4 },
] as const;
export type WaypointId = string;

/* ---------------- Per-player views (server → client) ---------------- */

export type ChallengeStatus = 'upcoming' | 'open' | 'closed';

export interface CodingQuestionView {
  id: string;
  prompt: string;
  code: string;
  /** Multiple choice options, or null for a short typed answer. */
  options: string[] | null;
  attempts: number;
  maxAttempts: number;
  solved: boolean;
  points: number;
}

export interface BluffOption {
  choiceId: string;
  text: string;
}

export interface ChallengeView {
  id: string;
  kind: ChallengeKind;
  title: string;
  status: ChallengeStatus;
  opensAt: number;
  closesAt: number;
  /** What THIS player can do right now. */
  action: 'answer' | 'submit' | 'write' | 'vote' | 'view';
  // coding (Engineer answers; others see progress only)
  questions?: CodingQuestionView[];
  // four-key: this player's OWN clue only; Captain submits
  clue?: string;
  prompt?: string;
  // generic attempts/solved for four_key / navigation
  attempts?: number;
  maxAttempts?: number;
  solved?: boolean;
  points?: number;
  options?: string[];
  // bluff
  phase?: 'write' | 'vote' | 'results';
  writeUntil?: number;
  myEntry?: string | null;
  bluffOptions?: BluffOption[];
  myVote?: string | null;
  results?: { truth: string; myTeamFooled: number; detected: boolean; points: number } | null;
}

export type PitStage = 'queued' | 'in_bay' | 'servicing' | 'done';

export interface PitPlan {
  fuelPct: number;
  repair: boolean;
  tyres: boolean;
}

/** The squad's current pit stop, filtered for this player's role. */
export interface PitView {
  stopId: string;
  stationId: string;
  stationName: string;
  stage: PitStage;
  queuePosition: number;
  bay: number | null;
  dwellLeftMs: number | null;
  serviceLeftMs: number | null;
  /** step completion flags: 1 enter, 2 select, 3 diagnose, 4 verify, 5 confirm, 6 return */
  steps: { enter: boolean; select: boolean; diagnose: boolean; verify: boolean; confirm: boolean; release: boolean };
  plan: PitPlan | null;
  prices: { fuelPerPct: number; repairPerPt: number; tyres: number };
  /** Engineer only */
  diagnostics?: { readings: string[]; options: string[]; chosen: string | null };
  /** Deceiver only */
  reports?: { items: string[]; chosen: number | null };
  result: { diagnosisCorrect: boolean | null; falseSpotted: boolean | null; applied: PitPlan | null; cost: number } | null;
}

export type ArrivalMode = 'driven' | 'escort' | 'assisted';

export interface GateView {
  status: 'upcoming' | 'open' | 'closed';
  arrival: ArrivalMode | null;
  escortAvailable: boolean;
  escorting: boolean;
  parking: { spot: number; x: number; z: number; heading: number; points: number | null };
  /** Engineer only */
  debug?: { prompt: string; lines: string[]; options: string[]; chosen: string | null };
  /** Deceiver only */
  auth?: { prompt: string; badges: string[]; chosen: number | null };
  /** This player's own access digit, once revealed (Racer: on arrival; Engineer/Deceiver: after their task; Captain: own clue). */
  myDigit: { index: number; digit: number | null; hint: string };
  /** Captain only */
  code?: { prompt: string; revealed: boolean[]; attempts: number; maxAttempts: number; solved: boolean };
  points: { parking: number; debug: number; auth: number; code: number };
}

export interface SquadView {
  teamId: string;
  role: Role;
  challenges: ChallengeView[];
  inventory: Record<PowerUpKind, number>;
  waypoint: WaypointId | null;
  /** This squad's course (start location code) on the shared map, if any. */
  course: string | null;
  /** Waypoints the Captain can choose on this map. */
  waypoints: { id: WaypointId; label: string }[];
  buffs: { kind: BuffKind; remainingMs: number }[];
  score: { total: number; byCategory: Record<ScoringCategory, number> };
  credits: number;
  pit: PitView | null;
  gate: GateView | null;
  /** Level 4 rival system (duels + trades); null before matchmaking */
  rival?: import('./levels').RivalView | null;
  /** Racer safe-hold during a major puzzle (bounded, once per puzzle, auto-released) */
  safeHold?: { available: boolean; active: boolean; remainingMs: number };
  /** Levels 3–4 Deceiver ops + alliances */
  intel?: import('./levels').IntelView | null;
}
