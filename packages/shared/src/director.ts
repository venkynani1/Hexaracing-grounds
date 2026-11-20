/**
 * Redline Director beat effects (DESIGN §7). Public, bounded definitions; the SERVER draws every random choice
 * from createRng(EVENT_SEED, "beat:<id>") and audit-logs it, so the same seed reproduces the same event.
 */
import type { BeatId } from './timeline';
import type { PowerUpKind } from './squad';

const MIN = 60_000;

export const BEAT_EFFECTS: Record<BeatId, { text: string; durationMs?: number }> = {
  FIRST_CONTACT: { text: 'FIRST CONTACT — squads are converging on the same corridors. Check your mirrors and the map.' },
  TRAFFIC_SHOCK: { text: 'TRAFFIC SHOCK — a corridor is jammed for 3 minutes. Traffic there crawls.', durationMs: 3 * MIN },
  FUEL_CRISIS: { text: 'FUEL CRISIS — fuel prices ×1.5 at every station for 5 minutes.', durationMs: 5 * MIN },
  CLASSIFIED_ENVELOPE: { text: 'CLASSIFIED ENVELOPE — every Captain receives the same sealed power-up.' },
  ROUTE_LOCKDOWN: { text: 'ROUTE LOCKDOWN — a road is closed for 6 minutes. Every squad still has an open route.', durationMs: 6 * MIN },
  MONSOON_PROTOCOL: { text: 'MONSOON PROTOCOL — heavy rain across Chennai. Grip −20% for everyone until 45:00.', durationMs: 8 * MIN },
  FINAL_RECRUITMENT_ALERT: { text: 'FINAL RECRUITMENT ALERT — the Hexaware Gate assessment opens at 50:00.' },
  TOTAL_REDLINE: { text: 'TOTAL REDLINE — every squad gets a full nitro refill. Push for the gate!' },
};

export const ENVELOPE_OPTIONS: PowerUpKind[] = ['grip_boost', 'nitro_refill', 'patch'];
export const TRAFFIC_SHOCK_SPEED_MUL = 0.45;
export const FUEL_CRISIS_PRICE_MUL = 1.5;

export interface Closure {
  id: string;
  label: string;
  edges: number[];
  /** Physical barriers across the road (shared obstacles: server collision + client prediction + rendering). */
  barriers: { x: number; z: number; heading: number; width: number }[];
  untilMs: number;
}

export interface WorldState {
  /** Monotonic revision: every client sees the same sequence. */
  rev: number;
  rain: boolean;
  closures: Closure[];
  slowRoads: { label: string; edges: number[]; mul: number; untilMs: number }[];
  fuelPriceMul: number;
  announcement: { beat: BeatId | 'SYSTEM'; text: string; atMs: number } | null;
  /** Beats fired so far, with their seeded decision (public, for transparency). */
  beats: { beat: BeatId; atMs: number; decision: string }[];
}

export const INITIAL_WORLD_STATE: WorldState = { rev: 0, rain: false, closures: [], slowRoads: [], fuelPriceMul: 1, announcement: null, beats: [] };
