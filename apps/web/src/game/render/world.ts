/**
 * Static world, built per 400 m streaming cell from the OSM road graph (same graph the server simulates).
 * Visual only: roads are drawn exactly where the simulation's carriageways are; buildings are exactly the
 * server's collision boxes (procedural, shared), only dressed with textured facades.
 */
import {
  Color3,
  DynamicTexture,
  Matrix,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Quaternion,
  StandardMaterial,
  Texture,
  Vector3,
  VertexData,
  type Scene,
} from '@babylonjs/core';
import {
  BUILDING_CELL,
  createRng,
  edgesNear,
  deHeading,
  deStop,
  lanePoint,
  type Building,
  type ProceduralBuildings,
  type RoadNetwork,
  type SignalColor,
} from '@redline/shared';
import { Geo } from './geo';
import type { WorldMaterials } from './materials';

export const CELL = 400;
export const Y = { ground: -0.3, road: 0, mark: 0.012, kerb: 0.17, path: 0.15, median: 0.32 };

export interface SignalCell {
  heads: { node: number; heading: number; x: number; z: number }[];
  lamps: Record<SignalColor, { on: Mesh; off: Mesh }>;
  state: string;
}
export interface CellContent {
  meshes: Mesh[];
  /** detail meshes only shown in the cells nearest the camera (lamps, palms, signs, tanks) */
  detail: Mesh[];
  signals: SignalCell | null;
}

export interface PropTemplates {
  /** licensed concrete barrier (closures) — optional */
  barrier: Mesh | null;
}

const PASTELS: [number, number, number][] = [
  [0.95, 0.9, 0.78],
  [0.98, 0.86, 0.62],
  [0.93, 0.8, 0.8],
  [0.78, 0.88, 0.93],
  [0.8, 0.91, 0.82],
  [0.96, 0.96, 0.93],
  [0.9, 0.82, 0.7],
];

export class WorldBuilder {
  private readonly incident: number[][];
  private readonly cellEdges = new Map<string, number[]>();
  private readonly cellNodes = new Map<string, number[]>();
  private readonly stripeMat: PBRMaterial;
  private readonly signMat: StandardMaterial;
  private readonly lampOn: Record<SignalColor, StandardMaterial>;
  private readonly lampOff: Record<SignalColor, StandardMaterial>;
  private readonly palmTpl: Mesh[];
  private readonly signTpl: Mesh[];
  private readonly tankTpl: Mesh;
  private readonly headTpl: Mesh;
  private readonly poleTpl: Mesh;
  private readonly lampTpl: Mesh[];

  constructor(
    private readonly scene: Scene,
    private readonly net: RoadNetwork,
    private readonly mats: WorldMaterials,
    private readonly procedural: ProceduralBuildings | null,
    private readonly fixedBuildings: Building[],
    private readonly seed: string,
    private readonly props: PropTemplates,
  ) {
    this.incident = net.nodes.map(() => []);
    for (const e of net.edges) this.incident[e.a]!.push(e.id), this.incident[e.b]!.push(e.id);
    const cellOf = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    for (const e of net.edges) {
      const a = net.nodes[e.a]!;
      const b = net.nodes[e.b]!;
      const k = cellOf((a.x + b.x) / 2, (a.z + b.z) / 2);
      (this.cellEdges.get(k) ?? this.cellEdges.set(k, []).get(k)!).push(e.id);
    }
    for (const n of net.nodes) {
      const k = cellOf(n.x, n.z);
      (this.cellNodes.get(k) ?? this.cellNodes.set(k, []).get(k)!).push(n.id);
    }
    // Kerbs painted black & yellow (common on Chennai arterials) — original stripe texture.
    const st = new DynamicTexture('kerb-stripe', { width: 128, height: 16 }, scene, true);
    const c = st.getContext() as unknown as CanvasRenderingContext2D;
    c.fillStyle = '#d9b21c';
    c.fillRect(0, 0, 64, 16);
    c.fillStyle = '#1b1b1b';
    c.fillRect(64, 0, 64, 16);
    st.update();
    st.wrapU = Texture.WRAP_ADDRESSMODE;
    this.stripeMat = new PBRMaterial('kerb-stripe', scene);
    this.stripeMat.albedoTexture = st;
    this.stripeMat.roughness = 0.75;
    this.stripeMat.metallic = 0;

    this.signMat = this.makeSignMat();
    const lc: Record<SignalColor, Color3> = { R: new Color3(1, 0.12, 0.08), A: new Color3(1, 0.62, 0.05), G: new Color3(0.15, 1, 0.45) };
    const sm = (k: SignalColor, on: boolean) => {
      const m = new StandardMaterial(`sig-${k}-${on}`, scene);
      m.diffuseColor = on ? lc[k] : lc[k].scale(0.12);
      m.emissiveColor = on ? lc[k] : lc[k].scale(0.04);
      m.specularColor = new Color3(0.4, 0.4, 0.4);
      return m;
    };
    this.lampOn = { R: sm('R', true), A: sm('A', true), G: sm('G', true) };
    this.lampOff = { R: sm('R', false), A: sm('A', false), G: sm('G', false) };
    this.palmTpl = this.makePalm();
    this.signTpl = this.makeSpeedSign();
    this.tankTpl = MeshBuilder.CreateCylinder('tank-tpl', { height: 1.3, diameter: 1.2, tessellation: 10 }, scene);
    this.tankTpl.material = mats.darkMetal;
    this.tankTpl.setEnabled(false);
    // Signal head: dark housing with a visor, on a pole.
    this.headTpl = MeshBuilder.CreateBox('sig-head', { width: 0.42, height: 1.25, depth: 0.32 }, scene);
    this.headTpl.material = mats.darkMetal;
    this.headTpl.setEnabled(false);
    this.poleTpl = MeshBuilder.CreateCylinder('sig-pole', { height: 5.2, diameterTop: 0.12, diameterBottom: 0.16, tessellation: 8 }, scene);
    this.poleTpl.material = mats.metal;
    this.poleTpl.setEnabled(false);
    this.lampTpl = this.makeLamp();
  }

  /** Original modern LED street light: galvanised tapered pole, curved outreach arm, slim LED head. */
  private makeLamp(): Mesh[] {
    const scene = this.scene;
    const pole = MeshBuilder.CreateCylinder('lamp-pole', { height: 9, diameterTop: 0.11, diameterBottom: 0.24, tessellation: 8 }, scene);
    pole.bakeTransformIntoVertices(Matrix.Translation(0, 4.5, 0));
    const arcPts: Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      arcPts.push(new Vector3(0, 8.6 + Math.sin(t * Math.PI * 0.5) * 0.55, t * 2.3));
    }
    const arm = MeshBuilder.CreateTube('lamp-arm', { path: arcPts, radius: 0.045, tessellation: 6 }, scene);
    const base = MeshBuilder.CreateCylinder('lamp-base', { height: 0.6, diameter: 0.38, tessellation: 8 }, scene);
    base.bakeTransformIntoVertices(Matrix.Translation(0, 0.3, 0));
    const head = MeshBuilder.CreateBox('lamp-head', { width: 0.36, height: 0.1, depth: 0.75 }, scene);
    head.bakeTransformIntoVertices(Matrix.Translation(0, 9.17, 2.55));
    const body = Mesh.MergeMeshes([pole, arm, base, head], true, true)!;
    body.material = this.mats.metal;
    body.setEnabled(false);
    const lens = MeshBuilder.CreatePlane('lamp-lens', { width: 0.3, height: 0.62 }, scene);
    lens.bakeTransformIntoVertices(Matrix.RotationX(Math.PI / 2).multiply(Matrix.Translation(0, 9.115, 2.55)));
    const lm = new StandardMaterial('lamp-lens', scene);
    lm.emissiveColor = new Color3(0.95, 0.97, 1);
    lm.diffuseColor = Color3.Black();
    lm.backFaceCulling = false;
    lens.material = lm;
    lens.setEnabled(false);
    return [body, lens];
  }

  private makeSignMat() {
    const t = new DynamicTexture('speed-sign', { width: 128, height: 128 }, this.scene, true);
    const c = t.getContext() as unknown as CanvasRenderingContext2D;
    c.clearRect(0, 0, 128, 128);
    c.fillStyle = '#d21f26';
    c.beginPath();
    c.arc(64, 64, 62, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.arc(64, 64, 48, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#111';
    c.font = 'bold 50px system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText('50', 64, 82);
    t.update();
    t.hasAlpha = true;
    const m = new StandardMaterial('sign-mat', this.scene);
    m.diffuseTexture = t;
    m.useAlphaFromDiffuseTexture = true;
    m.emissiveColor = new Color3(0.25, 0.25, 0.25);
    m.backFaceCulling = false;
    return m;
  }

  /** Original procedural coconut palm: curved tapered trunk + alpha-textured fronds. */
  private makePalm(): Mesh[] {
    const scene = this.scene;
    const path: Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      path.push(new Vector3(Math.sin(t * 1.2) * 0.9, t * 9, 0));
    }
    const trunk = MeshBuilder.CreateTube('palm-trunk', { path, radiusFunction: (i) => 0.24 - i * 0.012, tessellation: 7, cap: Mesh.NO_CAP }, scene);
    trunk.material = this.mats.palmTrunk;
    trunk.setEnabled(false);
    const top = path[path.length - 1]!;
    const fronds: Mesh[] = [];
    // Drooping, tapered fronds (ribbons) radiating from the crown.
    for (let i = 0; i < 11; i++) {
      const yaw = (i / 11) * Math.PI * 2 + (i % 2) * 0.2;
      const dx = Math.sin(yaw);
      const dz = Math.cos(yaw);
      const len = 3.6 + (i % 3) * 0.5;
      const rise = 0.9 - (i % 4) * 0.25;
      const left: Vector3[] = [];
      const right: Vector3[] = [];
      for (let k = 0; k <= 8; k++) {
        const t = k / 8;
        const w = 0.55 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 0.05;
        const c = new Vector3(top.x + dx * len * t, top.y + rise * t - 2.6 * t * t, top.z + dz * len * t);
        // leaflets angle down from the rib (V-shape)
        left.push(c.add(new Vector3(-dz * w, -0.25 * w, dx * w)));
        right.push(c.add(new Vector3(dz * w, -0.25 * w, -dx * w)));
      }
      fronds.push(MeshBuilder.CreateRibbon('frond', { pathArray: [left, right], sideOrientation: Mesh.DOUBLESIDE }, scene));
    }
    const crown = Mesh.MergeMeshes(fronds, true, true)!;
    crown.material = this.mats.palmLeaf;
    crown.setEnabled(false);
    return [trunk, crown];
  }

  private makeSpeedSign(): Mesh[] {
    const pole = MeshBuilder.CreateCylinder('sign-pole', { height: 2.6, diameter: 0.07, tessellation: 6 }, this.scene);
    pole.bakeTransformIntoVertices(Matrix.Translation(0, 1.3, 0));
    pole.material = this.mats.metal;
    pole.setEnabled(false);
    const disc = MeshBuilder.CreatePlane('sign-disc', { size: 0.75 }, this.scene);
    disc.bakeTransformIntoVertices(Matrix.Translation(0, 2.75, 0));
    disc.material = this.signMat;
    disc.setEnabled(false);
    return [pole, disc];
  }

  private degree(n: number) {
    return this.incident[n]!.length;
  }
  private maxHalf(n: number) {
    let m = 0;
    for (const id of this.incident[n]!) m = Math.max(m, this.net.edges[id]!.halfWidth);
    return m;
  }
  /** How far road furniture (markings, kerbs) stays back from a node. */
  private trim(nid: number, len: number) {
    const n = this.net.nodes[nid]!;
    const d = this.degree(nid);
    if (d >= 3 || n.signal) return Math.min(len * 0.45, Math.max(n.radius, this.maxHalf(nid)) + 1.5);
    return 0;
  }

  /** True if (x,z) is clear of every carriageway except `own` by `margin` metres. */
  private clearOf(x: number, z: number, own: number, margin: number) {
    const net = this.net;
    for (const id of edgesNear(net, x, z, 12)) {
      if (id === own) continue;
      const e = net.edges[id]!;
      const a = net.nodes[e.a]!;
      const b = net.nodes[e.b]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const L = dx * dx + dz * dz;
      const t = L > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L)) : 0;
      if (Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)) - e.halfWidth < margin) return false;
    }
    return true;
  }

  /** Sub-ranges [s0,s1] of a strip (lateral o0..o1 along the trimmed segment) that don't intrude on other roads. */
  private clipRanges(ax: number, az: number, fx: number, fz: number, seg: number, o0: number, o1: number, own: number): [number, number][] {
    const out: [number, number][] = [];
    const step = 3;
    let start = -1;
    for (let s = 0; s <= seg + 0.001; s += step) {
      const ss = Math.min(s, seg);
      let ok = true;
      for (const o of [o0, (o0 + o1) / 2, o1]) {
        if (!this.clearOf(ax + fx * ss - fz * o, az + fz * ss + fx * o, own, 0.15)) {
          ok = false;
          break;
        }
      }
      if (ok && start < 0) start = ss;
      if (!ok && start >= 0) {
        if (ss - step - start > 1) out.push([start, ss - step]);
        start = -1;
      }
    }
    if (start >= 0 && seg - start > 1) out.push([start, seg]);
    return out;
  }

  buildCell(key: string): CellContent {
    const net = this.net;
    const scene = this.scene;
    const mats = this.mats;
    const road = new Geo();
    const white = new Geo();
    const yellow = new Geo();
    const kerbTop = new Geo();
    const kerbFace = new Geo();
    const path = new Geo();
    const median = new Geo();
    const lampM: number[] = [];
    const palmM: number[] = [];
    const signM: number[] = [];
    const edges = this.cellEdges.get(key) ?? [];
    const nodes = this.cellNodes.get(key) ?? [];
    const lw = net.laneWidth;

    for (const id of edges) {
      const e = net.edges[id]!;
      const A = net.nodes[e.a]!;
      const B = net.nodes[e.b]!;
      const L = e.length;
      if (L < 0.5) continue;
      const fx = (B.x - A.x) / L;
      const fz = (B.z - A.z) / L;
      const hw = e.halfWidth;
      road.strip(A.x, A.z, B.x, B.z, -hw, hw, Y.road, 6);
      const t0 = this.trim(e.a, L);
      const t1 = this.trim(e.b, L);
      if (L - t0 - t1 < 2) continue;
      const ax = A.x + fx * t0;
      const az = A.z + fz * t0;
      const bx = A.x + fx * (L - t1);
      const bz = A.z + fz * (L - t1);
      const seg = L - t0 - t1;
      const solid = (g: Geo, off: number, w = 0.15) => g.strip(ax, az, bx, bz, off - w / 2, off + w / 2, Y.mark, 4);
      const dashed = (g: Geo, off: number, dash = 3, gap = 4.5) => {
        for (let s = 1; s + dash < seg; s += dash + gap) {
          const x0 = ax + fx * s;
          const z0 = az + fz * s;
          g.strip(x0, z0, x0 + fx * dash, z0 + fz * dash, off - 0.075, off + 0.075, Y.mark, 4);
        }
      };
      const major = e.cls <= 2;
      // --- markings (keep-left; left of travel a→b is +offset) ---
      if (e.oneway) {
        const half = (e.lanes * lw) / 2;
        for (let k = 1; k < e.lanes; k++) dashed(white, -half + k * lw);
        if (major) {
          solid(white, half - 0.2); // left (kerb) edge line
          solid(yellow, -half + 0.2); // right (median) edge line
        }
      } else {
        if (e.cls <= 1 && e.lanes >= 2) (solid(yellow, 0.12, 0.12), solid(yellow, -0.12, 0.12));
        else dashed(white, 0, 3, 3);
        for (let k = 1; k < e.lanes; k++) (dashed(white, k * lw), dashed(white, -k * lw));
        if (major && hw - e.lanes * lw > -0.4) (solid(white, hw - 0.25), solid(white, -hw + 0.25));
      }
      // --- kerbs / footpaths / median (clipped wherever they would intrude on another carriageway) ---
      const medianSide = e.oneway && e.cls <= 1;
      const along = (r: [number, number]): [number, number, number, number] => [ax + fx * r[0], az + fz * r[0], ax + fx * r[1], az + fz * r[1]];
      for (const side of [1, -1]) {
        const o = side * hw;
        if (side === -1 && medianSide) {
          for (const r of this.clipRanges(ax, az, fx, fz, seg, -hw - 1.1, -hw - 0.05, id)) {
            const [x0, z0, x1, z1] = along(r);
            median.strip(x0, z0, x1, z1, -hw - 1.1, -hw - 0.05, Y.median, 3);
            kerbFace.wall(...wallPts(x0, z0, x1, z1, -hw - 0.05, true), Y.road, Y.median, 2, 1);
          }
          continue;
        }
        if (e.cls === 0) continue; // motorway: no footpath, verge only
        const inner = o;
        const outer = o + side * 0.3;
        const hasPath = e.cls <= 4;
        const far = hasPath ? o + side * 3.1 : outer;
        for (const r of this.clipRanges(ax, az, fx, fz, seg, Math.min(inner, far), Math.max(inner, far), id)) {
          const [x0, z0, x1, z1] = along(r);
          kerbTop.strip(x0, z0, x1, z1, Math.min(inner, outer), Math.max(inner, outer), Y.kerb, 2, true);
          kerbFace.wall(...wallPts(x0, z0, x1, z1, inner, side < 0), Y.road, Y.kerb, 2, 1);
          if (hasPath) {
            path.strip(x0, z0, x1, z1, Math.min(outer, far), Math.max(outer, far), Y.path, 2.4);
            path.wall(...wallPts(x0, z0, x1, z1, far, side > 0), Y.ground, Y.path, 2.4, 2.4);
          }
        }
      }
      // --- street furniture ---
      const rng = createRng(this.seed, `furn:${id}`);
      const yawRoad = Math.atan2(fx, fz);
      if (major && seg > 4) {
        const sides = medianSide ? [-1] : e.cls <= 1 ? [1, -1] : [1];
        for (const side of sides)
          for (let s = rng.next() * 34 + 2; s < seg - 2; s += 34) {
            const off = side < 0 && medianSide ? -(hw + 0.6) : side * (hw + 0.9);
            const px = ax + fx * s - fz * off;
            const pz = az + fz * s + fx * off;
            // arm points over the carriageway
            const yaw = yawRoad + (off > 0 ? Math.PI / 2 : -Math.PI / 2);
            if (!this.clearOf(px, pz, id, 0)) continue;
            Matrix.Compose(Vector3.One(), Quaternion.RotationYawPitchRoll(yaw, 0, 0), new Vector3(px, Y.path, pz)).asArray().forEach((v) => lampM.push(v));
          }
        if (seg > 120 && rng.next() < 0.6) {
          const s = 20 + rng.next() * (seg - 40);
          const off = hw + 0.9;
          Matrix.Compose(Vector3.One(), Quaternion.RotationYawPitchRoll(yawRoad + Math.PI, 0, 0), new Vector3(ax + fx * s - fz * off, Y.path, az + fz * s + fx * off))
            .asArray()
            .forEach((v) => signM.push(v));
        }
      }
      if (e.cls >= 1 && e.cls <= 4 && seg > 4) {
        for (let s = rng.next() * 30 + 4; s < seg - 4; s += 26 + rng.next() * 14) {
          if (rng.next() > 0.32) continue;
          for (const side of medianSide ? [1] : [1, -1]) {
            if (rng.next() > 0.6) continue;
            const off = side * (hw + 5.5);
            const sc = 0.7 + rng.next() * 0.5;
            // crown (~4 m radius) must not overhang any carriageway, including this one
            if (!this.clearOf(ax + fx * s - fz * off, az + fz * s + fx * off, -1, 4.2)) continue;
            Matrix.Compose(new Vector3(sc, sc, sc), Quaternion.RotationYawPitchRoll(rng.next() * Math.PI * 2, 0, 0), new Vector3(ax + fx * s - fz * off, Y.path, az + fz * s + fx * off))
              .asArray()
              .forEach((v) => palmM.push(v));
          }
        }
      }
    }

    // --- junction surfaces, stop lines and zebra crossings ---
    const heads: SignalCell['heads'] = [];
    for (const nid of nodes) {
      const n = net.nodes[nid]!;
      const deg = this.degree(nid);
      if (!deg) continue;
      const r = deg >= 3 || n.signal ? Math.max(n.radius, this.maxHalf(nid)) : this.maxHalf(nid);
      const ring: [number, number][] = [];
      for (let i = 0; i < 16; i++) ring.push([n.x + Math.sin((i * Math.PI) / 8) * r, n.z + Math.cos((i * Math.PI) / 8) * r]);
      road.flat(ring, Y.road, 6);
      if (!n.signal) continue;
      for (const id of this.incident[nid]!) {
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
        const lanesW = e.oneway ? e.lanes * lw : e.lanes * lw;
        const o0 = e.oneway ? -lanesW / 2 : 0;
        const o1 = e.oneway ? lanesW / 2 : lanesW;
        white.strip(cx - hx * 0.25, cz - hz * 0.25, cx + hx * 0.25, cz + hz * 0.25, o0, o1, Y.mark, 4);
        // zebra across the full carriageway, just past the stop line
        if (e.length - sStop > 4.5) {
          for (let o = -e.halfWidth + 0.4; o < e.halfWidth - 0.4; o += 1.0) {
            const zx = cx + hx * 1.2;
            const zz = cz + hz * 1.2;
            white.strip(zx, zz, zx + hx * 3, zz + hz * 3, o, o + 0.5, Y.mark, 4);
          }
        }
        const p = lanePoint(net, de, e.oneway ? e.lanes - 0.2 : e.lanes + 0.35, sStop);
        heads.push({ node: nid, heading: h, x: p.x, z: p.z });
      }
    }

    const meshes: Mesh[] = [];
    const detail: Mesh[] = [];
    const add = (g: Geo, name: string, mat: import('@babylonjs/core').Material, receive = true) => {
      const m = g.toMesh(`${name}-${key}`, scene, mat);
      if (m) (m.receiveShadows = receive), meshes.push(m);
      return m;
    };
    add(road, 'road', mats.asphalt);
    add(white, 'mark-w', mats.paintWhite);
    add(yellow, 'mark-y', mats.paintYellow);
    add(kerbTop, 'kerb', this.stripeMat);
    add(kerbFace, 'kerbface', this.stripeMat);
    add(path, 'path', mats.pavers);
    add(median, 'median', mats.median);

    // --- buildings (exactly the server's collision boxes) ---
    const [cx, cz] = key.split(',').map(Number) as [number, number];
    const list: Building[] = [];
    if (this.procedural) {
      const b0x = Math.floor((cx * CELL) / BUILDING_CELL);
      const b0z = Math.floor((cz * CELL) / BUILDING_CELL);
      const k = CELL / BUILDING_CELL;
      for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) list.push(...this.procedural.cell(b0x + i, b0z + j));
    } else for (const b of this.fixedBuildings) if (Math.floor(b.x / CELL) === cx && Math.floor(b.z / CELL) === cz) list.push(b);
    const f = mats.facades;
    const groups = { tower: new Geo(), glass: new Geo(), office: new Geo(), apt: new Geo(), plaster: new Geo() };
    const roof = new Geo();
    const tankM: number[] = [];
    for (const b of list) {
      const pick = (b.tone * 997) % 1;
      const yaw = b.rot ?? 0;
      if (b.h >= 28) (pick < 0.5 ? groups.tower : groups.glass).box(b.x, b.z, b.w, b.d, Y.ground, b.h, yaw, 13, 13, 8, undefined, roof);
      else if (b.h >= 14) (pick < 0.6 ? groups.office : groups.apt).box(b.x, b.z, b.w, b.d, Y.ground, b.h, yaw, pick < 0.6 ? 10 : 13, pick < 0.6 ? 10 : 13, 8, undefined, roof);
      else {
        const c = PASTELS[Math.floor(b.tone * PASTELS.length)]!;
        groups.plaster.box(b.x, b.z, b.w, b.d, Y.ground, b.h, yaw, 8, 6.4, 8, c, roof);
        // black water tank on the roof — a Chennai skyline staple
        if (pick < 0.7) Matrix.Translation(b.x + (pick - 0.35) * b.w * 0.6, b.h + 0.65, b.z).asArray().forEach((v) => tankM.push(v));
      }
    }
    const rec = (m: Mesh | null) => m;
    rec(add(groups.tower, 'b-tower', f.glassTower));
    rec(add(groups.glass, 'b-glass', f.glassOffice));
    rec(add(groups.office, 'b-office', f.office));
    rec(add(groups.apt, 'b-apt', f.apartment));
    const pl = add(groups.plaster, 'b-plaster', f.plaster);
    if (pl) pl.useVertexColors = true;
    add(roof, 'roof', mats.roof);

    // --- instanced detail ---
    const inst = (tpl: Mesh, m: number[], name: string) => {
      if (!m.length) return;
      const c = tpl.clone(`${name}-${key}`, null, true, false)!;
      c.setEnabled(true);
      c.thinInstanceSetBuffer('matrix', new Float32Array(m), 16, true);
      c.isPickable = false;
      c.alwaysSelectAsActiveMesh = false;
      c.thinInstanceRefreshBoundingInfo(false);
      detail.push(c);
    };
    for (const t of this.lampTpl) inst(t, lampM, t.name);
    for (const t of this.palmTpl) inst(t, palmM, t.name);
    for (const t of this.signTpl) inst(t, signM, t.name);
    inst(this.tankTpl, tankM, 'tank');

    // --- traffic signals ---
    let signals: SignalCell | null = null;
    if (heads.length) {
      const poleM: number[] = [];
      const headM: number[] = [];
      for (const h of heads) {
        Matrix.Translation(h.x, 2.6, h.z).asArray().forEach((v) => poleM.push(v));
        Matrix.Compose(Vector3.One(), Quaternion.RotationYawPitchRoll(h.heading, 0, 0), new Vector3(h.x, 5.0, h.z)).asArray().forEach((v) => headM.push(v));
      }
      inst(this.poleTpl, poleM, 'sig-pole');
      inst(this.headTpl, headM, 'sig-head');
      const lamps = {} as SignalCell['lamps'];
      for (const c of ['R', 'A', 'G'] as SignalColor[]) {
        const mk = (on: boolean) => {
          const l = MeshBuilder.CreateSphere(`lamp-${key}-${c}-${on}`, { diameter: 0.26, segments: 6 }, scene);
          l.material = on ? this.lampOn[c] : this.lampOff[c];
          l.isPickable = false;
          meshes.push(l);
          return l;
        };
        lamps[c] = { on: mk(true), off: mk(false) };
      }
      signals = { heads, lamps, state: '' };
    }
    return { meshes, detail, signals };
  }
}

/** Points for a wall along a segment at lateral offset `off`; `flip` swaps direction so the face points outward. */
function wallPts(ax: number, az: number, bx: number, bz: number, off: number, flip: boolean): [number, number, number, number] {
  const L = Math.hypot(bx - ax, bz - az) || 1;
  const lx = -(bz - az) / L;
  const lz = (bx - ax) / L;
  const p0: [number, number] = [ax + lx * off, az + lz * off];
  const p1: [number, number] = [bx + lx * off, bz + lz * off];
  return flip ? [p1[0], p1[1], p0[0], p0[1]] : [p0[0], p0[1], p1[0], p1[1]];
}

export { VertexData };
