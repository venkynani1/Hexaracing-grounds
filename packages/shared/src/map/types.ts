/**
 * World map format. The Chennai map is DERIVED from OpenStreetMap (© OpenStreetMap contributors, ODbL 1.0)
 * by tools/mapbuild; the test grid is synthetic. Both decode into the same runtime RoadNetwork.
 */
import { CLASS_SPEED, type RoadEdge, type RoadNetwork, type RoadNode } from '../sim/road';

export interface StartLocationDef {
  code: string;
  name: string;
  /** OSM element used to verify the location (e.g. "n249497729"), or "synthetic". */
  osm: string;
  lat: number | null;
  lon: number | null;
  x: number;
  z: number;
  node: number;
  /** true only if coordinates were matched to licensed map data AND a route to the destination exists. */
  verified: boolean;
  reason?: string;
  /** Spawn grid (≥ 6 slots) on a real road, facing along the course. */
  spawn: { x: number; z: number; heading: number }[];
}

export interface Checkpoint {
  id: string;
  /** Directed edge and distance along it. */
  de: number;
  s: number;
  x: number;
  z: number;
  /** Fraction of the course's reference time at which this gate sits (0.1 … 1.0). */
  frac: number;
}

export interface CourseDef {
  start: string;
  /** Disclosed intermediate landmarks of the course (route normalisation). */
  via: string[];
  des: number[];
  lengthM: number;
  refTimeS: number;
  /** The natural shortest-route reference time before normalisation (for transparency). */
  naturalTimeS: number;
  checkpoints: Checkpoint[];
}

/** A shared service station (location from OSM amenity=fuel; generic name, no brands). */
export interface StationDef {
  id: string;
  name: string;
  osm: string;
  /** Real-world distance from the pad to the OSM fuel station it represents (transparency). */
  osmDistanceM?: number;
  /** Pad centre (off the carriageway). */
  x: number;
  z: number;
  /** Road direction alongside the pad. */
  heading: number;
  /** Cars inside this radius of the pad centre, slow enough, enter the station. */
  radius: number;
  bays: { x: number; z: number; heading: number }[];
  /** Release point on the road, downstream. */
  exit: { x: number; z: number; heading: number };
}

export interface WorldMap {
  id: 'test' | 'chennai';
  version: string;
  net: RoadNetwork;
  /** World metres per real metre (uniform; disclosed in-game). */
  scale: number;
  anchor: { lat: number; lon: number; name: string; osm: string };
  attribution: string;
  source: string;
  verifiedAt: string | null;
  destination: { name: string; osm: string; lat: number; lon: number; x: number; z: number; node: number };
  starts: StartLocationDef[];
  waypoints: { id: string; label: string; node: number }[];
  courses: Record<string, CourseDef>;
  /** Squads per start location (spawn crowding). */
  maxSquadsPerStart: number;
  stations: StationDef[];
}

/** Compact JSON as written by tools/mapbuild. */
export interface MapJson {
  id: 'chennai';
  version: string;
  scale: number;
  anchor: WorldMap['anchor'];
  attribution: string;
  source: string;
  verifiedAt: string;
  laneWidth: number;
  bounds: [number, number, number, number];
  /** flat [x_dm, z_dm, signal(0|1)] */
  nodes: number[];
  /** flat [a, b, lanes, oneway(0|1), cls, nameIdx] */
  edges: number[];
  names: string[];
  destination: WorldMap['destination'];
  starts: StartLocationDef[];
  waypoints: WorldMap['waypoints'];
  courses: Record<string, CourseDef>;
  maxSquadsPerStart: number;
  stations: StationDef[];
}

export function edgeHalfWidth(lanes: number, oneway: boolean, laneWidth: number) {
  return (oneway ? (lanes * laneWidth) / 2 : lanes * laneWidth) + 1;
}

/** Build the runtime network from flat arrays (used by the decoder AND by mapbuild, so both agree exactly). */
export function buildNetwork(
  version: string,
  laneWidth: number,
  nodesFlat: number[],
  edgesFlat: number[],
  names: string[],
  bounds: [number, number, number, number],
): RoadNetwork {
  const nodes: RoadNode[] = [];
  for (let i = 0; i < nodesFlat.length; i += 3)
    nodes.push({ id: i / 3, x: nodesFlat[i]! / 10, z: nodesFlat[i + 1]! / 10, signal: nodesFlat[i + 2] === 1, radius: 0, axis: 0 });
  const edges: RoadEdge[] = [];
  for (let i = 0; i < edgesFlat.length; i += 6) {
    const [a, b, lanes, ow, cls, ni] = edgesFlat.slice(i, i + 6) as [number, number, number, number, number, number];
    const na = nodes[a]!;
    const nb = nodes[b]!;
    const oneway = ow === 1;
    edges.push({
      id: i / 6,
      a,
      b,
      lanes,
      oneway,
      cls,
      speedLimit: CLASS_SPEED[cls] ?? 12,
      length: Math.max(0.5, Math.hypot(nb.x - na.x, nb.z - na.z)),
      halfWidth: edgeHalfWidth(lanes, oneway, laneWidth),
      name: ni >= 0 ? names[ni] : undefined,
    });
  }
  const out: number[][] = nodes.map(() => []);
  const incident: number[][] = nodes.map(() => []);
  for (const e of edges) {
    out[e.a]!.push(e.id * 2);
    if (!e.oneway) out[e.b]!.push(e.id * 2 + 1);
    incident[e.a]!.push(e.id);
    incident[e.b]!.push(e.id);
  }
  for (const n of nodes) {
    const inc = incident[n.id]!;
    if (inc.length >= 3) n.radius = Math.max(...inc.map((id) => edges[id]!.halfWidth)) + 2;
    else n.signal = false; // signals only at real junctions
    const first = edges[inc[0] ?? -1];
    if (first) {
      const other = nodes[first.a === n.id ? first.b : first.a]!;
      n.axis = Math.atan2(other.x - n.x, other.z - n.z);
    }
  }
  const halfWidth = Math.max(...edges.map((e) => e.halfWidth), 4);
  return {
    version,
    nodes,
    edges,
    laneWidth,
    halfWidth,
    junctionRadius: halfWidth + 2,
    out,
    bounds: { minX: bounds[0], maxX: bounds[1], minZ: bounds[2], maxZ: bounds[3] },
  };
}

export function decodeMap(j: MapJson): WorldMap {
  return {
    id: j.id,
    version: j.version,
    net: buildNetwork(j.version, j.laneWidth, j.nodes, j.edges, j.names, j.bounds),
    scale: j.scale,
    anchor: j.anchor,
    attribution: j.attribution,
    source: j.source,
    verifiedAt: j.verifiedAt,
    destination: j.destination,
    starts: j.starts,
    waypoints: j.waypoints,
    courses: j.courses,
    maxSquadsPerStart: j.maxSquadsPerStart,
    stations: j.stations ?? [],
  };
}

/** Areas no procedural building may occupy (station pads). */
export function stationExclusions(map: { stations: StationDef[] }) {
  return map.stations.map((s) => ({ x: s.x, z: s.z, r: s.radius + 12 }));
}
