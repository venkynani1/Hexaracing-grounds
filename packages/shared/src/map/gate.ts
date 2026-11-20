/**
 * Hexaware Gate layout derived from the map (identical on server and client): the parking lot with one marked bay
 * per squad beside the final approach, and the Welcome Convoy path along the REAL final approach road.
 */
import { BALANCE } from '../balance';
import { coursePolyline } from '../sim/reference';
import type { WorldMap } from './types';

export interface GateLayout {
  gate: { x: number; z: number };
  heading: number;
  lot: { x: number; z: number; r: number };
  spots: { x: number; z: number; heading: number }[];
  /** Convoy path ending at the gate: cumulative distance d. */
  convoyPath: { x: number; z: number; d: number }[];
}

const cache = new WeakMap<WorldMap, GateLayout>();

export function gateLayout(map: WorldMap): GateLayout {
  const hit = cache.get(map);
  if (hit) return hit;
  const gateNode = map.net.nodes[map.destination.node]!;
  // Approach: the longest course (most squads' final roads coincide near the gate).
  const course = Object.values(map.courses).sort((a, b) => b.lengthM - a.lengthM || a.start.localeCompare(b.start))[0];
  let path: { x: number; z: number; d: number }[];
  if (course) {
    const pts = coursePolyline(map.net, course.des, 5);
    const L = pts[pts.length - 1]!.d;
    path = pts.filter((p) => p.d >= L - BALANCE.convoy.approachM).map((p) => ({ x: p.x, z: p.z, d: p.d - (L - BALANCE.convoy.approachM) }));
  } else {
    // Test grid fallback: straight approach from the south.
    path = Array.from({ length: 111 }, (_, i) => ({ x: gateNode.x, z: gateNode.z - BALANCE.convoy.approachM + i * 10, d: i * 10 }));
  }
  const end = path[path.length - 1]!;
  const prev = path[Math.max(0, path.length - 4)]!;
  const heading = Math.atan2(end.x - prev.x, end.z - prev.z);
  const fx = Math.sin(heading);
  const fz = Math.cos(heading);
  // Lot on the left of the approach (keep-left), set back from the road, just before the gate.
  const lx = end.x - fz * 34 - fx * 25;
  const lz = end.z + fx * 34 - fz * 25;
  const spots: GateLayout['spots'] = [];
  for (let i = 0; i < 30; i++) {
    const col = i % 6;
    const row = Math.floor(i / 6);
    const along = (col - 2.5) * 4; // across the lot, parallel to the road
    const back = (row - 2) * 8;
    spots.push({ x: +(lx + fx * along - fz * back).toFixed(2), z: +(lz + fz * along + fx * back).toFixed(2), heading: +heading.toFixed(4) });
  }
  const out: GateLayout = { gate: { x: end.x, z: end.z }, heading, lot: { x: lx, z: lz, r: 34 }, spots, convoyPath: path };
  cache.set(map, out);
  return out;
}

/** Position on the convoy path at distance s (clamped). */
export function pointOnPath(path: GateLayout['convoyPath'], s: number) {
  if (s <= 0) return { x: path[0]!.x, z: path[0]!.z, heading: Math.atan2(path[1]!.x - path[0]!.x, path[1]!.z - path[0]!.z) };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    if (b.d >= s) {
      const t = (s - a.d) / Math.max(1e-6, b.d - a.d);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, heading: Math.atan2(b.x - a.x, b.z - a.z) };
    }
  }
  const a = path[path.length - 2]!;
  const b = path[path.length - 1]!;
  return { x: b.x, z: b.z, heading: Math.atan2(b.x - a.x, b.z - a.z) };
}
