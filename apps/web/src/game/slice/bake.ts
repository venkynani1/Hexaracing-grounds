/**
 * Baked lighting for static slice geometry (computed once at load, written into vertex colours).
 * light = sky·(hemisphere)·AO + sun·max(0, N·L)·shadow, shadow from soft (3-ray) tests against building
 * boxes, canopies and tree crowns. Static world materials are then unlit (disableLighting): no per-pixel
 * lighting, no shadow-map sampling — the single biggest mobile GPU saving. Only the cars are lit (PBR + IBL).
 */
export const SUN = (() => {
  // direction the light travels (down, from the south-west in the afternoon)
  const x = -0.42;
  const y = -0.78;
  const z = 0.46;
  const l = Math.hypot(x, y, z);
  return { x: x / l, y: y / l, z: z / l };
})();
/** towards the sun */
const L = { x: -SUN.x, y: -SUN.y, z: -SUN.z };

export interface Occluder {
  /** oriented box (buildings, canopies, walls) or sphere (tree crowns) */
  kind: 'box' | 'sphere';
  x: number;
  z: number;
  /** box half sizes in local x/z, y range */
  hw: number;
  hd: number;
  y0: number;
  y1: number;
  rot: number;
  /** sphere centre y + radius */
  cy: number;
  r: number;
  /** 0..1 how much light passes (foliage lets some through) */
  opacity: number;
}

export class OccluderIndex {
  private cells = new Map<string, Occluder[]>();
  private static C = 24;
  add(o: Occluder) {
    const ext = o.kind === 'box' ? Math.hypot(o.hw, o.hd) : o.r;
    // index the shadow-casting reach: the box plus its projection along the sun to the ground
    const h = o.kind === 'box' ? o.y1 : o.cy + o.r;
    const reach = (h / L.y) * Math.hypot(L.x, L.z);
    const x0 = Math.min(o.x, o.x - (SUN.x / Math.hypot(SUN.x, SUN.z)) * -reach) - ext;
    const x1 = Math.max(o.x, o.x - (SUN.x / Math.hypot(SUN.x, SUN.z)) * -reach) + ext;
    const z0 = Math.min(o.z, o.z - (SUN.z / Math.hypot(SUN.x, SUN.z)) * -reach) - ext;
    const z1 = Math.max(o.z, o.z - (SUN.z / Math.hypot(SUN.x, SUN.z)) * -reach) + ext;
    const C = OccluderIndex.C;
    for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++)
      for (let cz = Math.floor(z0 / C); cz <= Math.floor(z1 / C); cz++) {
        const k = `${cx},${cz}`;
        (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(o);
      }
  }
  at(x: number, z: number): Occluder[] {
    return this.cells.get(`${Math.floor(x / OccluderIndex.C)},${Math.floor(z / OccluderIndex.C)}`) ?? [];
  }
}

/** Fraction of sun visible from point p (0 = full shadow). */
function sunVisible(idx: OccluderIndex, px: number, py: number, pz: number): number {
  let vis = 0;
  const jit = [
    [0, 0],
    [0.035, 0.02],
    [-0.03, -0.025],
  ];
  for (const [jx, jz] of jit) {
    const dx = L.x + jx!;
    const dy = L.y;
    const dz = L.z + jz!;
    let t = 1;
    for (const o of idx.at(px, pz)) {
      if (o.kind === 'sphere') {
        // ray-sphere
        const ox = px - o.x;
        const oy = py - o.cy;
        const oz = pz - o.z;
        const b = ox * dx + oy * dy + oz * dz;
        const c = ox * ox + oy * oy + oz * oz - o.r * o.r;
        const dd = dx * dx + dy * dy + dz * dz;
        const disc = b * b - dd * c;
        if (disc > 0 && -b - Math.sqrt(disc) > 0) t *= 1 - o.opacity;
        continue;
      }
      // ray vs oriented box (slab test in box space)
      const cs = Math.cos(o.rot);
      const sn = Math.sin(o.rot);
      const rx = px - o.x;
      const rz = pz - o.z;
      const lx = rx * cs - rz * sn;
      const lz = rx * sn + rz * cs;
      const ldx = dx * cs - dz * sn;
      const ldz = dx * sn + dz * cs;
      let tmin = 0.05;
      let tmax = 1e9;
      const slab = (p: number, d: number, lo: number, hi: number) => {
        if (Math.abs(d) < 1e-6) return p >= lo && p <= hi;
        let a = (lo - p) / d;
        let b = (hi - p) / d;
        if (a > b) [a, b] = [b, a];
        tmin = Math.max(tmin, a);
        tmax = Math.min(tmax, b);
        return tmin <= tmax;
      };
      if (slab(lx, ldx, -o.hw, o.hw) && slab(lz, ldz, -o.hd, o.hd) && slab(py, dy, o.y0, o.y1)) t *= 1 - o.opacity;
      if (t <= 0.001) break;
    }
    vis += t;
  }
  return vis / jit.length;
}

export const LIGHT = {
  sun: [1.0, 0.92, 0.8] as const,
  sky: [0.5, 0.58, 0.7] as const,
  sunI: 1.25,
  skyI: 0.85,
};

/**
 * Bake vertex colours in place: col (albedo tint) × light. Yields to the browser every ~8 ms so loading never
 * freezes the page. `aoAt(x,y,z,ny)` returns ambient occlusion (1 = open).
 */
export async function bakeVertexColors(
  pos: number[],
  nrm: number[],
  col: number[],
  idx: OccluderIndex,
  aoAt: (x: number, y: number, z: number, ny: number) => number,
  rain = false,
): Promise<Float32Array> {
  const n = pos.length / 3;
  const out = new Float32Array(n * 4);
  let t0 = performance.now();
  const sunI = rain ? 0.28 : LIGHT.sunI;
  const skyI = rain ? 0.72 : LIGHT.skyI;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3]!;
    const y = pos[i * 3 + 1]!;
    const z = pos[i * 3 + 2]!;
    const nx = nrm[i * 3]!;
    const ny = nrm[i * 3 + 1]!;
    const nz = nrm[i * 3 + 2]!;
    const ndl = Math.max(0, nx * L.x + ny * L.y + nz * L.z);
    const sv = ndl > 0 ? sunVisible(idx, x + nx * 0.05, y + ny * 0.05, z + nz * 0.05) : 0;
    const ao = aoAt(x, y, z, ny);
    const hemi = 0.8 + 0.2 * ny;
    for (let c = 0; c < 3; c++) {
      const lit = LIGHT.sky[c]! * skyI * hemi * ao + LIGHT.sun[c]! * sunI * ndl * sv;
      out[i * 4 + c] = col[i * 3 + c]! * lit;
    }
    out[i * 4 + 3] = 1;
    if ((i & 255) === 0 && performance.now() - t0 > 8) {
      await new Promise((r) => setTimeout(r, 0));
      t0 = performance.now();
    }
  }
  return out;
}
