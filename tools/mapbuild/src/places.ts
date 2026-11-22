/**
 * OSM places → area names + roadside signs along every course (does NOT touch the road graph).
 * Input : tools/mapbuild/data/raw/chennai-places.json (places.py; © OpenStreetMap contributors, ODbL 1.0)
 *         packages/shared/src/map/chennai.map.json (projection anchor + scale, courses)
 * Output: packages/shared/src/map/chennai.places.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREA_RADIUS_M, AreaIndex, coursePolyline, decodeMap, nearestEdge, type AreaDef, type AreaKind, type MapJson, type PlacesJson, type RouteSign } from '@redline/shared';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RAW = path.join(ROOT, 'tools/mapbuild/data/raw/chennai-places.json');
const MAP = path.join(ROOT, 'packages/shared/src/map/chennai.map.json');
const OUT = path.join(ROOT, 'packages/shared/src/map/chennai.places.json');
const DEG = Math.PI / 180;
const R = 6371008.8;
const RANK: Record<AreaKind, number> = { city: 0, town: 1, suburb: 2, quarter: 3, neighbourhood: 4, village: 5, locality: 6, hamlet: 7 };

const json = JSON.parse(readFileSync(MAP, 'utf8')) as MapJson;
const map = decodeMap(json);
const { lat: LAT0, lon: LON0 } = json.anchor;
const S = json.scale;
const proj = (lat: number, lon: number) => ({ x: (lon - LON0) * DEG * R * Math.cos(LAT0 * DEG) * S, z: (lat - LAT0) * DEG * R * S });

const raw = JSON.parse(readFileSync(RAW, 'utf8')) as { places: { name: string; kind: AreaKind; lat: number; lon: number }[] };

// course polylines (5 m step → thin to ~50 m for the corridor test)
const polys = Object.entries(map.courses).map(([id, c]) => ({ id, pts: coursePolyline(map.net, c.des, 10), des: c.des }));
const corridor = polys.flatMap((p) => p.pts.filter((_, i) => i % 5 === 0));
const nearCorridor = (x: number, z: number, r: number) => corridor.some((p) => Math.abs(p.x - x) < r && Math.abs(p.z - z) < r && Math.hypot(p.x - x, p.z - z) < r);

// areas: project, keep those whose influence touches a course, de-duplicate names (keep the higher-rank kind)
const byName = new Map<string, AreaDef>();
for (const p of raw.places.sort((a, b) => RANK[a.kind] - RANK[b.kind])) {
  const name = p.name.replace(/\s+/g, ' ').trim();
  if (!name || /^\d/.test(name) || name.length > 28 || p.kind === 'city') continue; // the city name would swamp local areas
  const { x, z } = proj(p.lat, p.lon);
  const r = AREA_RADIUS_M[p.kind] * S;
  if (!nearCorridor(x, z, r)) continue;
  const prev = byName.get(name.toLowerCase());
  if (prev && Math.hypot(prev.x - x, prev.z - z) < 3000 * S) continue;
  byName.set(prev ? `${name.toLowerCase()}#${x | 0}` : name.toLowerCase(), { name, kind: p.kind, x: +x.toFixed(1), z: +z.toFixed(1), r: Math.round(r) });
}
const areas = [...byName.values()];
const index = new AreaIndex(areas);

// signs per course
const signs: RouteSign[] = [];
const MIN_AREA_STAY = 500 * S;
const NO_REPEAT = 2500 * S; // never re-sign an area this course signed in the last 2.5 km // the new area must hold for this long before a board is placed (no flicker at borders)
for (const { id, pts, des } of polys) {
  const course = map.courses[id]!;
  const total = pts[pts.length - 1]!.d;
  const at = (s: number) => {
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (pts[m]!.d < s) lo = m + 1;
      else hi = m;
    }
    return pts[lo]!;
  };
  /** a point on the LEFT verge of travel at distance s, clear of every carriageway */
  const verge = (s0: number) => {
    for (const ds of [0, 20, -20, 40, -40, 70, -70, 100, -100, 140, -140, 190, -190]) {
      const s = Math.max(0, Math.min(total, s0 + ds));
      const p = at(s);
      const q = at(Math.min(total, s + 15));
      const o = at(Math.max(0, s - 15));
      const h = Math.atan2(q.x - o.x, q.z - o.z);
      const e = map.net.edges[des[p.k]! >> 1]!;
      const fx = Math.sin(h);
      const fz = Math.cos(h);
      // lane point → centreline is ~half a lane to the right; the left kerb is halfWidth left of the centreline
      for (let extra = 2.5; extra <= 14; extra += 1.5) {
        const off = e.halfWidth - map.net.laneWidth * 0.5 + extra;
        const x = p.x - fz * off;
        const z = p.z + fx * off;
        if (nearestEdge(map.net, x, z, 60).clearance > 1.8) return { x: +x.toFixed(1), z: +z.toFixed(1), heading: +h.toFixed(4) };
      }
    }
    return null;
  };
  // place-name boards where the area changes
  let cur: string | null = null;
  let candidate: { name: string; s: number } | null = null;
  const signedAt = new Map<string, number>();
  for (let s = 0; s < total; s += 25) {
    const a = index.at(at(s).x, at(s).z)?.name ?? null;
    if (a === cur) {
      candidate = null;
      continue;
    }
    if (!candidate || candidate.name !== a) candidate = a ? { name: a, s } : null;
    if (candidate && s - candidate.s >= MIN_AREA_STAY) {
      cur = candidate.name;
      const last = signedAt.get(cur);
      const v = last !== undefined && candidate.s - last < NO_REPEAT ? null : verge(candidate.s + 20);
      if (v) signedAt.set(cur, candidate.s);
      if (v && candidate.s > 60) signs.push({ course: id, kind: 'place', ...v, s: Math.round(candidate.s + 20), title: cur, sub: `${((total - candidate.s) / 1000 / S).toFixed(0)} km to Hexaware` });
      candidate = null;
    }
  }
  // direction signs 120 m before every checkpoint: distance to Hexaware + the next area ahead
  for (const cp of course.checkpoints) {
    const s = Math.max(0, cp.frac * total - 120);
    const v = verge(s);
    if (!v) continue;
    let next: string | null = null;
    const here = index.at(at(s).x, at(s).z)?.name ?? null;
    for (let t = s + 500; t < total && !next; t += 250) {
      const n = index.at(at(t).x, at(t).z)?.name ?? null;
      if (n && n !== here) next = n;
    }
    const km = (total - s) / 1000 / S;
    signs.push({ course: id, kind: 'direction', ...v, s: Math.round(s), title: `Hexaware · Siruseri  ${km < 1 ? '<1' : km.toFixed(0)} km`, sub: next ? `Next: ${next}` : undefined });
  }
}

const out: PlacesJson = { mapVersion: json.version, attribution: '© OpenStreetMap contributors (ODbL 1.0)', areas, signs };
writeFileSync(OUT, JSON.stringify(out));
const per = Object.fromEntries(polys.map((p) => [p.id, signs.filter((s) => s.course === p.id).length]));
console.log(`areas=${areas.length} signs=${signs.length}`, per);
for (const p of polys) console.log(p.id, signs.filter((s) => s.course === p.id && s.kind === 'place').map((s) => s.title).join(' → '));
