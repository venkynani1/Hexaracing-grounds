import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_INPUT,
  SIGNAL_CYCLE_MS,
  TrafficSystem,
  VEHICLES,
  applyImpact,
  createTestNetwork,
  deEnds,
  driveEnv,
  forwardSpeed,
  generateBuildings,
  initialVehicleState,
  lanePoint,
  resolveStatic,
  signalState,
  stepVehicle,
  type VehicleInput,
  type VehicleState,
} from '../src';

const DT = 0.05;
const dry = driveEnv(true, false);
const p = VEHICLES.vortex_gt;
const run = (s: VehicleState, input: Partial<VehicleInput>, seconds: number, env = dry, params = p) => {
  for (let i = 0; i < seconds / DT; i++) s = stepVehicle(s, { ...NEUTRAL_INPUT, ...input }, params, env, DT);
  return s;
};

describe('vehicle model', () => {
  it('is deterministic', () => {
    const inputs = Array.from({ length: 200 }, (_, i) => ({ ...NEUTRAL_INPUT, throttle: 1, steer: Math.sin(i / 10) }));
    const go = () => inputs.reduce((s, inp) => stepVehicle(s, inp, p, dry, DT), initialVehicleState(0, 0, 0));
    expect(go()).toEqual(go());
  });

  it('accelerates forward (north at heading 0) and respects top speed', () => {
    const s = run(initialVehicleState(0, 0, 0), { throttle: 1 }, 3);
    expect(s.z).toBeGreaterThan(20);
    expect(Math.abs(s.x)).toBeLessThan(1e-6);
    expect(forwardSpeed(s)).toBeGreaterThan(15);
    const top = run(initialVehicleState(0, 0, 0), { throttle: 1 }, 60);
    expect(forwardSpeed(top)).toBeLessThanOrEqual(p.maxSpeed + 0.01);
    expect(forwardSpeed(top)).toBeGreaterThan(p.maxSpeed * 0.85);
  });

  it('brakes to a stop without reversing, then reverses on held brake', () => {
    let s = run(initialVehicleState(0, 0, 0), { throttle: 1 }, 4);
    const v0 = forwardSpeed(s);
    s = run(s, { brake: 1 }, 1);
    expect(forwardSpeed(s)).toBeLessThan(v0 - 10);
    s = run(s, { brake: 1 }, 3);
    expect(forwardSpeed(s)).toBeLessThanOrEqual(0);
    expect(forwardSpeed(s)).toBeGreaterThanOrEqual(-p.reverseMax);
  });

  it('steers right (clockwise, towards east) with positive steer', () => {
    let s = run(initialVehicleState(0, 0, 0), { throttle: 1 }, 2);
    s = run(s, { throttle: 0.5, steer: 1 }, 1);
    expect(s.heading).toBeGreaterThan(0.3);
    expect(s.x).toBeGreaterThan(0);
    const still = run(initialVehicleState(0, 0, 0), { steer: 1 }, 2);
    expect(still.heading).toBe(0);
  });

  it('rain reduces grip: wider turn and longer braking', () => {
    const rain = driveEnv(true, true);
    expect(rain.gripMul).toBeCloseTo(0.8);
    const turn = (env: typeof dry) => {
      let s = run(initialVehicleState(0, 0, 0), { throttle: 1 }, 5, env);
      s = run(s, { throttle: 1, steer: 1 }, 1.5, env);
      return s.heading;
    };
    expect(turn(rain)).toBeLessThan(turn(dry));
    const stopDist = (env: typeof dry) => {
      let s = run(initialVehicleState(0, 0, 0), { throttle: 1 }, 5, env);
      const z0 = s.z;
      for (let i = 0; i < 400 && forwardSpeed(s) > 0.3; i++) s = stepVehicle(s, { ...NEUTRAL_INPUT, brake: 1 }, p, env, DT);
      return s.z - z0;
    };
    expect(stopDist(rain)).toBeGreaterThan(stopDist(dry));
    expect(driveEnv(false, false).gripMul).toBeCloseTo(0.6);
  });

  it('burns fuel with distance and throttle; empty tank limps instead of eliminating', () => {
    const s = run(initialVehicleState(0, 0, 0, 75), { throttle: 1 }, 60);
    const used = 75 - s.fuel;
    expect(used).toBeGreaterThan(1.5);
    expect(used).toBeLessThan(8);
    const idle = run(initialVehicleState(0, 0, 0, 75), {}, 60);
    expect(75 - idle.fuel).toBeLessThan(0.5);
    const empty = run(initialVehicleState(0, 0, 0, 0), { throttle: 1 }, 10);
    expect(empty.fuel).toBe(0);
    expect(forwardSpeed(empty)).toBeGreaterThan(1);
    expect(forwardSpeed(empty)).toBeLessThan(15);
  });

  it('nitro boosts and drains; handbrake causes slip; tires wear', () => {
    const plain = run(initialVehicleState(0, 0, 0), { throttle: 1 }, 4);
    const boosted = run(initialVehicleState(0, 0, 0), { throttle: 1, nitro: true }, 4);
    expect(forwardSpeed(boosted)).toBeGreaterThan(forwardSpeed(plain) + 3);
    expect(boosted.nitro).toBeLessThan(100);
    let s = run(initialVehicleState(0, 0, 0), { throttle: 1 }, 5);
    s = run(s, { throttle: 0.6, steer: 1, handbrake: true }, 1);
    expect(s.tires).toBeLessThan(100);
  });

  it('collision damage is bounded per hit, scaled by durability, and never eliminates', () => {
    const s = initialVehicleState(0, 0, 0);
    const big = applyImpact(s, 80, p);
    expect(100 - big.health).toBe(15);
    expect(applyImpact(s, 1.5, p).health).toBe(100);
    const titan = applyImpact(s, 8, VEHICLES.titan_xr);
    const phantom = applyImpact(s, 8, VEHICLES.phantom_x);
    expect(titan.health).toBeGreaterThan(phantom.health);
    let wreck = s;
    for (let i = 0; i < 50; i++) wreck = applyImpact(wreck, 80, p);
    expect(wreck.health).toBe(5);
  });

  it('all four cars share one top speed (score ceiling independent of car)', () => {
    const tops = Object.values(VEHICLES).map((v) => v.maxSpeed);
    expect(new Set(tops).size).toBe(1);
  });
});

describe('world geometry', () => {
  const net = createTestNetwork();
  it('lanes keep left of travel direction', () => {
    const de = 0; // a→b along +x (east): left is north (+z)
    const { from, to } = deEnds(net, de);
    expect(to.x).toBeGreaterThan(from.x);
    expect(lanePoint(net, de, 0, 50).z).toBeGreaterThan(from.z);
    expect(lanePoint(net, de ^ 1, 0, 50).z).toBeLessThan(from.z);
  });
  it('buildings are deterministic, off the road, and block cars', () => {
    const b1 = generateBuildings(net, 7);
    expect(b1).toEqual(generateBuildings(net, 7));
    expect(b1.length).toBeGreaterThan(50);
    const b = b1[0]!;
    // Drive straight into the building from the west.
    const s = { ...initialVehicleState(b.x - b.w / 2 - 1, b.z, Math.PI / 2), vx: 20 };
    const r = resolveStatic(s, b1, net.bounds);
    expect(r.impact).toBeGreaterThan(10);
    expect(r.state.x).toBeLessThanOrEqual(b.x - b.w / 2 - 1.99);
    expect(r.state.vx).toBeLessThan(0);
  });
  it('signals: crossing axes are never green together; cycle repeats', () => {
    for (let t = 0; t < SIGNAL_CYCLE_MS * 2; t += 250) {
      const ns = signalState(5, 'NS', t, 1);
      const ew = signalState(5, 'EW', t, 1);
      expect(ns !== 'R' && ew !== 'R').toBe(false);
      expect(signalState(5, 'NS', t + SIGNAL_CYCLE_MS, 1)).toBe(ns);
    }
  });
});

describe('traffic', () => {
  const net = createTestNetwork();

  it('agents follow their lane centrelines and pass through junctions onto new edges', () => {
    const ts = new TrafficSystem(net, { seed: 3, count: 40, signal: () => 'G' });
    const startDe = new Map(ts.agents.map((a) => [a.id, a.de]));
    for (let i = 0; i < 20 * 60; i++) {
      ts.step(DT, i * 50);
      for (const a of ts.agents) {
        if (a.conn || a.laneF !== a.lane) continue;
        const pose = ts.pose(a);
        const c = lanePoint(net, a.de, a.lane, a.s);
        expect(Math.hypot(pose.x - c.x, pose.z - c.z)).toBeLessThan(1e-6);
      }
    }
    const moved = ts.agents.filter((a) => a.de !== startDe.get(a.id));
    expect(moved.length).toBeGreaterThan(30);
    // No two agents overlap in the same lane.
    for (const a of ts.agents)
      for (const b of ts.agents) {
        if (a === b || a.conn || b.conn || a.de !== b.de || a.lane !== b.lane || a.laneF !== a.lane || b.laneF !== b.lane) continue;
        expect(Math.abs(a.s - b.s)).toBeGreaterThan(2);
      }
  });

  it('stops at a red signal before the stop line, and proceeds on green', () => {
    let light: 'R' | 'G' = 'R';
    const ts = new TrafficSystem(net, { seed: 1, count: 0, signal: () => light });
    // Find a directed edge that ends at a signalised node.
    const de = [...Array(net.edges.length * 2).keys()].find((d) => deEnds(net, d).to.signal)!;
    const len = net.edges[de >> 1]!.length;
    ts.agents.push({ id: 1, type: 'car', de, lane: 0, laneF: 0, s: 40, speed: 14, cruise: 1, conn: null, blocked: false });
    const a = ts.agents[0]!;
    const stopS = len - net.junctionRadius;
    for (let i = 0; i < 20 * 40; i++) ts.step(DT, i * 50);
    expect(a.conn).toBeNull();
    expect(a.de).toBe(de);
    expect(a.speed).toBeLessThan(0.1);
    expect(a.s).toBeLessThanOrEqual(stopS);
    expect(a.s).toBeGreaterThan(stopS - 8);
    light = 'G';
    for (let i = 0; i < 20 * 10; i++) ts.step(DT, i * 50);
    expect(a.de === de && a.conn === null).toBe(false);
  });

  it('stops for squad cars blocking both lanes', () => {
    const ts = new TrafficSystem(net, { seed: 1, count: 0, signal: () => 'G' });
    const de = 2;
    ts.agents.push({ id: 1, type: 'car', de, lane: 0, laneF: 0, s: 60, speed: 12, cruise: 1, conn: null, blocked: false });
    const a = ts.agents[0]!;
    const blocks = [lanePoint(net, de, 0, 160), lanePoint(net, de, 1, 160)];
    for (let i = 0; i < 20 * 20; i++) ts.step(DT, i * 50, blocks);
    expect(a.speed).toBeLessThan(0.2);
    expect(a.s).toBeLessThan(160 - 4);
    expect(a.s).toBeGreaterThan(140);
  });

  it('changes lane to pass a car blocking one lane, without touching it', () => {
    const ts = new TrafficSystem(net, { seed: 1, count: 0, signal: () => 'G' });
    const de = 2;
    ts.agents.push({ id: 1, type: 'car', de, lane: 0, laneF: 0, s: 60, speed: 12, cruise: 1, conn: null, blocked: false });
    const a = ts.agents[0]!;
    const block = lanePoint(net, de, 0, 160);
    let minDist = Infinity;
    for (let i = 0; i < 20 * 40; i++) {
      ts.step(DT, i * 50, [block]);
      const p = ts.pose(a);
      minDist = Math.min(minDist, Math.hypot(p.x - block.x, p.z - block.z));
    }
    expect(a.de !== de || a.s > 170).toBe(true);
    expect(minDist).toBeGreaterThan(2.5);
  });

  it('is reproducible for a given seed', () => {
    const go = () => {
      const ts = new TrafficSystem(net, { seed: 'x', count: 60 });
      for (let i = 0; i < 400; i++) ts.step(DT, i * 50);
      return ts.poses();
    };
    expect(go()).toEqual(go());
  });
});
