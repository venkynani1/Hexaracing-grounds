/**
 * Vertical-slice corridor: a bounded ~800 m stretch of the real Rajiv Gandhi Salai (OMR, Perungudi/Taramani)
 * from the OSM graph — divided 3+3 lane carriageways, the signalised Taramani Link Road junction and the
 * real petrol-station location ("Rajiv Gandhi Salai #2" in the station list).
 * Pure data selection (no rendering). The slice is visual only; driving uses the shared physics on the full graph.
 */
import { coursePolyline, lanePoint, type RoadNetwork, type StationDef, type WorldMap } from '@redline/shared';

export interface Corridor {
  /** directed edges forming the drive path (northbound carriageway), in order */
  path: number[];
  /** centreline samples of the drive path */
  pts: { x: number; z: number; d: number }[];
  length: number;
  /** every edge rendered in the slice */
  edges: number[];
  /** every node rendered in the slice */
  nodes: number[];
  station: StationDef | null;
  center: { x: number; z: number };
  /** bounding radius around the centre */
  radius: number;
  start: { x: number; z: number; heading: number };
}

const STATION_ID = 'st-n1275649007';
/** Northbound OMR carriageway edges past the station and through the Taramani junction (from the OSM graph). */
/** ≈ 805 m: past the petrol station, through the signalised Taramani Link Road junction (≈ 625 m) and beyond. */
const PATH_EDGES = [8409, 8410, 8411, 8412, 23180, 22173, 22174, 23179, 21249, 15689, 21294];

function directed(net: RoadNetwork, ids: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const e = net.edges[ids[i]!]!;
    const next = net.edges[ids[i + 1] ?? -1];
    const prevEnd = out.length ? (() => { const p = net.edges[out[out.length - 1]! >> 1]!; return out[out.length - 1]! & 1 ? p.a : p.b; })() : -1;
    let forward = true;
    if (prevEnd >= 0) forward = e.a === prevEnd;
    else if (next) forward = e.b === next.a || e.b === next.b;
    out.push(e.id * 2 + (forward ? 0 : 1));
  }
  return out;
}

export function buildCorridor(map: WorldMap, margin = 260): Corridor {
  const net = map.net;
  const ok = PATH_EDGES.every((id) => net.edges[id]);
  if (!ok) throw new Error('slice corridor edges not found in this map build');
  const path = directed(net, PATH_EDGES);
  const raw = coursePolyline(net, path, 4);
  const pts = raw.map((p) => ({ x: p.x, z: p.z, d: p.d }));
  const length = pts[pts.length - 1]!.d;
  const near = (x: number, z: number, r: number) => {
    for (let i = 0; i < pts.length; i += 3) if (Math.hypot(pts[i]!.x - x, pts[i]!.z - z) < r) return true;
    return false;
  };
  const edges: number[] = [];
  for (const e of net.edges) {
    const a = net.nodes[e.a]!;
    const b = net.nodes[e.b]!;
    if (near(a.x, a.z, margin) || near(b.x, b.z, margin) || near((a.x + b.x) / 2, (a.z + b.z) / 2, margin)) edges.push(e.id);
  }
  const nodeSet = new Set<number>();
  for (const id of edges) (nodeSet.add(net.edges[id]!.a), nodeSet.add(net.edges[id]!.b));
  let cx = 0;
  let cz = 0;
  for (const p of pts) (cx += p.x), (cz += p.z);
  cx /= pts.length;
  cz /= pts.length;
  let radius = 0;
  for (const p of pts) radius = Math.max(radius, Math.hypot(p.x - cx, p.z - cz));
  const s0 = lanePoint(net, path[0]!, 1, 8);
  return {
    path,
    pts,
    length,
    edges,
    nodes: [...nodeSet],
    station: map.stations.find((s) => s.id === STATION_ID) ?? null,
    center: { x: cx, z: cz },
    radius: radius + margin,
    start: { x: s0.x, z: s0.z, heading: s0.heading },
  };
}
