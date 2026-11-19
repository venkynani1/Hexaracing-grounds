/**
 * Road network model. M2 ships a synthetic test grid; M5 replaces it with the OSM-derived Chennai graph
 * produced by tools/mapbuild in the SAME format (nodes, straight edges, lanes per direction).
 *
 * Traffic keeps LEFT (India). Lane 0 is the kerb (leftmost) lane.
 */
import { createRng } from '../rng';
import type { VehicleState } from './vehicle';

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  signal: boolean;
}
export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  lanes: number;
  speedLimit: number;
  length: number;
}
export interface RoadNetwork {
  version: string;
  nodes: RoadNode[];
  edges: RoadEdge[];
  laneWidth: number;
  /** Half the carriageway width (both directions) incl. shoulder. */
  halfWidth: number;
  /** Distance from a node centre to the stop line. */
  junctionRadius: number;
  /** Outgoing directed edges per node. */
  out: number[][];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** Directed edge: de = edgeId*2 (a→b) or edgeId*2+1 (b→a). */
export const deEdge = (de: number) => de >> 1;
export const deReverse = (de: number) => de ^ 1;

export function deEnds(net: RoadNetwork, de: number): { from: RoadNode; to: RoadNode } {
  const e = net.edges[de >> 1]!;
  const a = net.nodes[e.a]!;
  const b = net.nodes[e.b]!;
  return de & 1 ? { from: b, to: a } : { from: a, to: b };
}

export function deHeading(net: RoadNetwork, de: number): number {
  const { from, to } = deEnds(net, de);
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/** World point on lane `laneF` (may be fractional during lane changes) at distance s from the from-node. */
export function lanePoint(net: RoadNetwork, de: number, laneF: number, s: number) {
  const { from, to } = deEnds(net, de);
  const len = net.edges[de >> 1]!.length;
  const dx = (to.x - from.x) / len;
  const dz = (to.z - from.z) / len;
  // Left of travel direction = (−dz, dx)·(−1)? forward=(dx,dz); right=(dz,−dx); left=(−dz,dx).
  const off = (laneF + 0.5) * net.laneWidth;
  return { x: from.x + dx * s - dz * off, z: from.z + dz * s + dx * off, heading: Math.atan2(dx, dz) };
}

export function createTestNetwork(opts: { size?: number; spacing?: number } = {}): RoadNetwork {
  const size = opts.size ?? 4;
  const spacing = opts.spacing ?? 320;
  const half = ((size - 1) * spacing) / 2;
  const nodes: RoadNode[] = [];
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) nodes.push({ id: r * size + c, x: -half + c * spacing, z: -half + r * spacing, signal: false });
  const edges: RoadEdge[] = [];
  const add = (a: number, b: number) => {
    const na = nodes[a]!;
    const nb = nodes[b]!;
    edges.push({ id: edges.length, a, b, lanes: 2, speedLimit: 16, length: Math.hypot(nb.x - na.x, nb.z - na.z) });
  };
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) {
      if (c + 1 < size) add(r * size + c, r * size + c + 1);
      if (r + 1 < size) add(r * size + c, (r + 1) * size + c);
    }
  const out: number[][] = nodes.map(() => []);
  for (const e of edges) {
    out[e.a]!.push(e.id * 2);
    out[e.b]!.push(e.id * 2 + 1);
  }
  for (const n of nodes) n.signal = out[n.id]!.length >= 3;
  const laneWidth = 3.5;
  const halfWidth = 2 * laneWidth + 1;
  const margin = 80;
  return {
    version: `test-grid-${size}x${size}-${spacing}`,
    nodes,
    edges,
    laneWidth,
    halfWidth,
    junctionRadius: halfWidth + 2,
    out,
    bounds: { minX: -half - margin, maxX: half + margin, minZ: -half - margin, maxZ: half + margin },
  };
}

/** Distance from a point to the nearest road centreline. */
export function distanceToRoad(net: RoadNetwork, x: number, z: number): number {
  let best = Infinity;
  for (const e of net.edges) {
    const a = net.nodes[e.a]!;
    const b = net.nodes[e.b]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < best) best = d;
  }
  return best;
}

export function isOnRoad(net: RoadNetwork, x: number, z: number): boolean {
  return distanceToRoad(net, x, z) <= net.halfWidth;
}

/* ---------------- Traffic signals ---------------- */

export type SignalColor = 'G' | 'A' | 'R';
export type Axis = 'NS' | 'EW';
export const SIGNAL_TIMING = { greenMs: 20_000, amberMs: 3_000, allRedMs: 1_000 } as const;
export const SIGNAL_CYCLE_MS = 2 * (SIGNAL_TIMING.greenMs + SIGNAL_TIMING.amberMs + SIGNAL_TIMING.allRedMs);

export function axisOfHeading(heading: number): Axis {
  return Math.abs(Math.cos(heading)) >= Math.abs(Math.sin(heading)) ? 'NS' : 'EW';
}

/** Deterministic signal state from shared simulation time — identical on every client and the server. */
export function signalState(nodeId: number, axis: Axis, simMs: number, seed: string | number = 0): SignalColor {
  const offset = createRng(seed, `signal:${nodeId}`).int(SIGNAL_CYCLE_MS);
  const t = (((simMs + offset) % SIGNAL_CYCLE_MS) + SIGNAL_CYCLE_MS) % SIGNAL_CYCLE_MS;
  const { greenMs, amberMs, allRedMs } = SIGNAL_TIMING;
  const phaseLen = greenMs + amberMs + allRedMs;
  const mine = axis === 'NS' ? t < phaseLen : t >= phaseLen;
  if (!mine) return 'R';
  const local = axis === 'NS' ? t : t - phaseLen;
  return local < greenMs ? 'G' : local < greenMs + amberMs ? 'A' : 'R';
}

/* ---------------- City blocks & buildings (deterministic, original procedural) ---------------- */

export interface Building {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  tone: number;
}

export function generateBuildings(net: RoadNetwork, seed: string | number = 0): Building[] {
  const rng = createRng(seed, `buildings:${net.version}`);
  const xs = [...new Set(net.nodes.map((n) => n.x))].sort((a, b) => a - b);
  const zs = [...new Set(net.nodes.map((n) => n.z))].sort((a, b) => a - b);
  const setback = net.halfWidth + 7;
  const out: Building[] = [];
  for (let i = 0; i + 1 < xs.length; i++)
    for (let j = 0; j + 1 < zs.length; j++) {
      const x0 = xs[i]! + setback;
      const x1 = xs[i + 1]! - setback;
      const z0 = zs[j]! + setback;
      const z1 = zs[j + 1]! - setback;
      const lots = 3;
      const lw = (x1 - x0) / lots;
      const ld = (z1 - z0) / lots;
      for (let a = 0; a < lots; a++)
        for (let b = 0; b < lots; b++) {
          if (a === 1 && b === 1 && rng.next() < 0.6) continue; // courtyards / parks
          const w = lw * (0.6 + rng.next() * 0.3);
          const d = ld * (0.6 + rng.next() * 0.3);
          out.push({
            x: x0 + lw * (a + 0.5),
            z: z0 + ld * (b + 0.5),
            w,
            d,
            h: 8 + Math.floor(rng.next() * rng.next() * 70),
            tone: rng.next(),
          });
        }
    }
  return out;
}

export const CAR_RADIUS = 2.0;

/**
 * Resolve car vs buildings and world bounds. Returns corrected state + impact speed (m/s, along normal).
 * Shared so client prediction and server agree.
 */
export function resolveStatic(
  s: VehicleState,
  buildings: readonly Building[],
  bounds: RoadNetwork['bounds'],
): { state: VehicleState; impact: number } {
  let { x, z, vx, vz } = s;
  let impact = 0;
  const bounce = (nx: number, nz: number) => {
    const vn = vx * nx + vz * nz;
    if (vn < 0) {
      impact = Math.max(impact, -vn);
      vx -= 1.3 * vn * nx;
      vz -= 1.3 * vn * nz;
      vx *= 0.7;
      vz *= 0.7;
    }
  };
  for (const b of buildings) {
    const hx = b.w / 2;
    const hz = b.d / 2;
    if (Math.abs(x - b.x) > hx + CAR_RADIUS || Math.abs(z - b.z) > hz + CAR_RADIUS) continue;
    const cx = Math.max(b.x - hx, Math.min(x, b.x + hx));
    const cz = Math.max(b.z - hz, Math.min(z, b.z + hz));
    let dx = x - cx;
    let dz = z - cz;
    let d = Math.hypot(dx, dz);
    if (d >= CAR_RADIUS) continue;
    if (d < 1e-6) {
      // Centre inside the box: push out along the shallowest axis.
      const px = hx - Math.abs(x - b.x);
      const pz = hz - Math.abs(z - b.z);
      if (px < pz) (dx = Math.sign(x - b.x) || 1), (dz = 0);
      else (dx = 0), (dz = Math.sign(z - b.z) || 1);
      x = px < pz ? b.x + dx * (hx + CAR_RADIUS) : x;
      z = px < pz ? z : b.z + dz * (hz + CAR_RADIUS);
      bounce(dx, dz);
      continue;
    }
    const nx = dx / d;
    const nz = dz / d;
    x = cx + nx * CAR_RADIUS;
    z = cz + nz * CAR_RADIUS;
    bounce(nx, nz);
  }
  if (x < bounds.minX) (x = bounds.minX), bounce(1, 0);
  if (x > bounds.maxX) (x = bounds.maxX), bounce(-1, 0);
  if (z < bounds.minZ) (z = bounds.minZ), bounce(0, 1);
  if (z > bounds.maxZ) (z = bounds.maxZ), bounce(0, -1);
  return { state: impact > 0 || x !== s.x || z !== s.z ? { ...s, x, z, vx, vz } : s, impact };
}

/** Spawn grid: 2 lanes × N slots along one directed edge, 14 m apart (M5 moves this to per-location grids). */
export function spawnSlots(net: RoadNetwork, count: number, de = 0): { x: number; z: number; heading: number }[] {
  const len = net.edges[de >> 1]!.length;
  const slots = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 2);
    const s = len - net.junctionRadius - 8 - row * 14;
    slots.push(lanePoint(net, de, i % 2, Math.max(net.junctionRadius + 2, s)));
  }
  return slots;
}

export const SPAWN_DE = 0;
