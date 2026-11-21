/** Tiny geometry accumulator for merged per-cell meshes. */
import { Mesh, VertexData, type Material, type Scene } from '@babylonjs/core';

export class Geo {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] | null = null;
  idx: number[] = [];

  get empty() {
    return this.idx.length === 0;
  }

  private v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, w: number, c?: [number, number, number]) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, w);
    if (c) (this.col ??= []).push(c[0], c[1], c[2], 1);
    return this.pos.length / 3 - 1;
  }

  /** Horizontal quad (corners in order), planar world UVs (u = x / tile, v = z / tile). Faces up. */
  flat(pts: [number, number][], y: number, tile: number) {
    const base = this.pos.length / 3;
    for (const [x, z] of pts) this.v(x, y, z, 0, 1, 0, x / tile, z / tile);
    for (let i = 1; i + 1 < pts.length; i++) this.pushTri(base, base + i, base + i + 1, y);
  }

  /** Ensure upward winding regardless of input order. */
  private pushTri(a: number, b: number, c: number, _y: number) {
    const P = this.pos;
    const ax = P[a * 3]!, az = P[a * 3 + 2]!;
    const bx = P[b * 3]!, bz = P[b * 3 + 2]!;
    const cx = P[c * 3]!, cz = P[c * 3 + 2]!;
    const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    // Babylon is left-handed: clockwise seen from above (+y) is front-facing.
    if (cross > 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  /** Strip along a segment: from (ax,az)→(bx,bz), lateral offsets o0..o1 (left of travel positive), at height y. */
  strip(ax: number, az: number, bx: number, bz: number, o0: number, o1: number, y: number, tile: number, alongUV = false) {
    const L = Math.hypot(bx - ax, bz - az) || 1;
    const fx = (bx - ax) / L;
    const fz = (bz - az) / L;
    const lx = -fz;
    const lz = fx;
    const p: [number, number][] = [
      [ax + lx * o0, az + lz * o0],
      [bx + lx * o0, bz + lz * o0],
      [bx + lx * o1, bz + lz * o1],
      [ax + lx * o1, az + lz * o1],
    ];
    if (!alongUV) return this.flat(p, y, tile);
    const base = this.pos.length / 3;
    const uvs = [
      [0, 0],
      [L / tile, 0],
      [L / tile, 1],
      [0, 1],
    ];
    p.forEach(([x, z], i) => this.v(x, y, z, 0, 1, 0, uvs[i]![0]!, uvs[i]![1]!));
    this.pushTri(base, base + 1, base + 2, y);
    this.pushTri(base, base + 2, base + 3, y);
  }

  /** Vertical wall from (ax,az)→(bx,bz), y0..y1, outward normal = right of a→b. UVs in metres / tile. */
  wall(ax: number, az: number, bx: number, bz: number, y0: number, y1: number, tileU: number, tileV: number, u0 = 0, c?: [number, number, number]) {
    const L = Math.hypot(bx - ax, bz - az) || 1;
    // normal of the FRONT (visible) face for the winding below: left of a→b
    const nx = -(bz - az) / L;
    const nz = (bx - ax) / L;
    const a = this.v(ax, y0, az, nx, 0, nz, u0, y0 / tileV, c);
    const b = this.v(bx, y0, bz, nx, 0, nz, u0 + L / tileU, y0 / tileV, c);
    const cc = this.v(bx, y1, bz, nx, 0, nz, u0 + L / tileU, y1 / tileV, c);
    const d = this.v(ax, y1, az, nx, 0, nz, u0, y1 / tileV, c);
    this.idx.push(a, d, cc, a, cc, b);
    return L;
  }

  /** Oriented box (centre, size, yaw) — walls + top. */
  box(cx: number, cz: number, w: number, d: number, y0: number, y1: number, yaw: number, tileU: number, tileV: number, topTile: number, c?: [number, number, number], top?: Geo) {
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const corner = (lx: number, lz: number): [number, number] => [cx + lx * cs + lz * sn, cz - lx * sn + lz * cs];
    const p = [corner(-w / 2, -d / 2), corner(-w / 2, d / 2), corner(w / 2, d / 2), corner(w / 2, -d / 2)];
    let u = 0;
    for (let i = 0; i < 4; i++) {
      const a = p[i]!;
      const b = p[(i + 1) % 4]!;
      u += this.wall(a[0], a[1], b[0], b[1], y0, y1, tileU, tileV, u, c);
    }
    (top ?? this).flat(p, y1, topTile);
    return p;
  }

  toMesh(name: string, scene: Scene, mat: Material): Mesh | null {
    if (this.empty) return null;
    const m = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = this.pos;
    vd.normals = this.nrm;
    vd.uvs = this.uv;
    if (this.col) vd.colors = this.col;
    vd.indices = this.idx;
    vd.applyToMesh(m);
    m.material = mat;
    m.isPickable = false;
    m.freezeWorldMatrix();
    m.doNotSyncBoundingInfo = true;
    return m;
  }
}
