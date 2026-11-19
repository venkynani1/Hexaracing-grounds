/** Provisional balancing values (SPEC Part 9). Change here only. */
export const BALANCE = {
  squadSize: 4,
  maxSquads: 30,
  startFuelPct: 75,
  startHealthPct: 100,
  startTiresPct: 100,
  startCredits: 500,
  countdownMs: 10_000,
  /** Cars are released at CITY_SPRINT (03:00); before that inputs are acknowledged but ignored. */
  releaseAtMs: 3 * 60_000,
  trafficAgents: 100,
  /** Interest radii (DESIGN §5). M3 adds tiers and hysteresis. */
  nearRadius: 300,
  midRadius: 1200,
  /** Join/create attempts allowed per IP per minute. Venue NAT may put many phones behind one IP, so keep it generous. */
  joinAttemptsPerMinute: 60,
  sessionTtlMs: 12 * 60 * 60 * 1000,
  displayNameMax: 24,
  squadNameMax: 24,
} as const;
