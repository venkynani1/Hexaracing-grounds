/**
 * Official 60-minute timeline (SPEC Part 10/11, DESIGN §7).
 * All phases and beats are pure functions of LIVE elapsed milliseconds.
 */
const MIN = 60_000;

export const PHASES = [
  { id: 'IGNITION', label: 'Ignition', startMs: 0 * MIN },
  { id: 'CITY_SPRINT', label: 'City Sprint', startMs: 3 * MIN },
  { id: 'TRAFFIC_TACTICS', label: 'Traffic & Tactics', startMs: 10 * MIN },
  { id: 'FUEL_CRISIS', label: 'Fuel Crisis', startMs: 17 * MIN },
  { id: 'UNKNOWN_ZONE', label: 'Unknown Zone', startMs: 24 * MIN },
  { id: 'REDLINE_OVERDRIVE', label: 'Redline Overdrive', startMs: 33 * MIN },
  { id: 'FINAL_APPROACH', label: 'Final Approach', startMs: 42 * MIN },
  { id: 'HEXAWARE_GATE', label: 'Hexaware Gate', startMs: 50 * MIN },
  { id: 'WELCOME_CONVOY', label: 'Welcome Convoy', startMs: 55 * MIN },
  { id: 'CHAMPIONSHIP_REVEAL', label: 'Championship Reveal', startMs: 58 * MIN },
] as const;

export type PhaseId = (typeof PHASES)[number]['id'];

export const EVENT_DURATION_MS = 60 * MIN;

export const BEATS = [
  { id: 'FIRST_CONTACT', label: 'First Contact', atMs: 8 * MIN },
  { id: 'TRAFFIC_SHOCK', label: 'Traffic Shock', atMs: 14 * MIN },
  { id: 'FUEL_CRISIS', label: 'Fuel Crisis', atMs: 20 * MIN },
  { id: 'CLASSIFIED_ENVELOPE', label: 'Classified Envelope', atMs: 27 * MIN },
  { id: 'ROUTE_LOCKDOWN', label: 'Route Lockdown', atMs: 31 * MIN },
  { id: 'MONSOON_PROTOCOL', label: 'Monsoon Protocol', atMs: 37 * MIN },
  { id: 'FINAL_RECRUITMENT_ALERT', label: 'Final Recruitment Alert', atMs: 43 * MIN },
  { id: 'TOTAL_REDLINE', label: 'Total Redline', atMs: 47 * MIN },
] as const;

export type BeatId = (typeof BEATS)[number]['id'];

/** Phase active at a LIVE elapsed time. Returns null once the event is over (>= 60:00) or before 0. */
export function phaseAt(elapsedMs: number): PhaseId | null {
  if (elapsedMs < 0 || elapsedMs >= EVENT_DURATION_MS) return null;
  let current: PhaseId = PHASES[0].id;
  for (const p of PHASES) {
    if (elapsedMs >= p.startMs) current = p.id;
    else break;
  }
  return current;
}

/** Phase end (ms) for a given phase id. */
export function phaseEndMs(id: PhaseId): number {
  const i = PHASES.findIndex((p) => p.id === id);
  const next = PHASES[i + 1];
  return next ? next.startMs : EVENT_DURATION_MS;
}

/** Beats whose time falls in (fromMs, toMs]. Used by the Director to fire each beat exactly once. */
export function beatsBetween(fromMs: number, toMs: number) {
  return BEATS.filter((b) => b.atMs > fromMs && b.atMs <= toMs);
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
