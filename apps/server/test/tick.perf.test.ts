/**
 * Timing benchmarks (server tick budgets). Run in isolation (vitest.perf.config.ts) so other test files
 * competing for CPU don't distort the measurement. `npm test` runs these after the main suite.
 */
import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { NEUTRAL_INPUT } from '@redline/shared';
import { chennaiMap } from '@redline/shared/map/chennai';
import { WorldSim } from '../src/world/WorldSim';

const map = chennaiMap();

describe('M2: world sim benchmark', () => {
  it('tick p99 < 2 ms with 1 car + 100 traffic agents (benchmark)', () => {
    const sim = new WorldSim({ seed: 'bench', trafficCount: 100 });
    sim.spawn([{ teamId: 't1', name: 'Bench' }]);
    sim.released = true;
    expect(sim.traffic.agents.length).toBe(100);
    let seq = 0;
    for (let i = 0; i < 200; i++) {
      sim.pushInput('t1', ++seq, { ...NEUTRAL_INPUT, throttle: 1, steer: Math.sin(i / 15) * 0.3 });
      sim.step();
    }
    const d: number[] = [];
    for (let i = 0; i < 3000; i++) {
      sim.pushInput('t1', ++seq, { ...NEUTRAL_INPUT, throttle: 1, steer: Math.sin(i / 15) * 0.3 });
      const t0 = performance.now();
      sim.step();
      d.push(performance.now() - t0);
    }
    d.sort((a, b) => a - b);
    const p99 = d[Math.floor(d.length * 0.99)]!;
    console.log(`[bench] tick p50=${d[1500]!.toFixed(3)}ms p99=${p99.toFixed(3)}ms`);
    expect(p99).toBeLessThan(2);
  });

});

describe('M5: performance on the real map', () => {
  it('30 squad cars + 400 traffic agents on Chennai: tick p99 within the 10 ms server budget', () => {
    const sim = new WorldSim({ seed: 'perf', trafficCount: 400, map });
    const teams = map.starts.flatMap((st) => Array.from({ length: 5 }, (_, i) => ({ teamId: `${st.code}-${i}`, name: `${st.code}-${i}`, start: st.code }))).slice(0, 30);
    sim.spawn(teams);
    sim.released = true;
    expect(sim.cars.size).toBe(30);
    let seq = 0;
    const d: number[] = [];
    for (let i = 0; i < 1200; i++) {
      seq++;
      for (const t of teams) sim.pushInput(t.teamId, seq, { ...NEUTRAL_INPUT, throttle: 1, steer: Math.sin(i / 20) * 0.2 });
      const t0 = performance.now();
      sim.step();
      if (i > 100) d.push(performance.now() - t0);
    }
    d.sort((a, b) => a - b);
    const p99 = d[Math.floor(d.length * 0.99)]!;
    console.log(`[M5] Chennai tick: p50 ${d[Math.floor(d.length / 2)]!.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms (30 cars, 400 traffic)`);
    expect(p99).toBeLessThan(10);
  }, 60_000);
});
