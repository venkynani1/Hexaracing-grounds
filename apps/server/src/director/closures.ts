/**
 * Route Lockdown closure selection. Candidates are contiguous named major-road chains on the course corridors
 * (120–500 m). A candidate is accepted only if EVERY course still has a route to Hexaware from EVERY one of its
 * nodes outside the closed chain — so a closure can never strand a squad. Deterministic given the RNG.
 */
import type { Closure, Rng, RoadNetwork, WorldMap } from '@redline/shared';
import { deHeading, lanePoint } from '@redline/shared';

export interface ClosureCandidate {
  label: string;
  /** directed edges in travel order (from one course) */
  des: number[];
}

const candCache = new WeakMap<WorldMap, ClosureCandidate[]>();
export function closureCandidates(map: WorldMap): ClosureCandidate[] {
  const hit = candCache.get(map);
  if (hit) return hit;
  const net = map.net;
  const out: ClosureCandidate[] = [];
  const seen = new Set<number>();
  for (const code of Object.keys(map.courses).sort()) {
    const des = map.courses[code]!.des;
    let i = 0;
    while (i < des.length) {
      const e = net.edges[des[i]! >> 1]!;
      if (e.cls > 2 || !e.name) {
        i++;
        continue;
      }
      const chain = [des[i]!];
      let len = e.length;
      let j = i + 1;
      while (j < des.length && len < 500) {
        const f = net.edges[des[j]! >> 1]!;
        if (f.name !== e.name || f.cls > 2) break;
        chain.push(des[j]!);
        len += f.length;
        j++;
      }
      // Skip the first/last stretch of a course (start grids and the gate approach stay open).
      const frac = i / des.length;
      if (len >= 120 && frac > 0.15 && frac < 0.85 && !seen.has(chain[0]! >> 1)) {
        seen.add(chain[0]! >> 1);
        out.push({ label: e.name, des: chain });
      }
      i = j;
    }
  }
  candCache.set(map, out);
  return out;
}

/** Nodes that can still reach `dest` when `closed` edge ids are impassable (reverse BFS, one-way rules respected). */
export function reachableToDest(net: RoadNetwork, dest: number, closed: Set<number>): Uint8Array {
  const incoming: number[][] = net.nodes.map(() => []);
  for (const e of net.edges) {
    if (closed.has(e.id)) continue;
    incoming[e.b]!.push(e.a); // a→b allowed
    if (!e.oneway) incoming[e.a]!.push(e.b);
  }
  const ok = new Uint8Array(net.nodes.length);
  const q = [dest];
  ok[dest] = 1;
  while (q.length) {
    const v = q.pop()!;
    for (const u of incoming[v]!) if (!ok[u]) (ok[u] = 1), q.push(u);
  }
  return ok;
}

/** Every course keeps a route from all of its nodes (outside the closed chain itself) to the destination. */
export function closureLeavesRoutes(map: WorldMap, closedEdges: number[]): boolean {
  const net = map.net;
  const closed = new Set(closedEdges);
  const ok = reachableToDest(net, map.destination.node, closed);
  const interior = new Set<number>();
  for (const id of closedEdges) interior.add(net.edges[id]!.a).add(net.edges[id]!.b);
  for (const c of Object.values(map.courses)) {
    for (const de of c.des) {
      const e = net.edges[de >> 1]!;
      for (const n of [e.a, e.b]) if (!interior.has(n) && !ok[n]) return false;
    }
  }
  return true;
}

export function chooseClosure(map: WorldMap, rng: Rng, untilMs: number): { closure: Closure | null; tried: number } {
  const cands = [...closureCandidates(map)];
  for (let i = cands.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [cands[i], cands[j]] = [cands[j]!, cands[i]!];
  }
  const net = map.net;
  let tried = 0;
  for (const c of cands) {
    tried++;
    const edges = [...new Set(c.des.map((de) => de >> 1))];
    if (!closureLeavesRoutes(map, edges)) continue;
    // Barriers across the full carriageway at both ends (one-way: entry only).
    const first = c.des[0]!;
    const last = c.des[c.des.length - 1]!;
    const barrier = (de: number, s: number) => {
      const e = net.edges[de >> 1]!;
      const p = lanePoint(net, de, e.oneway ? (e.lanes - 1) / 2 : -0.5, s);
      return { x: +p.x.toFixed(2), z: +p.z.toFixed(2), heading: +deHeading(net, de).toFixed(4), width: +(e.halfWidth * 2 + 1).toFixed(1) };
    };
    const barriers = [barrier(first, Math.min(4, net.edges[first >> 1]!.length / 2))];
    if (!net.edges[last >> 1]!.oneway) barriers.push(barrier(last, Math.max(0, net.edges[last >> 1]!.length - 4)));
    return { closure: { id: `closure-${edges[0]}`, label: c.label, edges, barriers, untilMs }, tried };
  }
  return { closure: null, tried };
}
