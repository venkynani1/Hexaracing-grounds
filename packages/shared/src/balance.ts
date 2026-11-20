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
  /** Chennai: traffic spread along all course corridors (~200 km). */
  trafficAgentsChennai: 400,
  /** Route normalisation target: reference-car time for every course (s). Players with traffic, signals and
   *  pit stops are expected to take ~1.3–1.5× this, landing near the 50:00 gate. */
  courseTargetS: 30 * 60,
  courseTolerance: 0.1,
  checkpointsPerCourse: 10,
  /** Pit stops (SPEC Part 9). Costs in garage credits. */
  pit: {
    bays: 4,
    maxDwellMs: 60_000,
    maxEntrySpeed: 4,
    reentryCooldownMs: 30_000,
    fuelCostPerPct: 2,
    repairCostPerPt: 1.5,
    tyresCost: 120,
    baseServiceMs: 5_000,
    fuelMsPerPct: 60,
    repairMs: 5_000,
    tyresMs: 6_000,
  },
  /** Roadside recovery when the tank runs dry: never elimination. */
  recovery: { delayMs: 8_000, fuelPct: 15, cost: 50 },
  serviceWindows: [
    { id: 'service-1', fromMs: 17 * 60_000, toMs: 24 * 60_000 },
    { id: 'service-2', fromMs: 36 * 60_000, toMs: 41 * 60_000 },
  ],
  /** Interest radii (DESIGN §5). M3 adds tiers and hysteresis. */
  nearRadius: 300,
  midRadius: 1200,
  /** Join/create attempts allowed per IP per minute. Venue NAT may put many phones behind one IP, so keep it generous. */
  joinAttemptsPerMinute: 60,
  sessionTtlMs: 12 * 60 * 60 * 1000,
  displayNameMax: 24,
  squadNameMax: 24,
} as const;
