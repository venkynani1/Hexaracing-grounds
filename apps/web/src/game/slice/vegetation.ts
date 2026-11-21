/**
 * Licensed vegetation renderer (assets: docs/ASSETS.md — Nobiax/Yughues CC0 palms/bushes/hedges/grass,
 * 3TD Tropical Environment Pack CC0 ficus/copal/cecropia).
 *
 *  - One template per species × LOD, shared by every instance (thin instances: one draw call per template mesh).
 *  - Lighting baked into the TEMPLATE's vertex colours once (canopy-spherical normals for leaves, inner-canopy
 *    darkening, sun wrap); per-instance colour = natural tint variation × baked sun visibility at that spot.
 *    Materials are unlit + alpha-cutout (no blending, no per-pixel lights, no shadow map).
 *  - trees LOD0 < 24 m, LOD1 < 70 m, LOD2 beyond: impostor cards rendered ONCE at load from each species' LOD0 into a
 *    shared atlas, yaw-facing the camera. 10 % hysteresis so trees don't flicker between levels.
 */
import {
  Color3,
  Color4,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  RenderTargetTexture,
  StandardMaterial,
  Texture,
  TransformNode,
  UniversalCamera,
  Vector3,
  VertexBuffer,
  type AbstractMesh,
  type Camera,
  type Scene,
} from '@babylonjs/core';
import { configureKtx2, loadContainer } from '../render/assets';
import { SUN, LIGHT } from './bake';
import type { OccluderIndex } from './bake';
import type { VegItem } from './build';

const L = { x: -SUN.x, y: -SUN.y, z: -SUN.z };
const LOD0 = 24;
const LOD1 = 70;
const ATLAS_CELL = 256;
const GRID = 40;
const isSmall = (sp: string) => sp === 'grass' || sp.startsWith('bush') || sp === 'hedge_long';

interface Part {
  mesh: Mesh;
  leaf: boolean;
}
interface Species {
  id: string;
  lods: [Part[], Part[]];
  height: number;
  width: number;
  impostor: Mesh | null;
  /** long axis of a hedge segment (for fitting runs) */
  length: number;
}

function sunVisible(occ: OccluderIndex, x: number, y: number, z: number) {
  // reuse the static bake's occluders: how lit is this plant's position (0.35 … 1)
  let t = 1;
  for (const o of occ.at(x, z)) {
    if (o.kind !== 'box') continue;
    const cs = Math.cos(o.rot);
    const sn = Math.sin(o.rot);
    // march toward the sun a few samples (cheap; only at load)
    for (const d of [4, 10, 18, 30]) {
      const px = x + L.x * d;
      const py = y + L.y * d;
      const pz = z + L.z * d;
      if (py > o.y1 || py < o.y0) continue;
      const lx = Math.abs((px - o.x) * cs - (pz - o.z) * sn);
      const lz = Math.abs((px - o.x) * sn + (pz - o.z) * cs);
      if (lx < o.hw && lz < o.hd) {
        t = Math.min(t, 0.35);
        break;
      }
    }
  }
  return t;
}

/** Bake per-vertex light into a template (shared by all instances). */
function bakeTemplate(parts: Part[]) {
  // canopy centre + radius from leaf vertices
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let n = 0;
  let top = 0;
  for (const p of parts) {
    const pos = p.mesh.getVerticesData(VertexBuffer.PositionKind)!;
    for (let i = 0; i < pos.length; i += 3) {
      top = Math.max(top, pos[i + 1]!);
      if (!p.leaf) continue;
      cx += pos[i]!;
      cy += pos[i + 1]!;
      cz += pos[i + 2]!;
      n++;
    }
  }
  if (n) (cx /= n), (cy /= n), (cz /= n);
  let r = 0;
  for (const p of parts) {
    if (!p.leaf) continue;
    const pos = p.mesh.getVerticesData(VertexBuffer.PositionKind)!;
    for (let i = 0; i < pos.length; i += 3) r = Math.max(r, Math.hypot(pos[i]! - cx, (pos[i + 1]! - cy) * 1.4, pos[i + 2]! - cz));
  }
  r = Math.max(r, 0.2);
  for (const p of parts) {
    const pos = p.mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const nrm = p.mesh.getVerticesData(VertexBuffer.NormalKind) ?? new Float32Array(pos.length);
    const col = new Float32Array((pos.length / 3) * 4);
    for (let i = 0, v = 0; i < pos.length; i += 3, v += 4) {
      const x = pos[i]!;
      const y = pos[i + 1]!;
      const z = pos[i + 2]!;
      let nx: number;
      let ny: number;
      let nz: number;
      let ao: number;
      if (p.leaf && n) {
        // spherical canopy normal: smooth, volumetric shading instead of noisy per-card normals
        const dx = x - cx;
        const dy = (y - cy) * 1.4;
        const dz = z - cz;
        const d = Math.hypot(dx, dy, dz) || 1;
        nx = dx / d;
        ny = dy / d;
        nz = dz / d;
        ao = 0.45 + 0.55 * Math.min(1, d / r); // inner leaves darker
        ao *= 0.8 + 0.2 * Math.min(1, y / Math.max(0.1, top)); // lower canopy darker
      } else {
        nx = nrm[i]!;
        ny = nrm[i + 1]!;
        nz = nrm[i + 2]!;
        ao = 0.55 + 0.45 * Math.min(1, y / 2.5);
        if (n && y > cy - r) ao *= 0.7; // trunk under the canopy
      }
      const ndl = Math.max(0, nx * L.x + ny * L.y + nz * L.z);
      const wrap = p.leaf ? 0.35 + 0.65 * ndl : ndl; // foliage transmits light (wrap)
      const hemi = 0.75 + 0.25 * ny;
      for (let c = 0; c < 3; c++) col[v + c] = (LIGHT.sky[c]! * LIGHT.skyI * hemi * ao + LIGHT.sun[c]! * LIGHT.sunI * wrap * (p.leaf ? 0.85 : 1)) * 0.92;
      col[v + 3] = 1;
    }
    p.mesh.setVerticesData(VertexBuffer.ColorKind, col);
    p.mesh.useVertexColors = true;
  }
}

function unlitFrom(scene: Scene, src: AbstractMesh, leaf: boolean, name: string): StandardMaterial {
  const old = src.material as { albedoTexture?: Texture; diffuseTexture?: Texture } | null;
  const tex = (old?.albedoTexture ?? old?.diffuseTexture ?? null) as Texture | null;
  const m = new StandardMaterial(name, scene);
  m.disableLighting = true;
  m.emissiveColor = new Color3(1, 1, 1);
  m.diffuseColor = Color3.Black();
  m.specularColor = Color3.Black();
  if (tex) {
    m.diffuseTexture = tex;
    tex.hasAlpha = leaf; // alpha TEST (cutout), not blending
  }
  m.backFaceCulling = !leaf;
  m.alphaCutOff = 0.45;
  return m;
}

export class Vegetation {
  private species = new Map<string, Species>();
  private items: (VegItem & { lod: number; sun: number })[] = [];
  private bySpecies = new Map<string, (VegItem & { lod: number; sun: number })[]>();
  private dirty = new Set<string>();
  /** spatial grid of small plants (only cells near the camera are visited) */
  private grid = new Map<string, (VegItem & { lod: number; sun: number })[]>();
  private visible = new Set<VegItem & { lod: number; sun: number }>();
  private steps = 0;
  private readonly m = new Matrix();
  private readonly q = new Quaternion();
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private atlas: RenderTargetTexture | null = null;
  private lastCam = new Vector3(Infinity, 0, 0);
  stats = { instances: 0, templates: 0, trisLod0: 0 };

  constructor(private readonly scene: Scene) {}

  async load(ids: string[], items: VegItem[], occ: OccluderIndex) {
    const scene = this.scene;
    configureKtx2();
    for (const id of ids) {
      const lods: [Part[], Part[]] = [[], []];
      for (const lod of [0, 1] as const) {
        const c = await loadContainer(scene, `veg/${id}_lod${lod}.glb`, { srgbBuffers: false });
        if (!c) continue;
        c.addAllToScene();
        for (const m of c.meshes) {
          if (!(m instanceof Mesh) || !m.getTotalVertices()) continue;
          m.setParent(null);
          m.computeWorldMatrix(true);
          m.bakeCurrentTransformIntoVertices();
          const leaf = /leaf|atlas/.test(m.material?.name ?? '');
          m.material = unlitFrom(scene, m, leaf || /atlas|grass/.test(id), `veg-${id}-${lod}-${m.material?.name}`);
          if (/atlas/.test(m.name) || /palm|bush|hedge|grass/.test(id)) (m.material as StandardMaterial).backFaceCulling = false;
          m.isPickable = false;
          m.alwaysSelectAsActiveMesh = false;
          lods[lod].push({ mesh: m, leaf: leaf || /palm|bush|hedge|grass/.test(id) });
        }
        for (const m of c.meshes) if (!(m instanceof Mesh) || !m.getTotalVertices()) m.dispose();
      }
      if (!lods[0].length) continue;
      for (const l of lods) bakeTemplate(l);
      let min = new Vector3(Infinity, Infinity, Infinity);
      let max = min.scale(-1);
      for (const p of lods[0]) {
        p.mesh.refreshBoundingInfo();
        const b = p.mesh.getBoundingInfo().boundingBox;
        min = Vector3.Minimize(min, b.minimumWorld);
        max = Vector3.Maximize(max, b.maximumWorld);
      }
      this.species.set(id, { id, lods, height: max.y - min.y, width: Math.max(max.x - min.x, max.z - min.z), impostor: null, length: Math.max(max.x - min.x, max.z - min.z) });
      this.stats.templates += lods[0].length + lods[1].length;
    }
    await this.buildImpostors();
    this.items = items
      .filter((i) => this.species.has(i.sp))
      .map((i) => ({ ...i, lod: -1, sun: sunVisible(occ, i.x, 2, i.z) }));
    this.stats.instances = this.items.length;
    for (const it of this.items) {
      (this.bySpecies.get(it.sp) ?? this.bySpecies.set(it.sp, []).get(it.sp)!).push(it);
      const k = `${Math.floor(it.x / GRID)},${Math.floor(it.z / GRID)}`;
      (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(it);
    }
    // hide templates until the first update assigns instances
    for (const s of this.species.values()) for (const l of s.lods) for (const p of l) p.mesh.thinInstanceSetBuffer('matrix', new Float32Array(16), 16, false), (p.mesh.thinInstanceCount = 0);
  }

  /** Render each species' LOD0 once into a shared atlas → LOD2 impostor cards. */
  private async buildImpostors() {
    const scene = this.scene;
    const list = [...this.species.values()].filter((s) => s.height > 3); // trees + palms only
    if (!list.length) return;
    const cols = list.length;
    const rtt = new RenderTargetTexture('veg-atlas', { width: ATLAS_CELL * cols, height: ATLAS_CELL * 2 }, scene, true);
    // transparent texels carry the mean foliage colour (not black), so the atlas mips don't darken leaf edges
    rtt.clearColor = new Color4(0.3, 0.36, 0.2, 0);
    rtt.hasAlpha = true;
    const cam = new UniversalCamera('veg-atlas-cam', new Vector3(0, 0, -200), scene);
    cam.mode = UniversalCamera.ORTHOGRAPHIC_CAMERA;
    rtt.activeCamera = cam;
    const holders: TransformNode[] = [];
    const spacing = Math.max(...list.map((s) => s.width)) * 1.08;
    list.forEach((s, i) => {
      const h = new TransformNode(`imp-${s.id}`, scene);
      h.position.set(i * spacing, 0, 0);
      for (const p of s.lods[0]) {
        const c = p.mesh.clone(`imp-${p.mesh.name}`, h, true, false)!;
        c.setEnabled(true);
        rtt.renderList!.push(c);
      }
      holders.push(h);
    });
    // each species occupies one `spacing`-wide column; the card UVs map back to it
    const maxH = Math.max(...list.map((s) => s.height)) * 1.05;
    cam.position.set(0, maxH / 2, -200);
    cam.setTarget(new Vector3(0, maxH / 2, 0));
    cam.orthoLeft = -spacing / 2;
    cam.orthoRight = cols * spacing - spacing / 2;
    cam.orthoTop = maxH;
    cam.orthoBottom = 0;
    // compile every clone's shader first, otherwise the one-shot atlas render captures black/empty cells
    const clones = rtt.renderList!;
    for (let tries = 0; tries < 200 && !clones.every((c) => c.isReady(true)); tries++) await new Promise((r) => setTimeout(r, 16));
    rtt.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    for (let tries = 0; tries < 50 && !rtt.isReadyForRendering(); tries++) await new Promise((r) => setTimeout(r, 16));
    scene.customRenderTargets.push(rtt);
    rtt.render();
    scene.customRenderTargets.splice(scene.customRenderTargets.indexOf(rtt), 1);
    for (const h of holders) h.dispose(false, false);
    cam.dispose();
    this.atlas = rtt;
    rtt.hasAlpha = true;
    list.forEach((s, i) => {
      // card width in world units = spacing (cell), height = maxH; UVs of cell i
      const q = MeshBuilder.CreatePlane(`imp-card-${s.id}`, { width: spacing, height: maxH }, scene);
      q.bakeTransformIntoVertices(Matrix.Translation(0, maxH / 2, 0));
      const uv = q.getVerticesData(VertexBuffer.UVKind)!;
      for (let k = 0; k < uv.length; k += 2) uv[k] = (i + uv[k]!) / cols;
      q.setVerticesData(VertexBuffer.UVKind, uv);
      const m = new StandardMaterial(`imp-mat-${s.id}`, scene);
      m.disableLighting = true;
      m.emissiveColor = new Color3(1, 1, 1);
      m.diffuseColor = Color3.Black();
      m.diffuseTexture = rtt;
      rtt.hasAlpha = true;
      m.alphaCutOff = 0.35;
      m.backFaceCulling = false;
      q.material = m;
      q.isPickable = false;
      s.impostor = q;
    });
  }

  /** Re-assign LODs after the camera moved ≥ 4 m; only species whose membership changed rebuild their buffers. */
  update(camera: Camera, force = false) {
    const cp = camera.position;
    if (!force && Vector3.DistanceSquared(cp, this.lastCam) < 16) return;
    this.lastCam.copyFrom(cp);
    this.steps++;
    const assign = (it: VegItem & { lod: number; sun: number }) => {
      const sp = it.sp;
      const hedge = sp === 'hedge_long';
      const small = isSmall(sp);
      // measured: hedge LOD0 (2.4k tris) dominated vegetation triangles → LOD0 only up close
      // measured: vegetation was the largest cost (alpha-tested leaf overdraw, −45 % FPS) → full-detail cards only
      // close to the camera; impostors (1 quad) from 70 m
      const b0 = hedge ? 10 : small ? 16 : LOD0;
      const b1 = sp === 'grass' ? 30 : small ? 55 : LOD1;
      const d = Math.hypot(it.x - cp.x, it.z - cp.z);
      const lod = d < b0 * (it.lod === 0 ? 1.08 : 1) ? 0 : d < b1 * (it.lod === 1 ? 1.08 : 1) ? 1 : small ? 3 : 2;
      if (lod !== it.lod) (it.lod = lod), this.dirty.add(sp);
      if (lod < 3) this.visible.add(it);
      else this.visible.delete(it);
    };
    // small plants: previously visible + cells within 90 m; trees: all (few hundred)
    const prev = [...this.visible];
    for (const it of prev) assign(it);
    const R = Math.ceil(90 / GRID);
    const gx = Math.floor(cp.x / GRID);
    const gz = Math.floor(cp.z / GRID);
    for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) for (const it of this.grid.get(`${gx + i},${gz + j}`) ?? []) if (isSmall(it.sp)) assign(it);
    for (const [sp, list] of this.bySpecies) if (!isSmall(sp)) for (const it of list) assign(it);
    if (force) for (const sp of this.bySpecies.keys()) this.dirty.add(sp);
    for (const sp of this.dirty) this.rebuild(sp, cp);
    // impostors face the camera: re-aim every 3rd step (≈ 12 m) — invisible at their distance
    if (this.steps % 3 === 0) for (const sp of this.bySpecies.keys()) if (!this.dirty.has(sp) && !isSmall(sp)) this.rebuildImpostor(sp, cp);
    this.dirty.clear();
  }

  private rebuild(sp: string, cp: Vector3) {
    const s = this.species.get(sp)!;
    const mine = this.bySpecies.get(sp)!;
    for (const lod of [0, 1] as const) {
      const sel = mine.filter((i) => i.lod === lod);
      const mats = new Float32Array(Math.max(1, sel.length) * 16);
      const cols = new Float32Array(Math.max(1, sel.length) * 4);
      sel.forEach((i, k) => {
        const sc = i.s;
        const sx = s.id === 'hedge_long' ? 2.7 / Math.max(0.5, s.length) : sc;
        Quaternion.RotationYawPitchRollToRef(i.yaw + (s.id === 'hedge_long' ? Math.PI / 2 : 0), 0, 0, this.q);
        Matrix.ComposeToRef(this.v1.set(sx, sc, sc), this.q, this.v2.set(i.x, 0, i.z), this.m);
        this.m.copyToArray(mats, k * 16);
        const t = i.tint * (0.55 + 0.45 * i.sun);
        cols.set([t * (0.97 + (k % 5) * 0.012), t, t * (0.94 + (k % 3) * 0.03), 1], k * 4);
      });
      for (const p of s.lods[lod]) {
        p.mesh.thinInstanceSetBuffer('matrix', mats, 16, false);
        p.mesh.thinInstanceSetBuffer('color', cols, 4, false);
        p.mesh.thinInstanceCount = sel.length;
        p.mesh.thinInstanceRefreshBoundingInfo(false);
        p.mesh.setEnabled(sel.length > 0);
      }
    }
    this.rebuildImpostor(sp, cp);
  }

  private rebuildImpostor(sp: string, cp: Vector3) {
    const s = this.species.get(sp)!;
    if (!s.impostor) return;
    const sel = this.bySpecies.get(sp)!.filter((i) => i.lod === 2);
    const mats = new Float32Array(Math.max(1, sel.length) * 16);
    const cols = new Float32Array(Math.max(1, sel.length) * 4);
    sel.forEach((i, k) => {
      const yaw = Math.atan2(cp.x - i.x, cp.z - i.z) + Math.PI;
      Quaternion.RotationYawPitchRollToRef(yaw, 0, 0, this.q);
      Matrix.ComposeToRef(this.v1.set(i.s, i.s, i.s), this.q, this.v2.set(i.x, 0, i.z), this.m);
      this.m.copyToArray(mats, k * 16);
      const t = i.tint * (0.55 + 0.45 * i.sun);
      cols.set([t, t, t, 1], k * 4);
    });
    s.impostor.thinInstanceSetBuffer('matrix', mats, 16, false);
    s.impostor.thinInstanceSetBuffer('color', cols, 4, false);
    s.impostor.thinInstanceCount = sel.length;
    s.impostor.thinInstanceRefreshBoundingInfo(false);
    s.impostor.setEnabled(sel.length > 0);
  }

  /** Overcast/wet: darker, cooler foliage (instance colours are rebuilt on the next update). */
  setWet(wet: boolean) {
    for (const s of this.species.values())
      for (const l of s.lods)
        for (const p of l) (p.mesh.material as StandardMaterial).emissiveColor = wet ? new Color3(0.62, 0.66, 0.68) : new Color3(1, 1, 1);
    for (const s of this.species.values()) if (s.impostor) (s.impostor.material as StandardMaterial).emissiveColor = wet ? new Color3(0.62, 0.66, 0.68) : new Color3(1, 1, 1);
  }
}
