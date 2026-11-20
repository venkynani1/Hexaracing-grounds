/**
 * OSM extract → CODE REDLINE Chennai map.
 * Input : tools/mapbuild/data/raw/chennai-extract.json (from extract.py; © OpenStreetMap contributors, ODbL 1.0)
 * Output: packages/shared/src/map/chennai.map.json  (a Derivative Database under ODbL — attribution shipped with it)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BALANCE,
  CLASS_SPEED,
  buildNetwork,
  coursePolyline,
  deHeading,
  deStart,
  deStop,
  driveReference,
  lanePoint,
  nearestEdge,
  type CourseDef,
  type MapJson,
  type RoadNetwork,
  type StartLocationDef,
  type StationDef,
} from '@redline/shared';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RAW = path.join(ROOT, 'tools/mapbuild/data/raw/chennai-extract.json');
const OUT = path.join(ROOT, 'packages/shared/src/map/chennai.map.json');

interface RawWay {
  id: number;
  hw: string;
  name: string;
  ref: string;
  oneway: boolean;
  lanes: string;
  bridge: boolean;
  nodes: [number, number, number][];
}
interface RawFeature {
  key: string;
  osm: string;
  name: string;
  tags: Record<string, string>;
  lat: number;
  lon: number;
}
const raw = JSON.parse(readFileSync(RAW, 'utf8')) as {
  ways: RawWay[];
  signals: [number, number][];
  features: RawFeature[];
  source: string;
  fuel: { osm: string; lat: number; lon: number }[];
};

/* ---------- Verified reference features (exact OSM elements, chosen by inspection of the extract) ---------- */
const DEST_OSM = 'n6572344272'; // "Hexaware Technologies", office=it, SIPCOT IT Park Siruseri
const START_OSM: Record<string, { name: string; osm: string }> = {
  chennai_central: { name: 'Chennai Central', osm: 'n2481969291' }, // railway=station (Puratchi Thalaivar Dr. M.G. Ramachandran Central)
  guindy: { name: 'Guindy', osm: 'n249497729' }, // place=suburb
  velachery: { name: 'Velachery', osm: 'n14306417136' }, // place=suburb
  tambaram: { name: 'Tambaram', osm: 'n256196848' }, // place=city
  thiruvanmiyur: { name: 'Thiruvanmiyur', osm: 'n249497808' }, // place=suburb
  kelambakkam: { name: 'Kelambakkam', osm: 'n297473137' }, // place=town
  mahabalipuram: { name: 'Mahabalipuram', osm: 'n6187308686' }, // place=town (Mamallapuram)
};
const feature = (osm: string) => {
  const f = raw.features.find((x) => x.osm === osm);
  if (!f) throw new Error(`reference feature ${osm} missing from extract`);
  return f;
};
const dest = feature(DEST_OSM);
const LAT0 = dest.lat;
const LON0 = dest.lon;
const R = 6371008.8;
const DEG = Math.PI / 180;
const RADIUS_LIMIT_M = 60_000; // SPEC 2.1: within ~60 km of Hexaware
const SNAP_LIMIT_M = 1500;

const CLASS: Record<string, number> = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4,
  motorway_link: 5, trunk_link: 5, primary_link: 5, secondary_link: 5, tertiary_link: 5,
};

function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const a = Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ---------- Graph from OSM ways (real metres; scale applied at the end) ---------- */
function buildRawGraph() {
  const proj = (lat: number, lon: number) => ({ x: (lon - LON0) * DEG * R * Math.cos(LAT0 * DEG), z: (lat - LAT0) * DEG * R });
  const refs = new Map<number, number>();
  for (const w of raw.ways) w.nodes.forEach(([id], i) => refs.set(id, (refs.get(id) ?? 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1)));
  const nodes: { x: number; z: number; osm?: number }[] = [];
  const osmNode = new Map<number, number>();
  const getJ = (id: number, lat: number, lon: number) => {
    let n = osmNode.get(id);
    if (n === undefined) {
      n = nodes.length;
      nodes.push({ ...proj(lat, lon), osm: id });
      osmNode.set(id, n);
    }
    return n;
  };
  const edges: { a: number; b: number; lanes: number; oneway: boolean; cls: number; name: string }[] = [];
  for (const w of raw.ways) {
    const cls = CLASS[w.hw]!;
    const parsed = parseInt(w.lanes, 10);
    const lanes = Number.isFinite(parsed) ? (w.oneway ? Math.min(4, Math.max(1, parsed)) : Math.min(3, Math.max(1, Math.round(parsed / 2)))) : cls <= 2 ? 2 : 1;
    const name = w.name || w.ref;
    let seg: [number, number, number][] = [w.nodes[0]!];
    for (let i = 1; i < w.nodes.length; i++) {
      const nd = w.nodes[i]!;
      seg.push(nd);
      if (i === w.nodes.length - 1 || (refs.get(nd[0]) ?? 0) >= 2) {
        // Douglas–Peucker simplify the segment's interior (3 m).
        const pts = seg.map(([id, lat, lon]) => ({ id, ...proj(lat, lon), lat, lon }));
        const keep = simplify(pts, 3);
        let prev = getJ(pts[0]!.id, pts[0]!.lat, pts[0]!.lon);
        for (let k = 1; k < keep.length; k++) {
          const p = keep[k]!;
          const last = k === keep.length - 1;
          const cur = last ? getJ(p.id, p.lat, p.lon) : (nodes.push({ x: p.x, z: p.z }), nodes.length - 1);
          if (cur !== prev) edges.push({ a: prev, b: cur, lanes, oneway: w.oneway, cls, name });
          prev = cur;
        }
        seg = [nd];
      }
    }
  }
  return { nodes, edges };
}

function simplify<T extends { x: number; z: number }>(pts: T[], tol: number): T[] {
  if (pts.length <= 2) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = pts[i]!;
    const b = pts[j]!;
    let best = -1;
    let bd = tol;
    for (let k = i + 1; k < j; k++) {
      const p = pts[k]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const L = dx * dx + dz * dz;
      const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / L)) : 0;
      const d = Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
      if (d > bd) (bd = d), (best = k);
    }
    if (best > 0) {
      keep[best] = true;
      stack.push([i, best], [best, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Largest strongly connected component (iterative Tarjan) respecting one-way roads. */
function largestScc(n: number, edges: { a: number; b: number; oneway: boolean }[]) {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    adj[e.a]!.push(e.b);
    if (!e.oneway) adj[e.b]!.push(e.a);
  }
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  let idx = 0;
  let best: number[] = [];
  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue;
    const call: [number, number][] = [[s, 0]];
    while (call.length) {
      const top = call[call.length - 1]!;
      const [v, pi] = top;
      if (pi === 0) {
        index[v] = low[v] = idx++;
        stack.push(v);
        onStack[v] = 1;
      }
      const nbrs = adj[v]!;
      if (pi < nbrs.length) {
        top[1]++;
        const w = nbrs[pi]!;
        if (index[w] === -1) call.push([w, 0]);
        else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
        continue;
      }
      if (low[v] === index[v]) {
        const comp: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          comp.push(w);
        } while (w !== v);
        if (comp.length > best.length) best = comp;
      }
      call.pop();
      if (call.length) {
        const u = call[call.length - 1]![0];
        low[u] = Math.min(low[u]!, low[v]!);
      }
    }
  }
  return new Set(best);
}

/* ---------- Routing on the runtime network ---------- */
function dijkstra(net: RoadNetwork, from: number, to: number): number[] | null {
  const n = net.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prevDe = new Int32Array(n).fill(-1);
  dist[from] = 0;
  // binary heap
  const heap: [number, number][] = [[0, from]];
  const push = (d: number, v: number) => {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]![0] <= heap[i]![0]) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, v] = pop();
    if (d > dist[v]!) continue;
    if (v === to) break;
    for (const de of net.out[v]!) {
      const e = net.edges[de >> 1]!;
      const w = de & 1 ? e.a : e.b;
      const nd = d + e.length / e.speedLimit + (net.nodes[w]!.signal ? 6 : 0);
      if (nd < dist[w]!) {
        dist[w] = nd;
        prevDe[w] = de;
        push(nd, w);
      }
    }
  }
  if (!Number.isFinite(dist[to]!)) return null;
  const des: number[] = [];
  let v = to;
  while (v !== from) {
    const de = prevDe[v]!;
    des.push(de);
    const e = net.edges[de >> 1]!;
    v = de & 1 ? e.b : e.a;
  }
  return des.reverse();
}

const pathCost = (net: RoadNetwork, des: number[]) => des.reduce((t, de) => t + net.edges[de >> 1]!.length / net.edges[de >> 1]!.speedLimit, 0);
const pathLen = (net: RoadNetwork, des: number[]) => des.reduce((t, de) => t + net.edges[de >> 1]!.length, 0);

/* ---------- Build ---------- */
function build(scale: number) {
  const g = buildRawGraph();
  const keep = largestScc(g.nodes.length, g.edges);
  const remap = new Map<number, number>();
  const nodesFlat: number[] = [];
  const signalPts = raw.signals.map(([lat, lon]) => ({ x: (lon - LON0) * DEG * R * Math.cos(LAT0 * DEG), z: (lat - LAT0) * DEG * R }));
  // signal grid for matching
  const sg = new Map<string, { x: number; z: number }[]>();
  for (const p of signalPts) {
    const k = `${Math.floor(p.x / 50)},${Math.floor(p.z / 50)}`;
    (sg.get(k) ?? sg.set(k, []).get(k)!).push(p);
  }
  const nearSignal = (x: number, z: number) => {
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const p of sg.get(`${Math.floor(x / 50) + i},${Math.floor(z / 50) + j}`) ?? []) if (Math.hypot(p.x - x, p.z - z) < 30) return true;
    return false;
  };
  g.nodes.forEach((n, i) => {
    if (!keep.has(i)) return;
    remap.set(i, nodesFlat.length / 3);
    nodesFlat.push(Math.round(n.x * scale * 10), Math.round(n.z * scale * 10), n.osm !== undefined && nearSignal(n.x, n.z) ? 1 : 0);
  });
  const names: string[] = [];
  const nameIdx = new Map<string, number>();
  const edgesFlat: number[] = [];
  for (const e of g.edges) {
    const a = remap.get(e.a);
    const b = remap.get(e.b);
    if (a === undefined || b === undefined) continue;
    let ni = -1;
    if (e.name) {
      ni = nameIdx.get(e.name) ?? -1;
      if (ni < 0) nameIdx.set(e.name, (ni = names.push(e.name) - 1));
    }
    edgesFlat.push(a, b, e.lanes, e.oneway ? 1 : 0, e.cls, ni);
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < nodesFlat.length; i += 3) {
    minX = Math.min(minX, nodesFlat[i]! / 10);
    maxX = Math.max(maxX, nodesFlat[i]! / 10);
    minZ = Math.min(minZ, nodesFlat[i + 1]! / 10);
    maxZ = Math.max(maxZ, nodesFlat[i + 1]! / 10);
  }
  const bounds: [number, number, number, number] = [Math.floor(minX - 200), Math.ceil(maxX + 200), Math.floor(minZ - 200), Math.ceil(maxZ + 200)];
  const version = `chennai-osm-${raw.source.includes('tamil_nadu') ? 'tn' : 'x'}-s${scale.toFixed(3)}`;
  const net = buildNetwork(version, 3.5, nodesFlat, edgesFlat, names, bounds);
  return { net, nodesFlat, edgesFlat, names, bounds, version };
}

function snap(net: RoadNetwork, lat: number, lon: number, scale: number) {
  const x = (lon - LON0) * DEG * R * Math.cos(LAT0 * DEG) * scale;
  const z = (lat - LAT0) * DEG * R * scale;
  const ne = nearestEdge(net, x, z, SNAP_LIMIT_M * scale);
  if (ne.edge < 0) return null;
  const e = net.edges[ne.edge]!;
  const node = ne.t < 0.5 ? e.a : e.b;
  const n = net.nodes[node]!;
  return { x, z, node, snapM: Math.hypot(n.x - x, n.z - z) / scale };
}

function spawnGrid(net: RoadNetwork, des: number[]) {
  const pts = coursePolyline(net, des, 2);
  const slots: { x: number; z: number; heading: number }[] = [];
  const firstLanes = net.edges[des[0]! >> 1]!.lanes;
  for (let i = 0; i < BALANCE.maxSquads && slots.length < 6; i++) {
    // Staggered grid: lane-1 cars sit 7 m ahead of their lane-0 neighbour so no two cars start overlapping.
    const row = firstLanes >= 2 ? Math.floor(i / 2) : i;
    const lane = firstLanes >= 2 ? i % 2 : 0;
    const target = 12 + row * 14 + lane * 7;
    const p = pts.find((q) => q.d >= target);
    if (!p) break;
    const de = des[p.k]!;
    const e = net.edges[de >> 1]!;
    // distance along this de
    const a = net.nodes[de & 1 ? e.b : e.a]!;
    const s = Math.hypot(p.x - a.x, p.z - a.z);
    const lp = lanePoint(net, de, Math.min(lane, e.lanes - 1), Math.min(s, e.length));
    slots.push({ x: +lp.x.toFixed(2), z: +lp.z.toFixed(2), heading: +deHeading(net, de).toFixed(4) });
  }
  return slots;
}

function makeCourse(net: RoadNetwork, start: string, des: number[], via: string[], naturalTimeS: number): CourseDef {
  const pts = coursePolyline(net, des);
  const total = pts[pts.length - 1]!.d;
  // Fine distance marks → reference time at each, then invert to find equal-time checkpoint positions.
  const marks = Array.from({ length: 200 }, (_, i) => ((i + 1) / 200) * total);
  const ref = driveReference(net, des, { splitAtM: marks });
  const cps = [];
  for (let c = 1; c <= BALANCE.checkpointsPerCourse; c++) {
    const frac = c / BALANCE.checkpointsPerCourse;
    const tt = frac * ref.timeS;
    let m = ref.splits.findIndex((t) => t >= tt);
    if (m < 0) m = marks.length - 1;
    const d = c === BALANCE.checkpointsPerCourse ? total - 10 : marks[m]!;
    const p = pts.find((q) => q.d >= d) ?? pts[pts.length - 1]!;
    const de = des[p.k]!;
    const e = net.edges[de >> 1]!;
    const a = net.nodes[de & 1 ? e.b : e.a]!;
    cps.push({ id: `${start}-cp${c}`, de, s: +Math.hypot(p.x - a.x, p.z - a.z).toFixed(1), x: +p.x.toFixed(1), z: +p.z.toFixed(1), frac });
  }
  return { start, via, des, lengthM: Math.round(total), refTimeS: Math.round(ref.timeS), naturalTimeS: Math.round(naturalTimeS), checkpoints: cps };
}

function overlap(net: RoadNetwork, des: number[]) {
  const seen = new Set<number>();
  let dup = 0;
  for (const de of des) {
    const e = de >> 1;
    if (seen.has(e)) dup += net.edges[e]!.length;
    seen.add(e);
  }
  return dup / Math.max(1, pathLen(net, des));
}

function junctionLabel(net: RoadNetwork, node: number) {
  const names = new Set<string>();
  for (const e of net.edges) if ((e.a === node || e.b === node) && e.name) names.add(e.name);
  const list = [...names].slice(0, 2);
  return list.length ? `junction of ${list.join(' × ')}` : `junction ${node}`;
}

function refine(
  net: RoadNetwork,
  s: StartLocationDef,
  best: { des: number[]; via: string[]; est: number },
  destNode: number,
  ratio: number,
  T: number,
) {
  // Candidate junctions: signalised, on primary-or-better roads, within reach of the course, sampled deterministically.
  const majorNode = new Set<number>();
  for (const e of net.edges) if (e.cls <= 2) majorNode.add(e.a).add(e.b);
  const cands = net.nodes.filter((n) => n.signal && majorNode.has(n.id)).filter((_, i) => i % 2 === 0).slice(0, 160);
  const scored: { des: number[]; via: string[]; est: number }[] = [];
  // Try inserting into the current via list AND replacing it entirely (start → junction → destination).
  const bases: string[][] = [best.via, []];
  for (const baseVia of bases)
  for (const j of cands) {
    const stopsBase = [s.node, ...baseVia.map((v) => STOPS_BY_NAME.get(v)!), destNode];
    if (stopsBase.some((x) => x === undefined)) continue;
    for (let pos = 1; pos < stopsBase.length; pos++) {
      const stops = [...stopsBase.slice(0, pos), j.id, ...stopsBase.slice(pos)];
      let des: number[] = [];
      let ok = true;
      for (let i = 0; i + 1 < stops.length; i++) {
        const l = legCache(net, stops[i]!, stops[i + 1]!);
        if (!l) {
          ok = false;
          break;
        }
        des = des.concat(l);
      }
      if (!ok || overlap(net, des) > 0.3) continue;
      const via = [...baseVia];
      via.splice(pos - 1, 0, junctionLabel(net, j.id));
      scored.push({ des, via, est: pathCost(net, des) * ratio });
    }
  }
  scored.sort((a, b) => Math.abs(a.est - T) - Math.abs(b.est - T));
  let out = best;
  let err = Math.abs(best.est - T);
  for (const c of scored.slice(0, 8)) {
    const t = driveReference(net, c.des).timeS;
    if (Math.abs(t - T) < err) (err = Math.abs(t - T)), (out = { ...c, est: t });
  }
  return out;
}

const LEGS = new Map<string, number[] | null>();
function legCache(net: RoadNetwork, a: number, b: number) {
  const k = `${net.version}:${a}>${b}`;
  if (!LEGS.has(k)) LEGS.set(k, dijkstra(net, a, b));
  return LEGS.get(k)!;
}
const STOPS_BY_NAME = new Map<string, number>();

/**
 * Service stations: real OSM amenity=fuel LOCATIONS near the courses (no brand names). Every course gets one
 * station in each service-window band of its route (≈ 25–55 % and 60–90 % of reference time).
 */
function placeStations(net: RoadNetwork, courses: Record<string, CourseDef>, scale: number): StationDef[] {
  const fuel = raw.fuel.map((f) => ({ ...f, x: (f.lon - LON0) * DEG * R * Math.cos(LAT0 * DEG) * scale, z: (f.lat - LAT0) * DEG * R * scale }));
  const chosen = new Map<string, StationDef>();
  const bands: [number, number, number][] = [
    [0.25, 0.55, 0.4],
    [0.6, 0.9, 0.75],
  ];
  for (const c of Object.values(courses)) {
    const pts = coursePolyline(net, c.des, 10);
    const total = pts[pts.length - 1]!.d;
    for (const [lo, hi, mid] of bands) {
      let best: { f: (typeof fuel)[number]; p: (typeof pts)[number]; score: number; d: number } | null = null;
      for (const limit of [120, 300, 600]) {
        for (const f of fuel) {
          for (const p of pts) {
            const frac = p.d / total;
            if (frac < lo || frac > hi) continue;
            const d = Math.hypot(p.x - f.x, p.z - f.z);
            if (d > limit * scale) continue;
            const score = d + Math.abs(frac - mid) * 400;
            if (!best || score < best.score) best = { f, p, score, d };
          }
        }
        if (best) break;
      }
      if (!best) {
        // No mapped fuel station within 600 m: a clearly-labelled game facility at the band midpoint (never
        // presented as a real station).
        const p = pts.find((q) => q.d / total >= mid) ?? pts[pts.length - 1]!;
        best = { f: { osm: `game-facility-${c.start}-${mid}`, lat: 0, lon: 0, x: p.x, z: p.z }, p, score: 0, d: -1 };
        console.log(`[mapbuild] ${c.start}: no OSM fuel station within 600 m in band ${lo}-${hi} → game facility`);
      }
      if (chosen.has(best.f.osm)) continue;
      const de = c.des[best.p.k]!;
      const e = net.edges[de >> 1]!;
      const h = deHeading(net, de);
      const fx = Math.sin(h);
      const fz = Math.cos(h);
      // Pad on the LEFT of travel (keep-left: drivers pull in on their own side), 14 m beyond the road edge.
      const off = e.halfWidth + 14;
      const px = best.p.x - fz * off;
      const pz = best.p.z + fx * off;
      const a = net.nodes[de & 1 ? e.b : e.a]!;
      const s0 = Math.hypot(best.p.x - a.x, best.p.z - a.z);
      const exitS = Math.min(e.length - 1, s0 + 25);
      const ex = lanePoint(net, de, 0, exitS);
      const roadName = e.name ?? 'corridor';
      chosen.set(best.f.osm, {
        id: `st-${best.f.osm}`,
        name: best.d >= 0 ? `Redline Service — ${roadName}` : `Redline Service (game facility) — ${roadName}`,
        osm: best.f.osm,
        ...(best.d >= 0 ? { osmDistanceM: Math.round(best.d / scale) } : {}),
        x: +px.toFixed(1),
        z: +pz.toFixed(1),
        heading: +h.toFixed(4),
        radius: 14,
        bays: [-12, -4, 4, 12].map((d) => ({ x: +(px + fx * d - fz * 2).toFixed(1), z: +(pz + fz * d + fx * 2).toFixed(1), heading: +h.toFixed(4) })),
        exit: { x: +ex.x.toFixed(1), z: +ex.z.toFixed(1), heading: +h.toFixed(4) },
      });
    }
  }
  // De-duplicate names.
  const seen = new Map<string, number>();
  for (const st of chosen.values()) {
    const n = (seen.get(st.name) ?? 0) + 1;
    seen.set(st.name, n);
    if (n > 1) st.name = `${st.name} #${n}`;
  }
  return [...chosen.values()];
}

function main() {
  const T = BALANCE.courseTargetS;
  // Pass 1 at real scale: natural route times → choose the uniform scale (longest natural route = target).
  let scale = 1;
  let result: ReturnType<typeof attempt> | null = null;
  for (let pass = 0; pass < 3; pass++) {
    result = attempt(scale, T);
    const longest = Math.max(...Object.values(result.natural).map((n) => n.timeS));
    console.log(`[mapbuild] pass ${pass}: scale ${scale.toFixed(3)} longest natural ${(longest / 60).toFixed(1)} min`);
    if (Math.abs(longest - T) / T < 0.02 || longest <= T) break;
    scale = Math.min(1, scale * (T / longest));
  }
  const r = result!;
  const out: MapJson = {
    id: 'chennai',
    version: r.version,
    scale,
    anchor: { lat: LAT0, lon: LON0, name: dest.name, osm: DEST_OSM },
    attribution: '© OpenStreetMap contributors (ODbL 1.0)',
    source: `${raw.source}; roads motorway–tertiary within bbox 12.58–13.12 N, 80.05–80.32 E`,
    verifiedAt: new Date().toISOString(),
    laneWidth: 3.5,
    bounds: r.bounds,
    nodes: r.nodesFlat,
    edges: r.edgesFlat,
    names: r.names,
    destination: r.destination,
    starts: r.starts,
    waypoints: [
      { id: 'hexaware', label: 'Hexaware Gate', node: r.destination.node },
      ...r.starts.filter((s) => s.verified).map((s) => ({ id: s.code, label: s.name, node: s.node })),
    ],
    courses: r.courses,
    maxSquadsPerStart: 6,
    stations: placeStations(r.net, r.courses, scale),
  };
  console.log(`[mapbuild] ${out.stations.length} service stations: ${out.stations.filter((s) => s.osmDistanceM !== undefined).length} at real OSM fuel-station locations, ${out.stations.filter((s) => s.osmDistanceM === undefined).length} disclosed game facility`);
  writeFileSync(OUT, JSON.stringify(out));
  const kb = Math.round(JSON.stringify(out).length / 1024);
  console.log(`[mapbuild] wrote ${path.relative(ROOT, OUT)} (${kb} KB): ${r.net.nodes.length} nodes, ${r.net.edges.length} edges, scale ${scale.toFixed(3)}`);
  for (const c of Object.values(r.courses))
    console.log(`  ${c.start.padEnd(16)} natural ${(c.naturalTimeS / 60).toFixed(1)} min → course ${(c.refTimeS / 60).toFixed(1)} min, ${(c.lengthM / 1000).toFixed(1)} km via [${c.via.join(' → ')}]`);
  for (const s of r.starts) if (!s.verified) console.log(`  ${s.code}: NOT verified — ${s.reason}`);
}

function attempt(scale: number, T: number) {
  const b = build(scale);
  const net = b.net;
  const dsnap = snap(net, dest.lat, dest.lon, scale);
  if (!dsnap || dsnap.snapM > SNAP_LIMIT_M) throw new Error(`destination not on the road graph (${dsnap?.snapM} m)`);
  // The gate is the nearest drivable public-road node to the OSM office node (campus roads aren't in the graph).
  const destination = { name: 'Hexaware Technologies, Siruseri — campus road gate', osm: DEST_OSM, lat: dest.lat, lon: dest.lon, x: +dsnap.x.toFixed(1), z: +dsnap.z.toFixed(1), node: dsnap.node };
  const starts: StartLocationDef[] = [];
  const natural: Record<string, { des: number[]; timeS: number }> = {};
  for (const [code, ref] of Object.entries(START_OSM)) {
    const f = feature(ref.osm);
    const base = { code, name: ref.name, osm: ref.osm, lat: f.lat, lon: f.lon };
    const radius = haversine(f.lat, f.lon, dest.lat, dest.lon);
    const sn = snap(net, f.lat, f.lon, scale);
    let reason = '';
    if (radius > RADIUS_LIMIT_M) reason = `outside ${RADIUS_LIMIT_M / 1000} km radius (${(radius / 1000).toFixed(1)} km)`;
    else if (!sn || sn.snapM > SNAP_LIMIT_M) reason = `no drivable road within ${SNAP_LIMIT_M} m`;
    const des = !reason && sn ? dijkstra(net, sn.node, destination.node) : null;
    if (!reason && !des) reason = 'no route to Hexaware in the road graph';
    if (reason || !sn || !des) {
      starts.push({ ...base, x: sn?.x ?? 0, z: sn?.z ?? 0, node: sn?.node ?? -1, verified: false, reason, spawn: [] });
      continue;
    }
    const t = driveReference(net, des).timeS;
    natural[code] = { des, timeS: t };
    starts.push({ ...base, x: +sn.x.toFixed(1), z: +sn.z.toFixed(1), node: sn.node, verified: true, spawn: [] });
  }

  // Route normalisation: extend shorter routes through disclosed landmarks until reference time ≈ T.
  const landmarks = starts.filter((s) => s.verified);
  STOPS_BY_NAME.clear();
  for (const l of landmarks) STOPS_BY_NAME.set(l.name, l.node);
  const courses: Record<string, CourseDef> = {};
  for (const s of landmarks) {
    const nat = natural[s.code]!;
    let best = { des: nat.des, via: [] as string[], est: nat.timeS };
    const ratio = nat.timeS / pathCost(net, nat.des);
    if (nat.timeS < T * (1 - BALANCE.courseTolerance / 2)) {
      const legs = new Map<string, number[] | null>();
      const leg = (a: number, b: number) => {
        const k = `${a}>${b}`;
        if (!legs.has(k)) legs.set(k, dijkstra(net, a, b));
        return legs.get(k)!;
      };
      const cands: { des: number[]; via: string[]; est: number }[] = [];
      const others = landmarks.filter((l) => l.code !== s.code);
      const seqs: (typeof others)[] = [];
      for (const a of others) {
        seqs.push([a]);
        for (const c of others) if (c !== a) seqs.push([a, c]);
      }
      for (const seq of seqs) {
        const stops = [s.node, ...seq.map((x) => x.node), destination.node];
        let des: number[] = [];
        let ok = true;
        for (let i = 0; i + 1 < stops.length; i++) {
          const l = leg(stops[i]!, stops[i + 1]!);
          if (!l) {
            ok = false;
            break;
          }
          des = des.concat(l);
        }
        if (!ok) continue;
        if (overlap(net, des) > 0.3) continue;
        cands.push({ des, via: seq.map((x) => x.name), est: pathCost(net, des) * ratio });
      }
      cands.sort((a, b) => Math.abs(a.est - T) - Math.abs(b.est - T));
      // Exact reference time for the best few estimates.
      let bestErr = Math.abs(best.est - T);
      for (const c of cands.slice(0, 6)) {
        const t = driveReference(net, c.des).timeS;
        if (Math.abs(t - T) < bestErr) (bestErr = Math.abs(t - T)), (best = { des: c.des, via: c.via, est: t });
      }
    }
    // Refinement: insert one real signalised major junction (named by its roads) if still > 3% off target.
    if (Math.abs(best.est - T) / T > 0.03) best = refine(net, s, best, destination.node, ratio, T);
    const course = makeCourse(net, s.code, best.des, best.via, nat.timeS);
    courses[s.code] = course;
    s.spawn = spawnGrid(net, best.des);
    if (s.spawn.length < 6) {
      s.verified = false;
      s.reason = 'spawn grid has fewer than 6 slots';
    }
  }
  return { ...b, destination, starts, natural, courses };
}

main();
