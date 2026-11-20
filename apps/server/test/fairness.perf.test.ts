/**
 * M8 fairness simulation: 1000 seeded runs × all 7 routes × all 4 cars.
 *  - Max score (1000) must be reachable for every (seed, route, car).
 *  - Mean driving score spread across routes < 5 %.
 *  - Cars: equal route time within ±2 % (DESIGN §8 vehicle balance).
 * Model: shared vehicle model reference times (dry + rain), one pit stop, and each seed's REAL Director decisions
 * (Route Lockdown closure with its true graph detour, Traffic Shock road, Monsoon window). A "typical player" drives
 * at 75 % of reference pace. This is a model of the timeline, not a full game replay — stated in PROGRESS.md.
 */
import { describe, expect, it } from 'vitest';
import {
  BALANCE,
  BEAT_EFFECTS,
  SCORING_CAPS,
  TRAFFIC_SHOCK_SPEED_MUL,
  VEHICLES,
  coursePolyline,
  createRng,
  driveEnv,
  driveReference,
  rubricMaxima,
  type VehicleCode,
} from '@redline/shared';
import { chennaiMap } from '@redline/shared/map/chennai';
import { chooseClosure } from '../src/director/closures';

const MIN = 60_000;
const map = chennaiMap();
const net = map.net;
const routes = map.starts.filter((s) => s.verified).map((s) => s.code);
const cars = Object.keys(VEHICLES) as VehicleCode[];

/** Shortest class-speed travel time between two nodes, optionally avoiding closed edges. */
function travelTime(from: number, to: number, closed: Set<number>): number {
  const dist = new Float64Array(net.nodes.length).fill(Infinity);
  dist[from] = 0;
  const open = new Set([from]);
  while (open.size) {
    let v = -1;
    let best = Infinity;
    for (const n of open) if (dist[n]! < best) (best = dist[n]!), (v = n);
    open.delete(v);
    if (v === to) return best;
    if (best > 3600) break;
    for (const de of net.out[v]!) {
      const e = net.edges[de >> 1]!;
      if (closed.has(e.id)) continue;
      const w = de & 1 ? e.a : e.b;
      const nd = best + e.length / e.speedLimit;
      if (nd < dist[w]!) {
        dist[w] = nd;
        open.add(w);
      }
    }
  }
  return Infinity;
}

describe('M8: fairness simulation', () => {
  it('1000 seeds × 7 routes × 4 cars: max score reachable everywhere; driving spread across routes < 5 %; cars within ±2 %', () => {
    // Reference times per (route, car): dry and wet.
    const ref: Record<string, Record<string, { dry: number; wet: number }>> = {};
    for (const r of routes) {
      ref[r] = {};
      for (const c of cars) {
        const des = map.courses[r]!.des;
        const dry = driveReference(net, des, { params: VEHICLES[c] }).timeS;
        // Wet: same driver with rain grip on the whole course (scaled to the rain window below).
        const wetEnv = driveEnv(true, true);
        void wetEnv;
        const wet = driveReference(net, des, { params: { ...VEHICLES[c], latLimit: VEHICLES[c].latLimit * 0.8, grip: VEHICLES[c].grip * 0.8 } }).timeS;
        ref[r]![c] = { dry, wet };
      }
    }
    // Vehicle balance: every car within ±2 % of the route's mean.
    for (const r of routes) {
      const ts = cars.map((c) => ref[r]![c]!.dry);
      const mean = ts.reduce((a, b) => a + b, 0) / ts.length;
      for (const [i, t] of ts.entries()) expect(Math.abs(t - mean) / mean, `${r} ${cars[i]}: ${(t / 60).toFixed(2)} min vs ${(mean / 60).toFixed(2)}`).toBeLessThanOrEqual(0.02);
    }
    // Per-route course geometry for event-overlap estimates.
    const geo = Object.fromEntries(
      routes.map((r) => {
        const des = map.courses[r]!.des;
        const pts = coursePolyline(net, des, 20);
        const total = pts[pts.length - 1]!.d;
        // fraction of the course at which each directed edge starts
        let acc = 0;
        const fracOfDe = des.map((de) => {
          const f = acc / total;
          acc += net.edges[de >> 1]!.length;
          return f;
        });
        return [r, { des, total, fracOfDe }];
      }),
    );
    const detourCache = new Map<string, number>();
    const closureDelay = (route: string, edges: number[]) => {
      const key = `${route}:${edges[0]}`;
      if (detourCache.has(key)) return detourCache.get(key)!;
      const des = geo[route]!.des;
      const closed = new Set(edges);
      const idx = des.map((de, i) => (closed.has(de >> 1) ? i : -1)).filter((i) => i >= 0);
      let delay = 0;
      if (idx.length) {
        const first = des[idx[0]!]!;
        const last = des[idx[idx.length - 1]!]!;
        const fromNode = first & 1 ? net.edges[first >> 1]!.b : net.edges[first >> 1]!.a;
        const toNode = last & 1 ? net.edges[last >> 1]!.a : net.edges[last >> 1]!.b;
        const normal = travelTime(fromNode, toNode, new Set());
        const around = travelTime(fromNode, toNode, closed);
        delay = Math.max(0, around - normal);
      }
      detourCache.set(key, delay);
      return delay;
    };

    const START = BALANCE.releaseAtMs / 1000; // 03:00
    const GATE = 50 * 60; // 50:00
    const PIT = 60; // one stop, max dwell
    const pace = { reference: 1, typical: 0.75 };
    const driving: Record<string, Record<string, number[]>> = { reference: {}, typical: {} };
    let combos = 0;
    let maxReachable = 0;
    for (let seed = 0; seed < 1000; seed++) {
      const lock = chooseClosure(map, createRng(`fair-${seed}`, 'beat:ROUTE_LOCKDOWN'), 37 * MIN).closure!;
      const names = [...new Set(Object.values(map.courses).flatMap((c) => c.des.map((de) => net.edges[de >> 1]!).filter((e) => e.cls <= 2 && e.name).map((e) => e.name!)))].sort();
      const jam = createRng(`fair-${seed}`, 'beat:TRAFFIC_SHOCK').pick(names);
      for (const r of routes) {
        const g = geo[r]!;
        const closureIdx = g.des.findIndex((de) => lock.edges.includes(de >> 1));
        const jamLen = g.des.reduce((a, de) => a + (net.edges[de >> 1]!.name === jam ? net.edges[de >> 1]!.length : 0), 0);
        for (const c of cars) {
          for (const [who, p] of Object.entries(pace)) {
            const base = ref[r]![c]!.dry / p;
            const wetFactor = ref[r]![c]!.wet / ref[r]![c]!.dry;
            // Monsoon 37:00–45:00 slows whatever part of the drive falls inside it.
            const driveStart = START;
            let t = base + PIT;
            const rainOverlap = Math.max(0, Math.min(driveStart + t, 45 * 60) - Math.max(driveStart, 37 * 60));
            t += rainOverlap * (wetFactor - 1);
            // Route Lockdown 31:00–37:00: detour only if the squad reaches the closed chain inside the window.
            if (closureIdx >= 0) {
              const reachAt = driveStart + g.fracOfDe[closureIdx]! * base;
              if (reachAt >= 31 * 60 && reachAt <= 37 * 60) t += closureDelay(r, lock.edges) / p;
            }
            // Traffic Shock 14:00–17:00: crawling traffic on the jammed road (bounded: half the stretch at crawl speed).
            if (jamLen > 0) t += Math.min(180, ((jamLen * 0.5) / 15) * (1 / TRAFFIC_SHOCK_SPEED_MUL - 1)) * 0.5;
            const arrive = driveStart + t;
            // Driving points: checkpoints are at equal fractions of the course → reached in time proportionally.
            const frac = Math.min(1, Math.max(0, (GATE - driveStart) / t));
            const cps = Math.min(10, Math.floor(frac * 10 + 1e-9));
            const score = arrive <= GATE ? 250 : cps * 25;
            ((driving[who]![r] ??= []) as number[]).push(score);
            if (who === 'reference') {
              combos++;
              // Max score: every non-driving opportunity is identical for all squads (rubric) + full driving if reachable.
              const other = Object.values(rubricMaxima()).reduce((a, b) => a + (b ?? 0), 0) - (rubricMaxima().DRIVING ?? 0);
              if (score + other === 1000) maxReachable++;
            }
          }
        }
      }
    }
    void BEAT_EFFECTS;
    expect(combos).toBe(1000 * routes.length * cars.length);
    expect(Object.values(SCORING_CAPS).reduce((a, b) => a + b, 0)).toBe(1000);
    expect(maxReachable).toBe(combos); // max score reachable for every combination
    const report: Record<string, string> = {};
    for (const who of ['reference', 'typical']) {
      const means = routes.map((r) => driving[who]![r]!.reduce((a, b) => a + b, 0) / driving[who]![r]!.length);
      const avg = means.reduce((a, b) => a + b, 0) / means.length;
      const spread = (Math.max(...means) - Math.min(...means)) / avg;
      report[who] = `${routes.map((r, i) => `${r}=${means[i]!.toFixed(1)}`).join(' ')} spread=${(spread * 100).toFixed(2)}%`;
      expect(spread, who).toBeLessThan(0.05);
    }
    console.log(`[M8 fairness] combos=${combos} maxReachable=${maxReachable}\n  reference: ${report.reference}\n  typical:   ${report.typical}`);
  }, 600_000);
});
