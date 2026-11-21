/**
 * Vertical-slice static world (Rajiv Gandhi Salai / OMR at the Taramani Link Road junction), styled from the
 * licensed OMR reference photographs in docs/reference/omr (CC-BY / CC-BY-SA / PD — see sources.json):
 * planted medians with shrubs, palms and twin-arm lights; black-and-white kerbs; brick footpaths; compound walls;
 * glass IT-park towers and plaster low-rise shops; rain trees; bus shelter; overhead direction sign; signals.
 *
 * Built ONCE, bounded, merged per material into a few spatial chunks; lighting baked into vertex colours
 * (bake.ts). Buildings are exactly the shared procedural collision boxes (server-consistent), dressed as modules.
 */
import { Color3, DynamicTexture, Mesh, MeshBuilder, StandardMaterial, Texture, Vector3, VertexData, type Scene } from '@babylonjs/core';
import { createRng, deHeading, deStop, edgesNear, lanePoint, type Building, type ProceduralBuildings, type RoadNetwork, type WorldMap } from '@redline/shared';
import { tiledCompressed } from '../render/assets';
import { bakeVertexColors, OccluderIndex, type Occluder } from './bake';
import type { Corridor } from './corridor';

type RGB = [number, number, number];
const CHUNK = 400;

/** Geometry with per-vertex albedo tint + normals (lighting is baked later). */
class G {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  v(x: number, y: number, z: number, n: [number, number, number], u: number, w: number, c: RGB) {
    this.pos.push(x, y, z);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(u, w);
    this.col.push(c[0], c[1], c[2]);
    return this.pos.length / 3 - 1;
  }
  /** upward quad strip with lengthwise subdivision (for baked shadow resolution) */
  ribbon(ax: number, az: number, bx: number, bz: number, o0: number, o1: number, y: number, tile: number, c: RGB, step = 3, lat = 1) {
    const L = Math.hypot(bx - ax, bz - az) || 1;
    const fx = (bx - ax) / L;
    const fz = (bz - az) / L;
    const lx = -fz;
    const lz = fx;
    const ns = Math.max(1, Math.ceil(L / step));
    const base = this.pos.length / 3;
    for (let i = 0; i <= ns; i++) {
      const s = (L * i) / ns;
      for (let j = 0; j <= lat; j++) {
        const o = o0 + ((o1 - o0) * j) / lat;
        const x = ax + fx * s + lx * o;
        const z = az + fz * s + lz * o;
        this.v(x, y, z, [0, 1, 0], x / tile, z / tile, c);
      }
    }
    const row = lat + 1;
    for (let i = 0; i < ns; i++)
      for (let j = 0; j < lat; j++) {
        const a = base + i * row + j;
        const b = a + row;
        this.tri(a, b, a + 1);
        this.tri(a + 1, b, b + 1);
      }
  }
  /** upward triangle (winding fixed so it faces +y) */
  tri(a: number, b: number, c: number) {
    const P = this.pos;
    const cross = (P[b * 3]! - P[a * 3]!) * (P[c * 3 + 2]! - P[a * 3 + 2]!) - (P[b * 3 + 2]! - P[a * 3 + 2]!) * (P[c * 3]! - P[a * 3]!);
    if (cross > 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }
  fan(cx: number, cz: number, ring: [number, number][], y: number, tile: number, c: RGB) {
    const o = this.v(cx, y, cz, [0, 1, 0], cx / tile, cz / tile, c);
    const s = this.pos.length / 3;
    for (const [x, z] of ring) this.v(x, y, z, [0, 1, 0], x / tile, z / tile, c);
    for (let i = 0; i < ring.length; i++) this.tri(o, s + i, s + ((i + 1) % ring.length));
  }
  /** vertical wall a→b, normal = right of a→b; vertical subdivision for baked AO/shadows */
  wall(ax: number, az: number, bx: number, bz: number, y0: number, y1: number, tu: number, tv: number, c: RGB, u0 = 0, vsteps = 1, hsteps = 1) {
    const L = Math.hypot(bx - ax, bz - az) || 1;
    const n: [number, number, number] = [(bz - az) / L, 0, -(bx - ax) / L];
    const base = this.pos.length / 3;
    for (let i = 0; i <= hsteps; i++)
      for (let j = 0; j <= vsteps; j++) {
        const t = i / hsteps;
        const y = y0 + ((y1 - y0) * j) / vsteps;
        this.v(ax + (bx - ax) * t, y, az + (bz - az) * t, n, u0 + (L * t) / tu, y / tv, c);
      }
    const row = vsteps + 1;
    for (let i = 0; i < hsteps; i++)
      for (let j = 0; j < vsteps; j++) {
        const a = base + i * row + j;
        const b = a + row;
        this.idx.push(a, a + 1, b + 1, a, b + 1, b);
      }
    return L;
  }
  /** oriented box: 4 walls + top (+ optional separate top geometry) */
  box(cx: number, cz: number, w: number, d: number, y0: number, y1: number, rot: number, tu: number, tv: number, c: RGB, top?: G, topC?: RGB, vsteps = 1) {
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const P = (lx: number, lz: number): [number, number] => [cx + lx * cs + lz * sn, cz - lx * sn + lz * cs];
    const p = [P(-w / 2, -d / 2), P(-w / 2, d / 2), P(w / 2, d / 2), P(w / 2, -d / 2)];
    let u = 0;
    for (let i = 0; i < 4; i++) {
      const a = p[i]!;
      const b = p[(i + 1) % 4]!;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      u += this.wall(a[0], a[1], b[0], b[1], y0, y1, tu, tv, c, u, vsteps, Math.max(1, Math.round(L / 6)));
    }
    const t = top ?? this;
    const s = t.pos.length / 3;
    for (const [x, z] of p) t.v(x, y1, z, [0, 1, 0], x / 8, z / 8, topC ?? c);
    t.tri(s, s + 1, s + 2);
    t.tri(s, s + 2, s + 3);
    return p;
  }
  get empty() {
    return !this.idx.length;
  }
}

export interface SliceStatic {
  meshes: Mesh[];
  occluders: OccluderIndex;
  /** dynamic signal heads (state updated per frame) */
  signals: { node: number; heading: number; x: number; z: number }[];
  stats: { vertices: number; triangles: number; meshes: number; bakeMs: number; buildMs: number };
  setWet(wet: boolean): void;
}

let useKtx2 = true;
export function setSliceKtx2(on: boolean) {
  useKtx2 = on;
}
function tiledTex(scene: Scene, file: string) {
  return tiledCompressed(scene, `tex/${file}`, useKtx2);
}

/** Unlit textured material: colour = texture × baked vertex light. Fog + tone mapping still apply. */
function unlit(scene: Scene, name: string, tex?: Texture | DynamicTexture | null, color = new Color3(1, 1, 1)) {
  const m = new StandardMaterial(name, scene);
  // With lighting disabled the standard shader outputs clamp(emissive) × texture × vertex colour.
  m.disableLighting = true;
  m.emissiveColor = color;
  m.diffuseColor = Color3.Black();
  if (tex) m.diffuseTexture = tex;
  m.specularColor = Color3.Black();
  return m;
}

function textTexture(scene: Scene, w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) {
  const t = new DynamicTexture(`txt-${w}x${h}-${Math.random()}`, { width: w, height: h }, scene, true);
  draw(t.getContext() as unknown as CanvasRenderingContext2D);
  t.update();
  return t;
}

export async function buildSlice(scene: Scene, map: WorldMap, cor: Corridor, pb: ProceduralBuildings, onProgress: (p: number) => void): Promise<SliceStatic> {
  resetSliceScratch();
  const t0 = performance.now();
  const net: RoadNetwork = map.net;
  const lw = net.laneWidth;
  const rng = createRng('slice', 'omr');
  // chunked geometry: key = chunk id + material
  const chunks = new Map<string, G>();
  const g = (mat: string, x: number, z: number) => {
    const k = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}|${mat}`;
    return chunks.get(k) ?? chunks.set(k, new G()).get(k)!;
  };
  const occ = new OccluderIndex();
  const occList: Occluder[] = [];
  const addOcc = (o: Partial<Occluder> & Pick<Occluder, 'kind' | 'x' | 'z'>) => {
    const full: Occluder = { hw: 0, hd: 0, y0: 0, y1: 0, rot: 0, cy: 0, r: 0, opacity: 1, ...o };
    occ.add(full);
    occList.push(full);
  };
  const edgeSet = new Set(cor.edges);
  const incident = new Map<number, number[]>();
  for (const id of cor.edges) for (const n of [net.edges[id]!.a, net.edges[id]!.b]) (incident.get(n) ?? incident.set(n, []).get(n)!).push(id);
  const isJunction = (n: number) => (incident.get(n)?.length ?? 0) >= 3 || net.nodes[n]!.signal;
  /** distance from (x,z) to the nearest carriageway other than `own` (minus its half width) */
  const clear = (x: number, z: number, own: number) => {
    let best = Infinity;
    for (const id of edgesNear(net, x, z, 16)) {
      if (id === own) continue;
      const e = net.edges[id]!;
      const a = net.nodes[e.a]!;
      const b = net.nodes[e.b]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const L2 = dx * dx + dz * dz;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2)) : 0;
      best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)) - e.halfWidth);
    }
    return best;
  };

  const ASPH: RGB = [1.45, 1.45, 1.5];
  const WHITE: RGB = [0.95, 0.95, 0.92];
  const YELLOW: RGB = [0.98, 0.78, 0.15];
  const PAVER_GREY: RGB = [0.95, 0.93, 0.9];
  const PAVER_RED: RGB = [1.0, 0.62, 0.52];
  const SOIL: RGB = [0.73, 0.56, 0.36];
  const MEDIAN_GRASS: RGB = [0.62, 0.82, 0.45];

  // ---------------------------------------------------------------- roads
  for (const id of cor.edges) {
    const e = net.edges[id]!;
    const A = net.nodes[e.a]!;
    const B = net.nodes[e.b]!;
    const L = e.length;
    if (L < 0.3) continue;
    const fx = (B.x - A.x) / L;
    const fz = (B.z - A.z) / L;
    const hw = e.halfWidth;
    const mx = (A.x + B.x) / 2;
    const mz = (A.z + B.z) / 2;
    g('asphalt', mx, mz).ribbon(A.x, A.z, B.x, B.z, -hw, hw, 0, 7, ASPH, 3, Math.max(2, Math.round(hw / 1.6)));
    const trim = (n: number) => (isJunction(n) ? Math.min(L * 0.45, Math.max(net.nodes[n]!.radius, hw) + 1.5) : 0);
    const t0e = trim(e.a);
    const t1e = trim(e.b);
    const seg = L - t0e - t1e;
    if (seg < 1.5) continue;
    const ax = A.x + fx * t0e;
    const az = A.z + fz * t0e;
    const bx = A.x + fx * (L - t1e);
    const bz = A.z + fz * (L - t1e);
    const paint = g('paint', mx, mz);
    const solid = (off: number, c: RGB, w = 0.15) => paint.ribbon(ax, az, bx, bz, off - w / 2, off + w / 2, 0.015, 4, c, 6, 1);
    const dashed = (off: number, dash = 3, gap = 5) => {
      for (let s = 1.5; s + dash < seg; s += dash + gap) {
        const x0 = ax + fx * s;
        const z0 = az + fz * s;
        paint.ribbon(x0, z0, x0 + fx * dash, z0 + fz * dash, off - 0.08, off + 0.08, 0.015, 4, WHITE, 3, 1);
      }
    };
    const major = e.cls <= 2;
    if (e.oneway) {
      const half = (e.lanes * lw) / 2;
      for (let k = 1; k < e.lanes; k++) dashed(-half + k * lw);
      if (major) (solid(half - 0.25, WHITE), solid(-half + 0.25, YELLOW));
    } else {
      dashed(0, 3, 3);
      for (let k = 1; k < e.lanes; k++) (dashed(k * lw), dashed(-k * lw));
      if (major) (solid(hw - 0.3, WHITE), solid(-hw + 0.3, WHITE));
    }

    // ---- kerbs, footpath, median, compound walls, furniture (clipped against other carriageways)
    const sideOK = (s: number, o0: number, o1: number) => {
      for (const o of [o0, (o0 + o1) / 2, o1]) {
        const x = ax + fx * s - fz * o;
        const z = az + fz * s + fx * o;
        if (clear(x, z, id) < 0.2) return false;
      }
      return true;
    };
    const runs = (o0: number, o1: number): [number, number][] => {
      const out: [number, number][] = [];
      let st = -1;
      for (let s = 0; s <= seg + 0.01; s += 2) {
        const ss = Math.min(s, seg);
        const ok = sideOK(ss, o0, o1);
        if (ok && st < 0) st = ss;
        if (!ok && st >= 0) (ss - 2 - st > 1 && out.push([st, ss - 2]), (st = -1));
      }
      if (st >= 0 && seg - st > 1) out.push([st, seg]);
      return out;
    };
    const P = (s: number, o: number): [number, number] => [ax + fx * s - fz * o, az + fz * s + fx * o];
    const kerbBlocks = (s0: number, s1: number, o: number, side: number, y = 0.2) => {
      // black/white kerb stones (OMR look): one textured strip per run (stripe texture, 1 m per stone)
      const k = g('kerb', mx, mz);
      const [x0, z0] = P(s0, o);
      const [x1, z1] = P(s1, o);
      const c: RGB = [1, 1, 1];
      const n = Math.max(1, Math.round((s1 - s0) / 4));
      if (side > 0) k.wall(x1, z1, x0, z0, 0, y, 2, 4, c, 0, 1, n);
      else k.wall(x0, z0, x1, z1, 0, y, 2, 4, c, 0, 1, n);
      const [a0x, a0z] = P(s0, 0);
      const [a1x, a1z] = P(s1, 0);
      const lo = Math.min(o, o + side * 0.25);
      const hi = Math.max(o, o + side * 0.25);
      const b = k.pos.length / 3;
      k.ribbon(a0x, a0z, a1x, a1z, lo, hi, y, 1, c, 4, 1);
      // ribbon UVs are world-planar; re-map to along-length so the stripes follow the kerb
      const L = s1 - s0;
      const ns = Math.max(1, Math.ceil(L / 4));
      for (let i = 0; i <= ns; i++) for (let j = 0; j <= 1; j++) k.uv[(b + i * 2 + j) * 2] = (L * i) / ns / 2;
    };
    const divided = e.oneway && e.cls <= 2;
    for (const side of [1, -1]) {
      const o = side * hw;
      if (side === -1 && divided) {
        // planted median: measure the gap to the opposite carriageway (cap 6 m), fill half of it
        const [px, pz] = P(seg / 2, -hw - 0.5);
        const gap = Math.max(1.2, Math.min(6, clear(px, pz, id) + 0.5));
        const mw = gap / 2 + 0.05;
        for (const [r0, r1] of runs(-hw - mw, -hw - 0.05)) {
          const [x0, z0] = P(r0, 0);
          const [x1, z1] = P(r1, 0);
          kerbBlocks(r0, r1, -hw, -1, 0.3);
          g('grass', mx, mz).ribbon(x0, z0, x1, z1, -hw - mw, -hw - 0.25, 0.28, 3, MEDIAN_GRASS, 3, 1);
          // shrubs (low clipped hedge clumps), palms, twin-arm median lights
          {
            // clipped hedge along the median (one low rounded strip, gaps for palms are natural variation)
            const ho = -hw - Math.min(mw * 0.55, 1.2);
            const hwid = Math.min(0.7, mw * 0.35);
            const hg = g('vc', mx, mz);
            const steps = Math.max(1, Math.round((r1 - r0) / 3));
            const base = hg.pos.length / 3;
            for (let i = 0; i <= steps; i++) {
              const sv = r0 + 0.5 + ((r1 - r0 - 1) * i) / steps;
              const h = 0.62 + 0.18 * Math.sin(sv * 1.7) + 0.08 * Math.sin(sv * 4.3);
              const tint = 0.9 + 0.12 * Math.sin(sv * 0.9);
              const cc: RGB = [0.24 * tint, 0.42 * tint, 0.17 * tint];
              for (const [o, y, nn] of [[ho + hwid, 0.3, 0.8], [ho + hwid * 0.6, h, 0.3], [ho - hwid * 0.6, h, -0.3], [ho - hwid, 0.3, -0.8]] as const) {
                const [px, pz] = P(sv, o);
                const lx = -fz * nn;
                const lz = fx * nn;
                hg.v(px, y, pz, [lx, 1 - Math.abs(nn) * 0.4, lz], 0, 0, cc);
              }
            }
            for (let i = 0; i < steps; i++)
              for (let j = 0; j < 3; j++) {
                const a = base + i * 4 + j;
                const b2 = a + 4;
                hg.idx.push(a, b2, a + 1, a + 1, b2, b2 + 1, a, a + 1, b2, a + 1, b2 + 1, b2);
              }
          }
          if (mw > 1) for (let s = r0 + 6 + rng.next() * 8; s < r1 - 4; s += 14 + rng.next() * 10) palms.push({ x: P(s, -hw - mw * 0.6)[0], z: P(s, -hw - mw * 0.6)[1], s: 0.85 + rng.next() * 0.35, r: rng.next() * 6.28 });
          for (let s = r0 + 10; s < r1 - 3; s += 34) {
            const [lx, lz] = P(s, -hw - mw + 0.02);
            lights.push({ x: lx, z: lz, yaw: Math.atan2(fx, fz) });
          }
        }
        continue;
      }
      if (e.cls >= 5) continue;
      const fp0 = o + side * 0.25;
      const fp1 = o + side * 3.0;
      const brick = rng.next() < 0.45 ? PAVER_RED : PAVER_GREY;
      for (const [r0, r1] of runs(Math.min(o, fp1), Math.max(o, fp1))) {
        kerbBlocks(r0, r1, o, side);
        const [x0, z0] = P(r0, 0);
        const [x1, z1] = P(r1, 0);
        g('pavers', mx, mz).ribbon(x0, z0, x1, z1, Math.min(fp0, fp1), Math.max(fp0, fp1), 0.2, 2.2, brick, 3, 1);
        // soil verge behind the footpath
        const v1 = o + side * 5.6;
        g('concrete', mx, mz).ribbon(x0, z0, x1, z1, Math.min(fp1, v1), Math.max(fp1, v1), 0.05, 5, SOIL, 4, 1);
        // rain trees on the verge (big shady canopies) — not on the kerb
        if (e.cls <= 3) for (let s = r0 + 5 + rng.next() * 10; s < r1 - 5; s += 26 + rng.next() * 24) {
          const [tx, tz] = P(s, o + side * 4.4);
          if (clear(tx, tz, id) > 3) trees.push({ x: tx, z: tz, s: 0.8 + rng.next() * 0.5, c: rng.next() });
        }
        if (major && side > 0)
          for (let s = r0 + 18; s < r1 - 3; s += 36) {
            const [lx, lz] = P(s, o + side * 0.6);
            sideLights.push({ x: lx, z: lz, yaw: Math.atan2(fx, fz) + Math.PI / 2 });
          }
      }
    }
    if (edgeSet.has(id) && e.id === 8409) busShelter = { e: id, ax, az, fx, fz, hw };
  }

  // ---------------------------------------------------------------- junctions (asphalt + stop lines + zebras + signals)
  const signals: SliceStatic['signals'] = [];
  for (const nid of cor.nodes) {
    const n = net.nodes[nid]!;
    const inc = incident.get(nid) ?? [];
    let maxHw = 0;
    for (const id of inc) maxHw = Math.max(maxHw, net.edges[id]!.halfWidth);
    const r = isJunction(nid) ? Math.max(n.radius, maxHw) : maxHw;
    const ring: [number, number][] = [];
    for (let i = 0; i < 20; i++) ring.push([n.x + Math.sin((i * Math.PI) / 10) * r, n.z + Math.cos((i * Math.PI) / 10) * r]);
    g('asphalt', n.x, n.z).fan(n.x, n.z, ring, 0.002, 7, ASPH);
    if (!n.signal) continue;
    for (const id of inc) {
      const e = net.edges[id]!;
      const de = e.b === nid ? id * 2 : e.oneway ? -1 : id * 2 + 1;
      if (de < 0) continue;
      const sStop = deStop(net, de);
      const h = deHeading(net, de);
      const hx = Math.sin(h);
      const hz = Math.cos(h);
      const from = e.b === nid ? net.nodes[e.a]! : net.nodes[e.b]!;
      const cx = from.x + hx * sStop;
      const cz = from.z + hz * sStop;
      const o0 = e.oneway ? -(e.lanes * lw) / 2 : 0;
      const o1 = e.oneway ? (e.lanes * lw) / 2 : e.lanes * lw;
      const p = g('paint', cx, cz);
      p.ribbon(cx - hx * 0.25, cz - hz * 0.25, cx + hx * 0.25, cz + hz * 0.25, o0, o1, 0.016, 4, WHITE, 1, 1);
      if (e.length - sStop > 4.5)
        for (let o = -e.halfWidth + 0.4; o < e.halfWidth - 0.4; o += 1.0) {
          const zx = cx + hx * 1.2;
          const zz = cz + hz * 1.2;
          p.ribbon(zx, zz, zx + hx * 3, zz + hz * 3, o, o + 0.5, 0.016, 4, WHITE, 1, 1);
        }
      const sp = lanePoint(net, de, e.oneway ? e.lanes - 0.1 : e.lanes + 0.4, sStop);
      signals.push({ node: nid, heading: h, x: sp.x, z: sp.z });
    }
  }
  onProgress(0.25);

  // ---------------------------------------------------------------- buildings (= shared collision boxes), modular dressing
  const blds: Building[] = [];
  const seen = new Set<Building>();
  for (let i = 0; i < cor.pts.length; i += 8) for (const b of pb.near(cor.pts[i]!.x, cor.pts[i]!.z, 240)) if (!seen.has(b)) (seen.add(b), blds.push(b));
  const SHOP: RGB[] = [[0.95, 0.25, 0.2], [0.15, 0.45, 0.85], [0.98, 0.75, 0.1], [0.2, 0.65, 0.35], [0.85, 0.85, 0.85]];
  const PASTEL: RGB[] = [[0.98, 0.94, 0.85], [0.99, 0.88, 0.7], [0.95, 0.85, 0.85], [0.85, 0.92, 0.97], [0.88, 0.95, 0.88], [0.97, 0.97, 0.95]];
  for (const b of blds) {
    const rot = b.rot ?? 0;
    const r2 = createRng('slice-bld', `${Math.round(b.x)}:${Math.round(b.z)}`);
    const roofC: RGB = [0.78, 0.77, 0.75];
    addOcc({ kind: 'box', x: b.x, z: b.z, hw: b.w / 2, hd: b.d / 2, y0: 0, y1: b.h, rot });
    if (b.h >= 28) {
      // IT tower: 2-storey stone podium, glass curtain wall above with spandrel bands, roof crown + plant room
      const podium = 7;
      g('concrete', b.x, b.z).box(b.x, b.z, b.w, b.d, -0.1, podium, rot, 6, 7, [0.9, 0.88, 0.84], g('concrete', b.x, b.z), roofC, 2);
      const mat = r2.next() < 0.5 ? 'glassA' : 'glassB';
      g(mat, b.x, b.z).box(b.x, b.z, b.w - 0.6, b.d - 0.6, podium, b.h, rot, 13, 13, [1, 1, 1], g('concrete', b.x, b.z), roofC, Math.ceil((b.h - podium) / 6));
      for (let y = podium + 3.6; y < b.h - 1; y += 3.6) g('concrete', b.x, b.z).box(b.x, b.z, b.w - 0.45, b.d - 0.45, y, y + 0.35, rot, 6, 7, [0.92, 0.92, 0.92]);
      g('concrete', b.x, b.z).box(b.x, b.z, b.w - 0.4, b.d - 0.4, b.h, b.h + 1.4, rot, 6, 7, [0.93, 0.93, 0.93], g('concrete', b.x, b.z), roofC);
      g('concrete', b.x, b.z).box(b.x, b.z, b.w * 0.35, b.d * 0.35, b.h + 1.4, b.h + 4.5, rot, 6, 7, [0.85, 0.85, 0.83], g('concrete', b.x, b.z), roofC);
    } else if (b.h >= 14) {
      const mat = r2.next() < 0.6 ? 'office' : 'apartment';
      g(mat, b.x, b.z).box(b.x, b.z, b.w, b.d, -0.1, b.h, rot, mat === 'office' ? 10 : 13, mat === 'office' ? 10 : 13, [1, 1, 1], g('concrete', b.x, b.z), roofC, Math.ceil(b.h / 4));
      for (let y = 3.3; y < b.h - 1; y += 3.3) g('concrete', b.x, b.z).box(b.x, b.z, b.w + 0.5, b.d + 0.5, y, y + 0.22, rot, 6, 7, [0.9, 0.89, 0.86]);
      g('concrete', b.x, b.z).box(b.x, b.z, b.w + 0.1, b.d + 0.1, b.h, b.h + 1.0, rot, 6, 7, [0.9, 0.9, 0.88], g('concrete', b.x, b.z), roofC);
      if (r2.next() < 0.6) tanks.push({ x: b.x + (r2.next() - 0.5) * b.w * 0.5, z: b.z + (r2.next() - 0.5) * b.d * 0.5, y: b.h + 1 });
    } else {
      // Chennai low-rise: shop floor (shutters + bright signboard band), plastered floors above, parapet, water tank
      const c = PASTEL[Math.floor(r2.next() * PASTEL.length)]!;
      g('shutter', b.x, b.z).box(b.x, b.z, b.w, b.d, -0.1, 3.2, rot, 3, 3.2, [1, 1, 1], undefined, undefined, 1);
      const sign = SHOP[Math.floor(r2.next() * SHOP.length)]!;
      g('sign', b.x, b.z).box(b.x, b.z, b.w + 0.3, b.d + 0.3, 3.2, 4.3, rot, b.w + 0.3, 1.1, sign);
      g('plaster', b.x, b.z).box(b.x, b.z, b.w, b.d, 4.3, b.h, rot, 8, 6.4, c, g('concrete', b.x, b.z), roofC, Math.max(1, Math.round((b.h - 4.3) / 3)));
      g('concrete', b.x, b.z).box(b.x, b.z, b.w + 0.1, b.d + 0.1, b.h, b.h + 0.9, rot, 6, 7, c, g('concrete', b.x, b.z), roofC);
      if (r2.next() < 0.8) tanks.push({ x: b.x + (r2.next() - 0.5) * b.w * 0.5, z: b.z + (r2.next() - 0.5) * b.d * 0.5, y: b.h + 0.9 });
    }
    // compound wall along the road-facing side (exactly in front of the building, so it never blocks open ground)
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const face = [-1, 1]
      .map((sgn) => ({ sgn, x: b.x + sgn * (b.w / 2 + 0.6) * cs, z: b.z - sgn * (b.w / 2 + 0.6) * sn }))
      .sort((p, q) => (clear(p.x, p.z, -1) as number) - (clear(q.x, q.z, -1) as number))[0]!;
    if (clear(face.x, face.z, -1) > 2.5 && clear(face.x, face.z, -1) < 9) {
      const half = b.d / 2;
      const ax = face.x - half * sn;
      const az = face.z - half * cs;
      const bx = face.x + half * sn;
      const bz = face.z + half * cs;
      const gate = 0.35 + r2.next() * 0.3;
      const wc: RGB = [0.92, 0.9, 0.84];
      const segs: [number, number][] = [[0, gate - 0.12], [gate + 0.12, 1]];
      for (const [t0, t1] of segs) {
        const x0 = ax + (bx - ax) * t0;
        const z0 = az + (bz - az) * t0;
        const x1 = ax + (bx - ax) * t1;
        const z1 = az + (bz - az) * t1;
        const wg = g('concrete', x0, z0);
        wg.wall(x0, z0, x1, z1, 0, 1.7, 3, 1.7, wc, 0, 2, Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / 3)));
        wg.wall(x1, z1, x0, z0, 0, 1.7, 3, 1.7, wc, 0, 2, Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / 3)));
      }
    }
  }
  onProgress(0.45);

  // ---------------------------------------------------------------- petrol station at its real OSM location
  const st = cor.station;
  if (st) {
    const half = Math.max(3, Math.min(8, clear(st.x, st.z, -1) - 0.4));
    const canW = Math.min(12, half * 2);
    const cs = Math.cos(st.heading);
    const sn = Math.sin(st.heading);
    const at = (dx: number, dz: number): [number, number] => [st.x + dx * cs + dz * sn, st.z - dx * sn + dz * cs];
    g('concrete', st.x, st.z).box(st.x, st.z, Math.min(16, half * 2), 34, -0.1, 0.12, st.heading, 4, 4, [0.9, 0.9, 0.9]);
    g('canopy', st.x, st.z).box(st.x, st.z, canW, 24, 5.4, 6.1, st.heading, canW, 0.7, [1, 1, 1], g('vc', st.x, st.z), [0.9, 0.9, 0.9]);
    addOcc({ kind: 'box', x: st.x, z: st.z, hw: canW / 2, hd: 12, y0: 5.4, y1: 6.1, rot: st.heading });
    for (const [dx, dz] of [[-canW / 2 + 1.2, -8], [canW / 2 - 1.2, -8], [-canW / 2 + 1.2, 8], [canW / 2 - 1.2, 8]] as const) {
      const [px, pz] = at(dx, dz);
      g('vc', px, pz).box(px, pz, 0.45, 0.45, 0, 5.4, st.heading, 1, 1, [0.92, 0.93, 0.95]);
    }
    for (const dz of [-5, 5]) {
      const [ix, iz] = at(0, dz);
      g('concrete', ix, iz).box(ix, iz, 1.3, 5, 0, 0.25, st.heading, 2, 2, [0.95, 0.95, 0.9]);
      for (const k of [-1.3, 1.3]) {
        const [px, pz] = at(0, dz + k);
        g('pump', px, pz).box(px, pz, 0.8, 0.7, 0.25, 2.0, st.heading, 0.8, 1.75, [1, 1, 1]);
      }
    }
    const [kx, kz] = at(-half + 2.5, 14);
    g('plaster', kx, kz).box(kx, kz, 4.5, 6, 0, 3.4, st.heading, 8, 6.4, [0.95, 0.95, 0.95], g('concrete', kx, kz), [0.8, 0.8, 0.8]);
    const [yx, yz] = at(-half + 0.8, -16);
    pylon = { x: yx, z: yz, yaw: st.heading };
  }
  onProgress(0.55);

  // ---------------------------------------------------------------- vegetation + furniture geometry (merged, baked)
  for (const t of trees) {
    // rain tree: short trunk splitting into a very wide, flat, layered canopy
    const tr = g('vc', t.x, t.z);
    tr.box(t.x, t.z, 0.6 * t.s, 0.6 * t.s, 0, 3.4 * t.s, t.c * 6, 1, 3, [0.62, 0.55, 0.47], undefined, undefined, 2);
    const leaves = g('vc', t.x, t.z);
    const blobs = 5;
    for (let k = 0; k < blobs; k++) {
      const a = (k / blobs) * Math.PI * 2 + t.c * 3;
      const rr = (k === 0 ? 0 : 3.1) * t.s;
      const cx = t.x + Math.cos(a) * rr;
      const cz = t.z + Math.sin(a) * rr;
      const cy = (k === 0 ? 6.6 : 5.9) * t.s;
      const r = (k === 0 ? 3.6 : 3.0) * t.s;
      const v = 0.85 + ((k * 37) % 10) / 40;
      blob(leaves, cx, cy, cz, r, r * 0.5, [0.24 * v + t.c * 0.05, 0.4 * v + t.c * 0.06, 0.16 * v], 7 + k + Math.floor(t.c * 50));
      addOcc({ kind: 'sphere', x: cx, z: cz, cy, r: r * 0.85, opacity: 0.85 });
    }
    for (const a of [0.4, 2.5, 4.4]) {
      const bx = t.x + Math.cos(a + t.c) * 1.2 * t.s;
      const bz = t.z + Math.sin(a + t.c) * 1.2 * t.s;
      tr.box((t.x + bx) / 2, (t.z + bz) / 2, 0.35 * t.s, 0.35 * t.s, 3.2 * t.s, 5.6 * t.s, a, 1, 2, [0.55, 0.49, 0.42]);
    }
  }
  for (const s of shrubs) {
    const c: RGB = [0.25 + s.c * 0.08, 0.42 + s.c * 0.1, 0.17];
    blob(g('vc', s.x, s.z), s.x, 0.3 + 0.22 * s.s, s.z, 0.8 * s.s, 0.42 * s.s, c, Math.floor(s.c * 100));
  }
  for (const p of palms) {
    const tr = g('vc', p.x, p.z);
    // slightly leaning ringed trunk
    let px = p.x;
    let pz = p.z;
    const lean = 0.06;
    for (let k = 0; k < 6; k++) {
      const nx = px + Math.cos(p.r) * lean * 1.4;
      const nz = pz + Math.sin(p.r) * lean * 1.4;
      tr.box((px + nx) / 2, (pz + nz) / 2, 0.42 - k * 0.025, 0.42 - k * 0.025, 0.28 + k * 1.4 * p.s, 0.28 + (k + 1) * 1.4 * p.s, p.r, 1, 1.4, [0.6, 0.53, 0.44]);
      px = nx;
      pz = nz;
    }
    const top = 0.28 + 6 * 1.4 * p.s;
    const fr = g('vc', px, pz);
    for (let k = 0; k < 10; k++) frond(fr, px, top, pz, (k / 10) * Math.PI * 2 + p.r, (3.2 + (k % 3) * 0.4) * p.s, [0.36, 0.55, 0.2]);
    addOcc({ kind: 'sphere', x: px, z: pz, cy: top - 0.6, r: 2.6 * p.s, opacity: 0.45 });
  }
  for (const l of lights) twinArmLight(g('vc', l.x, l.z), l.x, l.z, l.yaw, true);
  for (const l of sideLights) twinArmLight(g('vc', l.x, l.z), l.x, l.z, l.yaw, false);
  for (const tk of tanks) g('vc', tk.x, tk.z).box(tk.x, tk.z, 1.2, 1.2, tk.y, tk.y + 1.3, 0.4, 1, 1, [0.12, 0.12, 0.13], g('vc', tk.x, tk.z), [0.15, 0.15, 0.16]);
  if (busShelter) {
    const { ax, az, fx, fz, hw } = busShelter;
    const s = 40;
    const cx = ax + fx * s - -fz * 0;
    const ox = -fz * (hw + 2.2);
    const oz = fx * (hw + 2.2);
    const x = cx + ox;
    const z = az + fz * s + oz;
    const yaw = Math.atan2(fx, fz);
    g('canopy', x, z).box(x, z, 2.2, 8, 2.6, 2.75, yaw, 2.2, 0.15, [0.75, 0.15, 0.12], g('vc', x, z), [0.6, 0.6, 0.62]);
    for (const dz of [-3.6, 3.6]) {
      const px = x + Math.sin(yaw) * dz + Math.cos(yaw) * 0.8;
      const pz = z + Math.cos(yaw) * dz - Math.sin(yaw) * 0.8;
      g('vc', px, pz).box(px, pz, 0.12, 0.12, 0, 2.6, yaw, 1, 1, [0.85, 0.85, 0.88]);
    }
    const bx = x + Math.cos(yaw) * 0.85;
    const bz = z - Math.sin(yaw) * 0.85;
    g('adpanel', bx, bz).box(bx, bz, 0.12, 2.2, 0.4, 2.3, yaw, 0.12, 1.9, [1, 1, 1]);
    g('vc', x, z).box(x, z, 0.5, 5, 0.45, 0.55, yaw, 1, 1, [0.6, 0.6, 0.62]);
    addOcc({ kind: 'box', x, z, hw: 1.1, hd: 4, y0: 2.6, y1: 2.75, rot: yaw });
  }
  // overhead direction gantry ~150 m before the junction, across the northbound carriageway
  {
    const i = Math.max(0, cor.pts.findIndex((p) => p.d > cor.length * 0.6));
    const p = cor.pts[i]!;
    const q = cor.pts[Math.min(cor.pts.length - 1, i + 3)]!;
    const yaw = Math.atan2(q.x - p.x, q.z - p.z);
    const lx = -Math.cos(yaw);
    const lz = Math.sin(yaw);
    gantry = { x: p.x, z: p.z, yaw, lx, lz };
    for (const o of [-8.2, 8.2]) g('vc', p.x, p.z).box(p.x + lx * o, p.z + lz * o, 0.45, 0.45, 0, 7.6, yaw, 1, 1, [0.8, 0.82, 0.85]);
    g('vc', p.x, p.z).box(p.x, p.z, 17, 0.4, 7.2, 7.6, yaw + Math.PI / 2, 1, 1, [0.8, 0.82, 0.85]);
    addOcc({ kind: 'box', x: p.x, z: p.z, hw: 5.5, hd: 0.2, y0: 5.4, y1: 7.4, rot: yaw + Math.PI / 2 });
  }
  // ---------------------------------------------------------------- ground: dry grass / red soil grid (baked shadows + AO)
  {
    const R = cor.radius;
    const step = 24;
    for (let x0 = cor.center.x - R; x0 < cor.center.x + R; x0 += CHUNK)
      for (let z0 = cor.center.z - R; z0 < cor.center.z + R; z0 += CHUNK) {
        if (Math.hypot(x0 + CHUNK / 2 - cor.center.x, z0 + CHUNK / 2 - cor.center.z) > R + CHUNK * 0.7) continue;
        const gg = g('grass', x0 + CHUNK / 2, z0 + CHUNK / 2);
        const n = Math.ceil(CHUNK / step);
        const base = gg.pos.length / 3;
        for (let i = 0; i <= n; i++)
          for (let j = 0; j <= n; j++) {
            const x = x0 + i * step;
            const z = z0 + j * step;
            const tone = 0.85 + 0.3 * Math.sin(x * 0.013 + z * 0.021) * Math.sin(z * 0.017 - x * 0.007);
            gg.v(x, -0.06, z, [0, 1, 0], x / 9, z / 9, [0.95 * tone, 0.9 * tone, 0.78 * tone]);
          }
        for (let i = 0; i < n; i++)
          for (let j = 0; j < n; j++) {
            const a = base + i * (n + 1) + j;
            gg.tri(a, a + n + 1, a + 1);
            gg.tri(a + 1, a + n + 1, a + n + 2);
          }
      }
  }
  onProgress(0.65);

  // ---------------------------------------------------------------- materials
  const T = {
    asphalt: tiledTex(scene, 'asphalt_diff.webp'),
    pavers: tiledTex(scene, 'pavers_diff.webp'),
    concrete: tiledTex(scene, 'concrete_diff.webp'),
    grass: tiledTex(scene, 'grass_diff.webp'),
    glassA: tiledTex(scene, 'facade019a_diff.webp'),
    glassB: tiledTex(scene, 'facade001_diff.webp'),
    office: tiledTex(scene, 'facade006_diff.webp'),
    apartment: tiledTex(scene, 'facade018a_diff.webp'),
  };
  const plasterTex = textTexture(scene, 256, 256, (c) => {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, 256, 256);
    for (let f = 0; f < 2; f++) {
      const y = 22 + f * 128;
      for (let i = 0; i < 2; i++) {
        const x = 26 + i * 128;
        c.fillStyle = 'rgba(80,70,60,0.35)';
        c.fillRect(x - 6, y - 8, 88, 7);
        c.fillStyle = '#2f353c';
        c.fillRect(x, y, 76, 60);
        c.fillStyle = '#5f6b75';
        c.fillRect(x + 3, y + 3, 34, 54);
        c.fillRect(x + 39, y + 3, 34, 54);
        c.strokeStyle = 'rgba(25,25,25,0.85)';
        c.lineWidth = 2;
        for (let k = 1; k < 6; k++) (c.beginPath(), c.moveTo(x, y + k * 10), c.lineTo(x + 76, y + k * 10), c.stroke());
      }
    }
    const gr = c.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, 'rgba(70,55,40,0.16)');
    c.fillStyle = gr;
    c.fillRect(0, 0, 256, 256);
  });
  plasterTex.wrapU = plasterTex.wrapV = Texture.WRAP_ADDRESSMODE;
  const shutterTex = textTexture(scene, 128, 128, (c) => {
    c.fillStyle = '#7d8086';
    c.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 4) (c.fillStyle = y % 8 ? '#9a9da3' : '#6c6f75'), c.fillRect(6, y, 116, 2);
    c.fillStyle = '#3a3d42';
    c.fillRect(0, 0, 6, 128);
    c.fillRect(122, 0, 6, 128);
  });
  shutterTex.wrapU = shutterTex.wrapV = Texture.WRAP_ADDRESSMODE;
  const signTex = textTexture(scene, 512, 64, (c) => {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, 512, 64);
    c.fillStyle = 'rgba(255,255,255,0.95)';
    c.font = 'bold 38px system-ui, sans-serif';
    c.textAlign = 'center';
    const words = ['MOBILES', 'TIFFIN CENTRE', 'PHARMACY', 'SUPER MARKET', 'BAKERY', 'TEXTILES'];
    c.fillStyle = '#ffffff';
    c.fillText(words[Math.floor(Math.random() * words.length)]!, 256, 46);
  });
  const canopyTex = textTexture(scene, 256, 32, (c) => {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, 256, 32);
    c.fillStyle = '#0d6b3c';
    c.fillRect(0, 10, 256, 14);
  });
  const pumpTex = textTexture(scene, 64, 128, (c) => {
    c.fillStyle = '#e9ecef';
    c.fillRect(0, 0, 64, 128);
    c.fillStyle = '#0d6b3c';
    c.fillRect(0, 0, 64, 26);
    c.fillStyle = '#111';
    c.fillRect(12, 40, 40, 22);
    c.fillStyle = '#6ef0a0';
    c.font = 'bold 14px monospace';
    c.fillText('88.88', 13, 56);
  });
  const adTex = textTexture(scene, 64, 128, (c) => {
    const gr = c.createLinearGradient(0, 0, 0, 128);
    gr.addColorStop(0, '#1d6fd1');
    gr.addColorStop(1, '#0b2f63');
    c.fillStyle = gr;
    c.fillRect(0, 0, 64, 128);
    c.fillStyle = '#fff';
    c.font = 'bold 13px system-ui';
    c.fillText('CHENNAI', 4, 60);
    c.fillText('METRO', 10, 76);
  });
  const mats: Record<string, StandardMaterial> = {
    asphalt: unlit(scene, 's-asphalt', T.asphalt),
    vc: unlit(scene, 's-vc', null),
    paint: unlit(scene, 's-paint', null),
    kerb: unlit(
      scene,
      's-kerb',
      (() => {
        const t = textTexture(scene, 64, 8, (c) => {
          c.fillStyle = '#f2f2ee';
          c.fillRect(0, 0, 32, 8);
          c.fillStyle = '#1c1c1c';
          c.fillRect(32, 0, 32, 8);
        });
        t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
        return t;
      })(),
    ),
    pavers: unlit(scene, 's-pavers', T.pavers),
    soil: unlit(scene, 's-soil', T.concrete, new Color3(0.86, 0.72, 0.55)),
    grass: unlit(scene, 's-grass', T.grass),
    ground: unlit(scene, 's-ground', T.grass),
    stone: unlit(scene, 's-stone', T.concrete),
    roof: unlit(scene, 's-roof', T.concrete),
    glassA: unlit(scene, 's-glassA', T.glassA),
    glassB: unlit(scene, 's-glassB', T.glassB),
    office: unlit(scene, 's-office', T.office),
    apartment: unlit(scene, 's-apartment', T.apartment),
    plaster: unlit(scene, 's-plaster', plasterTex),
    plaster2: unlit(scene, 's-plaster2', T.concrete, new Color3(1, 0.97, 0.9)),
    shutter: unlit(scene, 's-shutter', shutterTex),
    sign: unlit(scene, 's-sign', signTex),
    concrete: unlit(scene, 's-concrete', T.concrete),
    canopy: unlit(scene, 's-canopy', canopyTex),
    canopyTop: unlit(scene, 's-canopyTop', null),
    metalTop: unlit(scene, 's-metalTop', null),
    metal: unlit(scene, 's-metal', null),
    pump: unlit(scene, 's-pump', pumpTex),
    adpanel: unlit(scene, 's-ad', adTex),
    bark: unlit(scene, 's-bark', null),
    leaf: unlit(scene, 's-leaf', null),
    tank: unlit(scene, 's-tank', null),
  };
  // emissive-ish signboards and ad panel stay bright in shade
  mats.paint!.zOffset = -1;
  for (const m of Object.values(mats)) m.freeze();

  // ---------------------------------------------------------------- bake + upload
  const aoAt = (x: number, y: number, z: number, ny: number) => {
    // ground darkens near building bases; walls darken near the ground
    if (ny > 0.5) {
      let ao = 1;
      for (const o of occ.at(x, z)) {
        if (o.kind !== 'box' || o.y0 > 1) continue;
        const cs = Math.cos(o.rot);
        const sn = Math.sin(o.rot);
        const lx = Math.abs((x - o.x) * cs - (z - o.z) * sn) - o.hw;
        const lz = Math.abs((x - o.x) * sn + (z - o.z) * cs) - o.hd;
        const d = Math.hypot(Math.max(0, lx), Math.max(0, lz));
        if (d < 3) ao = Math.min(ao, 0.55 + 0.45 * (d / 3));
      }
      return ao;
    }
    return 0.6 + 0.4 * Math.min(1, y / 3);
  };
  const meshes: Mesh[] = [];
  let verts = 0;
  let tris = 0;
  const tb = performance.now();
  const entries = [...chunks.entries()].filter(([, geo]) => !geo.empty);
  let done = 0;
  const baked = new Map<Mesh, { dry: Float32Array; wet: Float32Array | null; geo: G }>();
  for (const [key, geo] of entries) {
    const matName = key.split('|')[1]!;
    const dry = await bakeVertexColors(geo.pos, geo.nrm, geo.col, occ, aoAt);
    const m = new Mesh(`slice-${key}`, scene);
    const vd = new VertexData();
    vd.positions = geo.pos;
    vd.normals = geo.nrm;
    vd.uvs = geo.uv;
    vd.colors = dry;
    vd.indices = geo.idx;
    vd.applyToMesh(m, true);
    m.material = mats[matName]!;
    m.useVertexColors = true;
    m.isPickable = false;
    m.freezeWorldMatrix();
    m.doNotSyncBoundingInfo = true;
    meshes.push(m);
    baked.set(m, { dry, wet: null, geo });
    verts += geo.pos.length / 3;
    tris += geo.idx.length / 3;
    onProgress(0.65 + (0.35 * ++done) / entries.length);
  }
  const bakeMs = performance.now() - tb;

  // ---------------------------------------------------------------- dynamic-ish props: lamp heads, signs, signal lamps share tiny materials
  const lampMat = new StandardMaterial('s-lamp', scene);
  lampMat.disableLighting = true;
  lampMat.emissiveColor = new Color3(1, 0.97, 0.88);
  lampMat.freeze();
  if (gantry) {
    const t = textTexture(scene, 512, 160, (c) => {
      c.fillStyle = '#0f6b3a';
      c.fillRect(0, 0, 512, 160);
      c.strokeStyle = '#fff';
      c.lineWidth = 5;
      c.strokeRect(6, 6, 500, 148);
      c.fillStyle = '#fff';
      c.font = 'bold 34px system-ui, sans-serif';
      c.fillText('← Taramani', 22, 62);
      c.fillText('↑ Madhya Kailash', 22, 118);
      c.font = 'bold 26px system-ui, sans-serif';
      c.fillText('IT Expressway', 300, 62);
      c.fillText('Adyar', 360, 118);
    });
    const sm = new StandardMaterial('s-gantry', scene);
    sm.diffuseTexture = t;
    sm.emissiveColor = new Color3(0.9, 0.9, 0.9);
    sm.disableLighting = true;
    sm.backFaceCulling = false;
    sm.freeze();
    const board = MeshBuilder.CreatePlane('gantry-board', { width: 10, height: 3.1 }, scene);
    board.position.set(gantry.x, 6.1, gantry.z);
    board.rotation.y = gantry.yaw + Math.PI;
    board.material = sm;
    board.freezeWorldMatrix();
    meshes.push(board);
  }
  if (pylon) {
    const t = textTexture(scene, 128, 256, (c) => {
      c.fillStyle = '#0d5a33';
      c.fillRect(0, 0, 128, 256);
      c.fillStyle = '#fff';
      c.font = 'bold 34px system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText('FUEL', 64, 54);
      c.font = '600 18px system-ui, sans-serif';
      c.fillText('PETROL', 64, 120);
      c.fillText('DIESEL', 64, 160);
      c.fillText('AIR · WATER', 64, 200);
    });
    const sm = new StandardMaterial('s-pylon', scene);
    sm.diffuseTexture = t;
    sm.emissiveColor = new Color3(0.9, 0.9, 0.9);
    sm.disableLighting = true;
    sm.backFaceCulling = false;
    sm.freeze();
    const pl = MeshBuilder.CreatePlane('pylon', { width: 1.6, height: 3.2 }, scene);
    pl.position.set(pylon.x, 3.0, pylon.z);
    pl.rotation.y = pylon.yaw + Math.PI / 2;
    pl.material = sm;
    pl.freezeWorldMatrix();
    meshes.push(pl);
  }
  // lamp heads (emissive) — one merged mesh
  {
    const parts: Mesh[] = [];
    for (const l of [...lights.map((x) => ({ ...x, twin: true })), ...sideLights.map((x) => ({ ...x, twin: false }))]) {
      for (const side of l.twin ? [-1, 1] : [1]) {
        const h = MeshBuilder.CreateBox('lh', { width: 0.32, height: 0.08, depth: 0.7 }, scene);
        const ox = Math.sin(l.yaw + (side * Math.PI) / 2) * 2.3;
        const oz = Math.cos(l.yaw + (side * Math.PI) / 2) * 2.3;
        h.position.set(l.x + ox, 10.35, l.z + oz);
        h.rotation.y = l.yaw + Math.PI / 2;
        parts.push(h);
      }
    }
    if (parts.length) {
      const merged = Mesh.MergeMeshes(parts, true, true)!;
      merged.material = lampMat;
      merged.freezeWorldMatrix();
      merged.isPickable = false;
      meshes.push(merged);
    }
  }

  const wetCache = new Map<Mesh, Float32Array>();
  let wetNow = false;
  return {
    meshes,
    occluders: occ,
    signals,
    stats: { vertices: verts, triangles: tris, meshes: meshes.length, bakeMs: Math.round(bakeMs), buildMs: Math.round(performance.now() - t0) },
    setWet(wet: boolean) {
      if (wet === wetNow) return;
      wetNow = wet;
      // Overcast monsoon light: re-use the dry bake scaled toward the sky colour (no re-bake, no stall).
      for (const [m, b] of baked) {
        let w = wetCache.get(m);
        if (!w) {
          w = new Float32Array(b.dry.length);
          const surf = /asphalt|pavers|paint|kerb/.test(m.name);
          for (let i = 0; i < b.dry.length; i += 4) {
            const lum = (b.dry[i]! + b.dry[i + 1]! + b.dry[i + 2]!) / 3;
            const k = surf ? 0.52 : 0.62;
            w[i] = (b.dry[i]! * 0.55 + lum * 0.45) * k;
            w[i + 1] = (b.dry[i + 1]! * 0.55 + lum * 0.45) * k;
            w[i + 2] = (b.dry[i + 2]! * 0.55 + lum * 0.45) * k * 1.06;
            w[i + 3] = 1;
          }
          wetCache.set(m, w);
        }
        m.setVerticesData('color', wet ? w : b.dry, true);
      }
    },
  };

  // ---------------------------------------------------------------- helpers (hoisted)
  function blob(t: G, cx: number, cy: number, cz: number, r: number, ry: number, c: RGB, seed: number) {
    // low-poly irregular ellipsoid (2 latitude rings × 8) — solid geometry, no alpha test (cheap on tile GPUs)
    const rr = createRng('blob', String(seed));
    const ring = 8;
    const top = t.v(cx, cy + ry, cz, [0, 1, 0], 0, 0, [c[0] * 1.1, c[1] * 1.1, c[2] * 1.05]);
    const up: number[] = [];
    const mid: number[] = [];
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2 + seed;
      const k = 0.82 + rr.next() * 0.3;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      up.push(t.v(cx + nx * r * 0.72 * k, cy + ry * 0.62, cz + nz * r * 0.72 * k, [nx * 0.6, 0.8, nz * 0.6], 0, 0, [c[0] * 1.04, c[1] * 1.04, c[2]]));
      mid.push(t.v(cx + nx * r * k, cy + (rr.next() - 0.5) * ry * 0.25, cz + nz * r * k, [nx * 0.9, 0.2, nz * 0.9], 0, 0, c));
    }
    const bot = t.v(cx, cy - ry * 0.55, cz, [0, -1, 0], 0, 0, [c[0] * 0.65, c[1] * 0.65, c[2] * 0.65]);
    for (let i = 0; i < ring; i++) {
      const j = (i + 1) % ring;
      t.idx.push(top, up[j]!, up[i]!);
      t.idx.push(up[i]!, up[j]!, mid[j]!, up[i]!, mid[j]!, mid[i]!);
      t.idx.push(bot, mid[i]!, mid[j]!);
    }
  }
  function frond(t: G, x: number, y: number, z: number, yaw: number, len: number, c: RGB) {
    const dx = Math.cos(yaw);
    const dz = Math.sin(yaw);
    const px = -dz;
    const pz = dx;
    const base = t.pos.length / 3;
    const n = 6;
    for (let k = 0; k <= n; k++) {
      const s = k / n;
      const w = 0.5 * Math.sin(Math.PI * Math.min(1, s * 1.15)) + 0.04;
      const cx = x + dx * len * s;
      const cy = y + 0.7 * s - 2.3 * s * s;
      const cz = z + dz * len * s;
      t.v(cx + px * w, cy - 0.15 * w, cz + pz * w, [0, 1, 0], 0, 0, c);
      t.v(cx - px * w, cy - 0.15 * w, cz - pz * w, [0, 1, 0], 0, 0, c);
    }
    for (let k = 0; k < n; k++) {
      const a = base + k * 2;
      // double-sided by emitting both windings
      t.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3, a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  function twinArmLight(t: G, x: number, z: number, yaw: number, twin: boolean) {
    const c: RGB = [0.78, 0.8, 0.83];
    t.box(x, z, 0.36, 0.36, 0, 0.7, yaw, 1, 1, c);
    t.box(x, z, 0.2, 0.2, 0.7, 10.4, yaw, 1, 1, c, undefined, undefined, 2);
    for (const side of twin ? [-1, 1] : [1]) {
      const ox = Math.sin(yaw + (side * Math.PI) / 2);
      const oz = Math.cos(yaw + (side * Math.PI) / 2);
      for (let k = 0; k < 3; k++) {
        const a = 0.15 + k * 0.75;
        t.box(x + ox * (a + 0.37), z + oz * (a + 0.37), 0.1, 0.8, 10.2 + k * 0.08, 10.32 + k * 0.08, yaw + Math.PI / 2, 1, 1, c);
      }
    }
  }
}

// collected during the road pass, consumed later (module-level scratch reset per build)
let trees: { x: number; z: number; s: number; c: number }[] = [];
let shrubs: { x: number; z: number; s: number; c: number }[] = [];
let palms: { x: number; z: number; s: number; r: number }[] = [];
let lights: { x: number; z: number; yaw: number; twin?: boolean }[] = [];
let sideLights: { x: number; z: number; yaw: number }[] = [];
let tanks: { x: number; z: number; y: number }[] = [];
let busShelter: { e: number; ax: number; az: number; fx: number; fz: number; hw: number } | null = null;
let gantry: { x: number; z: number; yaw: number; lx: number; lz: number } | null = null;
let pylon: { x: number; z: number; yaw: number } | null = null;
export function resetSliceScratch() {
  trees = [];
  shrubs = [];
  palms = [];
  lights = [];
  sideLights = [];
  tanks = [];
  busShelter = null;
  gantry = null;
  pylon = null;
}
export { Vector3 };
