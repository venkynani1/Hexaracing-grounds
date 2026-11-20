/**
 * Road network model. M2 ships a synthetic test grid; M5 replaces it with the OSM-derived Chennai graph
 * produced by tools/mapbuild in the SAME format (nodes, straight edges, lanes per direction).
 *
 * Traffic keeps LEFT (India). Lane 0 is the kerb (leftmost) lane.
 */
import { createRng } from '../rng';
import type { VehicleState } from './vehicle';
// (createRng above is also used by ProceduralBuildings)

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  signal: boolean;
  /** Distance from the node centre to the stop line / junction box edge (0 for a simple bend). */
  radius: number;
  /** Reference heading that splits approaches into the two signal groups. */
  axis: number;
}
/** Road class (lower = more major). */
export const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'link'] as const;
/** Reference cruising speed per class, m/s — used by traffic, the reference car and route calibration. */
export const CLASS_SPEED = [25, 22, 18, 15, 12, 11] as const;
export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  /** Lanes per direction (total lanes when one-way). */
  lanes: number;
  speedLimit: number;
  length: number;
  /** One-way edges may only be travelled a→b. */
  oneway: boolean;
  /** Half the paved width of this carriageway. */
  halfWidth: number;
  cls: number;
  name?: string;
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

/** Stop-line distances for a directed edge, clamped so short edges still work. */
export function deStart(net: RoadNetwork, de: number): number {
  const e = net.edges[de >> 1]!;
  const from = net.nodes[de & 1 ? e.b : e.a]!;
  return Math.min(from.radius, e.length * 0.45);
}
export function deStop(net: RoadNetwork, de: number): number {
  const e = net.edges[de >> 1]!;
  const to = net.nodes[de & 1 ? e.a : e.b]!;
  return e.length - Math.min(to.radius, e.length * 0.45);
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
  // forward=(dx,dz); left of travel=(−dz,dx). Two-way: lanes left of the centre line (keep left).
  // One-way: lanes laid symmetrically about the centre line, lane 0 leftmost.
  const e = net.edges[de >> 1]!;
  const off = e.oneway ? (laneF + 0.5) * net.laneWidth - (e.lanes * net.laneWidth) / 2 : (laneF + 0.5) * net.laneWidth;
  return { x: from.x + dx * s - dz * off, z: from.z + dz * s + dx * off, heading: Math.atan2(dx, dz) };
}

export function createTestNetwork(opts: { size?: number; spacing?: number } = {}): RoadNetwork {
  const size = opts.size ?? 4;
  const spacing = opts.spacing ?? 320;
  const half = ((size - 1) * spacing) / 2;
  const nodes: RoadNode[] = [];
  const laneWidth = 3.5;
  const halfWidth = 2 * laneWidth + 1;
  const junctionRadius = halfWidth + 2;
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      nodes.push({ id: r * size + c, x: -half + c * spacing, z: -half + r * spacing, signal: false, radius: junctionRadius, axis: 0 });
  const edges: RoadEdge[] = [];
  const add = (a: number, b: number) => {
    const na = nodes[a]!;
    const nb = nodes[b]!;
    edges.push({ id: edges.length, a, b, lanes: 2, speedLimit: 16, length: Math.hypot(nb.x - na.x, nb.z - na.z), oneway: false, halfWidth, cls: 2 });
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
  const margin = 80;
  return {
    version: `test-grid-${size}x${size}-${spacing}`,
    nodes,
    edges,
    laneWidth,
    halfWidth,
    junctionRadius,
    out,
    bounds: { minX: -half - margin, maxX: half + margin, minZ: -half - margin, maxZ: half + margin },
  };
}

/* ---------------- Spatial index (uniform grid of edges) ---------------- */

export const INDEX_CELL = 64;
interface RoadIndex {
  cells: Map<number, number[]>;
}
const indexCache = new WeakMap<RoadNetwork, RoadIndex>();
const cellKey = (cx: number, cz: number) => cx * 73856093 + cz * 19349663;

export function roadIndex(net: RoadNetwork): RoadIndex {
  let idx = indexCache.get(net);
  if (idx) return idx;
  idx = { cells: new Map() };
  for (const e of net.edges) {
    const a = net.nodes[e.a]!;
    const b = net.nodes[e.b]!;
    const pad = e.halfWidth + 2;
    const x0 = Math.floor((Math.min(a.x, b.x) - pad) / INDEX_CELL);
    const x1 = Math.floor((Math.max(a.x, b.x) + pad) / INDEX_CELL);
    const z0 = Math.floor((Math.min(a.z, b.z) - pad) / INDEX_CELL);
    const z1 = Math.floor((Math.max(a.z, b.z) + pad) / INDEX_CELL);
    for (let cx = x0; cx <= x1; cx++)
      for (let cz = z0; cz <= z1; cz++) {
        // Only cells the segment actually passes near (cheap distance test on the cell centre).
        const mx = (cx + 0.5) * INDEX_CELL;
        const mz = (cz + 0.5) * INDEX_CELL;
        if (segDist(mx, mz, a.x, a.z, b.x, b.z) > INDEX_CELL * 0.75 + pad) continue;
        const k = cellKey(cx, cz);
        let list = idx.cells.get(k);
        if (!list) idx.cells.set(k, (list = []));
        list.push(e.id);
      }
  }
  indexCache.set(net, idx);
  return idx;
}

function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const L = dx * dx + dz * dz;
  const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L)) : 0;
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

/** Edge ids whose carriageway may lie within `r` metres of (x, z). */
export function edgesNear(net: RoadNetwork, x: number, z: number, r = 0): number[] {
  const idx = roadIndex(net);
  const out = new Set<number>();
  const c0x = Math.floor((x - r) / INDEX_CELL);
  const c1x = Math.floor((x + r) / INDEX_CELL);
  const c0z = Math.floor((z - r) / INDEX_CELL);
  const c1z = Math.floor((z + r) / INDEX_CELL);
  for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) for (const id of idx.cells.get(cellKey(cx, cz)) ?? []) out.add(id);
  return [...out];
}

/** Nearest edge to a point: id, centreline distance and clearance (distance minus half width; ≤ 0 = on the road). */
export function nearestEdge(net: RoadNetwork, x: number, z: number, searchR = 200) {
  let best = { edge: -1, dist: Infinity, clearance: Infinity, t: 0 };
  for (const r of [0, INDEX_CELL, searchR]) {
    for (const id of edgesNear(net, x, z, r)) {
      const e = net.edges[id]!;
      const a = net.nodes[e.a]!;
      const b = net.nodes[e.b]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const L = dx * dx + dz * dz;
      const t = L > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L)) : 0;
      const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
      if (d - e.halfWidth < best.clearance) best = { edge: id, dist: d, clearance: d - e.halfWidth, t };
    }
    if (best.edge >= 0 && best.clearance < r) break;
  }
  return best;
}

/** Distance from a point to the nearest road centreline. */
export function distanceToRoad(net: RoadNetwork, x: number, z: number): number {
  return nearestEdge(net, x, z).dist;
}

export function isOnRoad(net: RoadNetwork, x: number, z: number): boolean {
  return nearestEdge(net, x, z, INDEX_CELL).clearance <= 0;
}

/* ---------------- Traffic signals ---------------- */

export type SignalColor = 'G' | 'A' | 'R';
export type Axis = 'NS' | 'EW';
export const SIGNAL_TIMING = { greenMs: 20_000, amberMs: 3_000, allRedMs: 1_000 } as const;
export const SIGNAL_CYCLE_MS = 2 * (SIGNAL_TIMING.greenMs + SIGNAL_TIMING.amberMs + SIGNAL_TIMING.allRedMs);

export function axisOfHeading(heading: number): Axis {
  return Math.abs(Math.cos(heading)) >= Math.abs(Math.sin(heading)) ? 'NS' : 'EW';
}

/** Signal group of an approach heading at a node (relative to the node's own axis, so skewed junctions work). */
export function signalGroup(net: RoadNetwork, nodeId: number, heading: number): Axis {
  return axisOfHeading(heading - net.nodes[nodeId]!.axis);
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
  /** Size along local x (after rotation) and local z. */
  w: number;
  d: number;
  h: number;
  tone: number;
  /** Rotation about Y (radians); 0 = axis aligned. */
  rot?: number;
}

export interface Exclusion {
  x: number;
  z: number;
  r: number;
}
const excluded = (ex: readonly Exclusion[], x: number, z: number, size: number) => ex.some((e) => Math.hypot(e.x - x, e.z - z) < e.r + size);

export function generateBuildings(net: RoadNetwork, seed: string | number = 0, exclusions: readonly Exclusion[] = []): Building[] {
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
          if (excluded(exclusions, x0 + lw * (a + 0.5), z0 + ld * (b + 0.5), Math.hypot(w, d) / 2)) continue;
          out.push({
            x: x0 + lw * (a + 0.5),
            z: z0 + ld * (b + 0.5),
            w,
            d,
            h: 8 + Math.floor(rng.next() * rng.next() * 70),
            tone: rng.next(),
            rot: 0,
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
    const br = Math.hypot(hx, hz) + CAR_RADIUS;
    if (Math.abs(x - b.x) > br || Math.abs(z - b.z) > br) continue;
    // Work in the building's local frame (oriented box).
    const c = Math.cos(b.rot ?? 0);
    const sn = Math.sin(b.rot ?? 0);
    const rx = x - b.x;
    const rz = z - b.z;
    const lx = rx * c - rz * sn;
    const lz = rx * sn + rz * c;
    if (Math.abs(lx) > hx + CAR_RADIUS || Math.abs(lz) > hz + CAR_RADIUS) continue;
    const cx = Math.max(-hx, Math.min(lx, hx));
    const cz = Math.max(-hz, Math.min(lz, hz));
    let dx = lx - cx;
    let dz = lz - cz;
    const d = Math.hypot(dx, dz);
    if (d >= CAR_RADIUS) continue;
    let nlx: number;
    let nlz: number;
    let px: number;
    let pz: number;
    if (d < 1e-6) {
      const ox = hx - Math.abs(lx);
      const oz = hz - Math.abs(lz);
      if (ox < oz) (nlx = Math.sign(lx) || 1), (nlz = 0), (px = nlx * (hx + CAR_RADIUS)), (pz = lz);
      else (nlx = 0), (nlz = Math.sign(lz) || 1), (px = lx), (pz = nlz * (hz + CAR_RADIUS));
    } else {
      nlx = dx / d;
      nlz = dz / d;
      px = cx + nlx * CAR_RADIUS;
      pz = cz + nlz * CAR_RADIUS;
    }
    // Back to world frame (inverse rotation).
    x = b.x + px * c + pz * sn;
    z = b.z - px * sn + pz * c;
    bounce(nlx * c + nlz * sn, -nlx * sn + nlz * c);
    dx = dz = 0;
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

/* ---------------- Procedural roadside buildings for real maps (original, deterministic) ---------------- */

export const BUILDING_CELL = 200;

/**
 * Generates original box buildings along both sides of every road, lazily per 200 m cell, identically on
 * server (collision) and client (render). Lots never encroach on any carriageway.
 */
export class ProceduralBuildings {
  private cache = new Map<number, Building[]>();
  constructor(
    private readonly net: RoadNetwork,
    private readonly seed: string | number,
    private readonly exclusions: readonly Exclusion[] = [],
    private readonly maxCells = 4000,
  ) {}

  cell(cx: number, cz: number): Building[] {
    const k = cellKey(cx, cz);
    const hit = this.cache.get(k);
    if (hit) return hit;
    const out = this.generate(cx, cz);
    if (this.cache.size >= this.maxCells) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(k, out);
    return out;
  }

  /** Buildings whose lots may lie within r of (x, z). */
  near(x: number, z: number, r = 40): Building[] {
    const out: Building[] = [];
    const c0x = Math.floor((x - r) / BUILDING_CELL);
    const c1x = Math.floor((x + r) / BUILDING_CELL);
    const c0z = Math.floor((z - r) / BUILDING_CELL);
    const c1z = Math.floor((z + r) / BUILDING_CELL);
    for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) for (const b of this.cell(cx, cz)) out.push(b);
    return out;
  }

  private generate(cx: number, cz: number): Building[] {
    const net = this.net;
    const x0 = cx * BUILDING_CELL;
    const z0 = cz * BUILDING_CELL;
    const out: Building[] = [];
    const LOT = 26;
    for (const id of edgesNear(net, x0 + BUILDING_CELL / 2, z0 + BUILDING_CELL / 2, BUILDING_CELL * 0.75 + 40)) {
      const e = net.edges[id]!;
      if (e.cls === 0) continue; // no frontage on motorways
      const a = net.nodes[e.a]!;
      const b = net.nodes[e.b]!;
      const fx = (b.x - a.x) / e.length;
      const fz = (b.z - a.z) / e.length;
      const rot = Math.atan2(fx, fz);
      const ra = Math.min(a.radius, e.length * 0.45) + 10;
      const rb = e.length - Math.min(b.radius, e.length * 0.45) - 10;
      for (let k = Math.ceil(ra / LOT); k * LOT <= rb; k++) {
        const s = k * LOT;
        for (const side of [-1, 1]) {
          const rng = createRng(this.seed, `bld:${id}:${k}:${side}`);
          if (rng.next() < 0.18) continue; // gaps: plots, gates, side streets
          const w = 12 + rng.next() * 10; // along road
          const d = 12 + rng.next() * 14; // depth
          const off = e.halfWidth + 6 + d / 2;
          // left of travel = (−fz, fx)
          const x = a.x + fx * s - fz * off * side;
          const z = a.z + fz * s + fx * off * side;
          if (x < x0 || x >= x0 + BUILDING_CELL || z < z0 || z >= z0 + BUILDING_CELL) continue; // owned by another cell
          // Keep every carriageway (incl. other roads) clear.
          const n = nearestEdge(net, x, z, 60);
          if (n.clearance < Math.hypot(w, d) / 2 + 3) continue;
          if (excluded(this.exclusions, x, z, Math.hypot(w, d) / 2)) continue;
          const tall = rng.next();
          out.push({ x, z, w: d, d: w, h: 6 + Math.floor(tall * tall * tall * 45), tone: rng.next(), rot });
        }
      }
    }
    return out;
  }
}
