import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_SCHEDULE,
  NEUTRAL_INPUT,
  SCORING_CAPS,
  VEHICLES,
  WAYPOINTS,
  applyBuffs,
  createTestNetwork,
  driveEnv,
  forwardSpeed,
  initialVehicleState,
  rubricMaxima,
  stepVehicle,
  phaseAt,
} from '../src';

describe('squad rubric', () => {
  it('reachable points per category never exceed the category cap', () => {
    const max = rubricMaxima();
    for (const [cat, pts] of Object.entries(max)) expect(pts, cat).toBeLessThanOrEqual(SCORING_CAPS[cat as keyof typeof SCORING_CAPS]);
    expect(max.CODING).toBe(200);
    expect(max.TEAM_ASSESSMENTS).toBe(150);
    expect(max.DECEPTION).toBe(150);
    expect(max.CAPTAIN_STRATEGY).toBe(100);
    expect(max.FUEL_MANAGEMENT).toBe(50);
  });
  it('every challenge window sits inside the 60-minute timeline, before the gate', () => {
    for (const c of CHALLENGE_SCHEDULE) {
      expect(c.opensAt).toBeLessThan(c.closesAt);
      expect(phaseAt(c.opensAt)).not.toBeNull();
      expect(c.closesAt).toBeLessThanOrEqual(50 * 60_000);
      if (c.writeUntil) expect(c.writeUntil > c.opensAt && c.writeUntil < c.closesAt).toBe(true);
    }
  });
  it('waypoints reference real nodes', () => {
    const net = createTestNetwork();
    for (const w of WAYPOINTS) expect(net.nodes[w.node]).toBeDefined();
  });
});

describe('buffs', () => {
  it('engine tune makes the car accelerate faster; no buffs = identity', () => {
    const p = VEHICLES.vortex_gt;
    expect(applyBuffs(p, [])).toBe(p);
    const tuned = applyBuffs(p, ['engine_tune']);
    expect(tuned.engineAccel).toBeCloseTo(p.engineAccel * 1.08);
    expect(tuned.maxSpeed).toBe(p.maxSpeed); // never raises the top-speed ceiling
    const run = (params: typeof p) => {
      let s = initialVehicleState(0, 0, 0);
      for (let i = 0; i < 40; i++) s = stepVehicle(s, { ...NEUTRAL_INPUT, throttle: 1 }, params, driveEnv(true, false), 0.05);
      return forwardSpeed(s);
    };
    expect(run(tuned)).toBeGreaterThan(run(p));
    expect(applyBuffs(p, ['grip_boost']).grip).toBeGreaterThan(p.grip);
  });
});
