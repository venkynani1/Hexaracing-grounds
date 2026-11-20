import {
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  Engine,
  HemisphericLight,
  Matrix,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Quaternion,
  Scene,
  StandardMaterial,
  TransformNode,
  UniversalCamera,
  Vector3,
  VertexData,
  type AbstractMesh,
  type InstancedMesh,
} from '@babylonjs/core';
import {
  BUILDING_CELL,
  ProceduralBuildings,
  TRAFFIC_TYPES,
  TRAFFIC_TYPE_BY_CODE,
  deHeading,
  deStop,
  generateBuildings,
  hash32,
  lanePoint,
  signalGroup,
  signalState,
  type Building,
  type RoadNetwork,
  type SignalColor,
  type WorldMap,
} from '@redline/shared';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export type CameraMode = 'chase' | 'hood' | 'top';

/** Presets change visuals only — never gameplay (SPEC Part 1). */
const PRESETS: Record<Quality, { minScale: number; fog: number; aa: boolean; draw: number }> = {
  low: { minScale: 2, fog: 0.004, aa: false, draw: 400 },
  medium: { minScale: 1.5, fog: 0.0028, aa: false, draw: 700 },
  high: { minScale: 1, fog: 0.002, aa: true, draw: 1000 },
  ultra: { minScale: 0.75, fog: 0.0014, aa: true, draw: 1400 },
};

const CELL = 400;
const cellOf = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
const cellDist = (k: string, cx: number, cz: number) => {
  const [x, z] = k.split(',').map(Number) as [number, number];
  return (x - cx) ** 2 + (z - cz) ** 2;
};
const incidence = new WeakMap<RoadNetwork, number[][]>();
function incident(net: RoadNetwork): number[][] {
  let inc = incidence.get(net);
  if (!inc) {
    inc = net.nodes.map(() => []);
    for (const e of net.edges) inc[e.a]!.push(e.id), inc[e.b]!.push(e.id);
    incidence.set(net, inc);
  }
  return inc;
}
function maxHalfWidth(net: RoadNetwork, nid: number) {
  let m = 0;
  for (const id of incident(net)[nid]!) m = Math.max(m, net.edges[id]!.halfWidth);
  return m;
}
/** Directed edges that ARRIVE at a node (one-way rules respected). */
function incomingDes(net: RoadNetwork, nid: number): number[] {
  const out: number[] = [];
  for (const id of incident(net)[nid]!) {
    const e = net.edges[id]!;
    if (e.b === nid) out.push(id * 2);
    else if (!e.oneway) out.push(id * 2 + 1);
  }
  return out;
}
interface SignalCell {
  heads: { node: number; heading: number; x: number; z: number }[];
  lamps: Record<SignalColor, { on: Mesh; off: Mesh }>;
  state: string;
}

export interface CarPose {
  x: number;
  z: number;
  heading: number;
  braking?: boolean;
  ghost?: boolean;
  label?: string;
}

export function teamColor(id: string): Color3 {
  const h = (hash32(id) % 360) / 360;
  return Color3.FromHSV(h * 360, 0.75, 0.9);
}

export class GameScene {
  readonly engine: Engine;
  readonly scene: Scene;
  private readonly camera: UniversalCamera;
  private readonly sun: DirectionalLight;
  private me: CarRig | null = null;
  private others = new Map<string | number, CarRig>();
  private trafficTemplates: Mesh[] = [];
  private trafficPool = new Map<number, InstancedMesh>();
  private lampMats!: Record<SignalColor, { on: StandardMaterial; off: StandardMaterial }>;
  private camMode: CameraMode = 'chase';
  private camPos = new Vector3(0, 30, -30);
  private quality: Quality;
  private scale: number;
  private fpsWindow: number[] = [];
  private rain = false;

  private readonly net: RoadNetwork;
  private readonly procedural: ProceduralBuildings | null;
  private readonly buildings: Building[];

  constructor(
    canvas: HTMLCanvasElement,
    map: WorldMap,
    private readonly seed: string,
    quality: Quality = 'medium',
  ) {
    const net = map.net;
    this.net = net;
    this.buildings = map.id === 'test' ? generateBuildings(net, seed) : [];
    this.quality = quality;
    this.engine = new Engine(canvas, PRESETS[quality].aa, { stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' }, false);
    this.scale = Math.max(PRESETS[quality].minScale, 1 / Math.min(window.devicePixelRatio || 1, 1.5));
    this.engine.setHardwareScalingLevel(this.scale);
    const scene = (this.scene = new Scene(this.engine));
    scene.skipPointerMovePicking = true;
    scene.clearColor = new Color4(0.55, 0.68, 0.82, 1);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogColor = new Color3(0.62, 0.72, 0.84);
    scene.fogDensity = PRESETS[quality].fog;
    scene.ambientColor = new Color3(0.3, 0.3, 0.35);

    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.75;
    hemi.groundColor = new Color3(0.25, 0.22, 0.2);
    this.sun = new DirectionalLight('sun', new Vector3(-0.4, -1, 0.35), scene);
    this.sun.intensity = 1.6;

    this.camera = new UniversalCamera('cam', new Vector3(0, 20, -20), scene);
    this.camera.minZ = 0.3;
    this.camera.maxZ = 3000;
    this.camera.fov = 1.0;
    this.camera.inputs.clear();

    this.procedural = map.id === 'test' ? null : new ProceduralBuildings(net, seed);
    this.buildGround();
    this.buildTrafficTemplates();
  }

  /* ---------------- static world: streamed cells ---------------- */

  private mat(name: string, color: Color3, spec = 0.05, emissive?: Color3) {
    const m = new StandardMaterial(name, this.scene);
    m.diffuseColor = color;
    m.specularColor = new Color3(spec, spec, spec);
    if (emissive) m.emissiveColor = emissive;
    return m;
  }

  private ground!: Mesh;
  private asphalt!: StandardMaterial;
  private paint!: StandardMaterial;
  private bldgMat!: StandardMaterial;
  private poleMat!: StandardMaterial;
  private cellEdges = new Map<string, number[]>();
  private cellNodes = new Map<string, number[]>();
  private cells = new Map<string, { meshes: Mesh[]; signals: SignalCell | null }>();
  private lastCellCheck = '';
  private pending: string[] = [];

  private buildGround() {
    const g = MeshBuilder.CreateGround('ground', { width: 6000, height: 6000 }, this.scene);
    g.material = this.mat('grass', new Color3(0.33, 0.4, 0.27));
    this.ground = g;
    this.asphalt = this.mat('asphalt', new Color3(0.17, 0.17, 0.19), 0.12);
    this.asphalt.backFaceCulling = false;
    this.paint = this.mat('paint', new Color3(0.9, 0.9, 0.85), 0, new Color3(0.35, 0.35, 0.33));
    this.bldgMat = this.mat('bldgMat', new Color3(1, 1, 1), 0.1);
    this.poleMat = this.mat('poleMat', new Color3(0.2, 0.2, 0.22));
    const lampColors: Record<SignalColor, Color3> = { R: new Color3(1, 0.1, 0.08), A: new Color3(1, 0.65, 0.05), G: new Color3(0.1, 1, 0.35) };
    this.lampMats = Object.fromEntries(
      (Object.keys(lampColors) as SignalColor[]).map((k) => [k, { on: this.mat(`lamp${k}on`, lampColors[k], 0, lampColors[k]), off: this.mat(`lamp${k}off`, lampColors[k].scale(0.15), 0) }]),
    ) as never;
    // Assign every edge (by midpoint) and node to exactly one render cell.
    const net = this.net;
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
  }

  private buildRoads() {
    /* roads are streamed per cell — see streamCells() */
  }
  private buildBuildings() {
    /* buildings are streamed per cell — see streamCells() */
  }
  private buildSignals() {
    /* signals are streamed per cell — see streamCells() */
  }

  /** Load cells near the camera (a few per frame), dispose far ones. Visual only — never affects gameplay. */
  private streamCells(x: number, z: number) {
    this.ground.position.set(Math.round(x / 500) * 500, 0, Math.round(z / 500) * 500);
    const here = cellOf(x, z);
    const R = Math.ceil(PRESETS[this.quality].draw / CELL);
    if (here !== this.lastCellCheck) {
      this.lastCellCheck = here;
      const [cx, cz] = here.split(',').map(Number) as [number, number];
      const want = new Set<string>();
      for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) if (i * i + j * j <= R * R + 1) want.add(`${cx + i},${cz + j}`);
      for (const [k, c] of this.cells) if (!want.has(k)) (c.meshes.forEach((m) => m.dispose()), this.cells.delete(k));
      this.pending = [...want].filter((k) => !this.cells.has(k)).sort((a, b) => cellDist(a, cx, cz) - cellDist(b, cx, cz));
    }
    for (let n = 0; n < 3 && this.pending.length; n++) {
      const k = this.pending.shift()!;
      if (!this.cells.has(k)) this.cells.set(k, this.buildCell(k));
    }
  }

  get loadedCells() {
    return this.cells.size;
  }

  private buildCell(key: string): { meshes: Mesh[]; signals: SignalCell | null } {
    const net = this.net;
    const meshes: Mesh[] = [];
    const edges = this.cellEdges.get(key) ?? [];
    const nodes = this.cellNodes.get(key) ?? [];
    // --- road surface: one merged mesh of quads + junction octagons ---
    const pos: number[] = [];
    const idx: number[] = [];
    const quad = (ax: number, az: number, bx: number, bz: number, hw: number, y: number) => {
      const L = Math.hypot(bx - ax, bz - az) || 1;
      const nx = (-(bz - az) / L) * hw;
      const nz = ((bx - ax) / L) * hw;
      const o = pos.length / 3;
      pos.push(ax + nx, y, az + nz, ax - nx, y, az - nz, bx - nx, y, bz - nz, bx + nx, y, bz + nz);
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    };
    for (const id of edges) {
      const e = net.edges[id]!;
      const a = net.nodes[e.a]!;
      const b = net.nodes[e.b]!;
      quad(a.x, a.z, b.x, b.z, e.halfWidth, 0.05 + (e.cls <= 1 ? 0.01 : 0));
    }
    for (const nid of nodes) {
      const n = net.nodes[nid]!;
      const r = Math.max(n.radius, net.out[nid]!.length ? maxHalfWidth(net, nid) : 0);
      if (r <= 0) continue;
      const o = pos.length / 3;
      pos.push(n.x, 0.055, n.z);
      for (let i = 0; i < 8; i++) pos.push(n.x + Math.sin((i * Math.PI) / 4) * r, 0.055, n.z + Math.cos((i * Math.PI) / 4) * r);
      for (let i = 0; i < 8; i++) idx.push(o, o + 1 + i, o + 1 + ((i + 1) % 8));
    }
    if (idx.length) {
      const m = new Mesh(`road-${key}`, this.scene);
      const vd = new VertexData();
      vd.positions = pos;
      vd.indices = idx;
      const normals: number[] = [];
      VertexData.ComputeNormals(pos, idx, normals);
      vd.normals = normals.map((v, i) => (i % 3 === 1 ? 1 : 0));
      vd.applyToMesh(m);
      m.material = this.asphalt;
      m.freezeWorldMatrix();
      m.isPickable = false;
      meshes.push(m);
    }
    // --- lane markings (dashed centre lines on two-way roads) ---
    const mats: number[] = [];
    for (const id of edges) {
      const e = net.edges[id]!;
      if (e.oneway || e.length < 12) continue;
      const h = deHeading(net, id * 2);
      const q = Quaternion.RotationAxis(Vector3.Up(), h);
      for (let s0 = 6; s0 < e.length - 6; s0 += 9) {
        const c = lanePoint(net, id * 2, -0.5, s0);
        Matrix.Compose(new Vector3(1, 1, 1), q, new Vector3(c.x, 0.08, c.z)).asArray().forEach((v) => mats.push(v));
      }
    }
    if (mats.length) {
      const dash = MeshBuilder.CreateBox(`dash-${key}`, { width: 0.18, depth: 3, height: 0.02 }, this.scene);
      dash.material = this.paint;
      dash.thinInstanceSetBuffer('matrix', new Float32Array(mats), 16, true);
      dash.isPickable = false;
      meshes.push(dash);
    }
    // --- buildings (original procedural, identical to the server's collision set) ---
    const [cx, cz] = key.split(',').map(Number) as [number, number];
    const list: Building[] = [];
    if (this.procedural) {
      const b0x = Math.floor((cx * CELL) / BUILDING_CELL);
      const b0z = Math.floor((cz * CELL) / BUILDING_CELL);
      const n = CELL / BUILDING_CELL;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) list.push(...this.procedural.cell(b0x + i, b0z + j));
    } else for (const b of this.buildings) if (cellOf(b.x, b.z) === key) list.push(b);
    if (list.length) {
      const box = MeshBuilder.CreateBox(`bldg-${key}`, { size: 1 }, this.scene);
      box.material = this.bldgMat;
      const bm = new Float32Array(list.length * 16);
      const cols = new Float32Array(list.length * 4);
      const palette = [[0.86, 0.82, 0.74], [0.78, 0.8, 0.82], [0.62, 0.66, 0.72], [0.9, 0.86, 0.8], [0.72, 0.62, 0.55], [0.55, 0.62, 0.66], [0.94, 0.9, 0.7]];
      list.forEach((b, i) => {
        Matrix.Compose(new Vector3(b.w, b.h, b.d), Quaternion.RotationAxis(Vector3.Up(), b.rot ?? 0), new Vector3(b.x, b.h / 2, b.z)).copyToArray(bm, i * 16);
        const c = palette[Math.floor(b.tone * palette.length)]!;
        cols.set([c[0]!, c[1]!, c[2]!, 1], i * 4);
      });
      box.thinInstanceSetBuffer('matrix', bm, 16, true);
      box.thinInstanceSetBuffer('color', cols, 4, true);
      box.isPickable = false;
      meshes.push(box);
    }
    // --- traffic signals at signalised junctions owned by this cell ---
    let signals: SignalCell | null = null;
    const heads: { node: number; heading: number; x: number; z: number }[] = [];
    for (const nid of nodes) {
      if (!net.nodes[nid]!.signal) continue;
      for (const de of incomingDes(net, nid)) {
        const e = net.edges[de >> 1]!;
        const p = lanePoint(net, de, e.oneway ? e.lanes - 0.4 : e.lanes + 0.4, deStop(net, de));
        heads.push({ node: nid, heading: deHeading(net, de), x: p.x, z: p.z });
      }
    }
    if (heads.length) {
      const pole = MeshBuilder.CreateCylinder(`pole-${key}`, { height: 5, diameter: 0.18, tessellation: 6 }, this.scene);
      pole.material = this.poleMat;
      pole.thinInstanceSetBuffer('matrix', new Float32Array(heads.flatMap((h) => Matrix.Translation(h.x, 2.5, h.z).asArray())), 16, true);
      meshes.push(pole);
      const lamps = {} as Record<SignalColor, { on: Mesh; off: Mesh }>;
      (['R', 'A', 'G'] as SignalColor[]).forEach((c, i) => {
        const mk = (on: boolean) => {
          const l = MeshBuilder.CreateSphere(`lamp-${key}-${c}-${on}`, { diameter: 0.34, segments: 4 }, this.scene);
          l.material = on ? this.lampMats[c].on : this.lampMats[c].off;
          l.isPickable = false;
          meshes.push(l);
          return l;
        };
        lamps[c] = { on: mk(true), off: mk(false) };
        void i;
      });
      signals = { heads, lamps, state: '' };
    }
    return { meshes, signals };
  }

  private buildTrafficTemplates() {
    const colors = [new Color3(0.85, 0.85, 0.82), new Color3(0.15, 0.15, 0.18), new Color3(0.9, 0.55, 0.1), new Color3(0.2, 0.35, 0.6)];
    this.trafficTemplates = TRAFFIC_TYPE_BY_CODE.map((type, i) => {
      const t = TRAFFIC_TYPES[type];
      const h = type === 'bus' ? 3.2 : type === 'truck' ? 3 : type === 'motorcycle' ? 1.3 : 1.45;
      const m = MeshBuilder.CreateBox(`tt-${type}`, { width: t.width, depth: t.length, height: h }, this.scene);
      m.material = this.mat(`ttm-${type}`, colors[i]!, 0.3);
      m.isVisible = false;
      return m;
    });
  }

  /* ---------------- dynamic ---------------- */

  setMyCar(teamId: string) {
    this.me?.root.dispose();
    this.me = new CarRig(this.scene, teamColor(teamId), true);
  }

  updateMe(p: CarPose) {
    this.me?.set(p);
  }

  get othersCount() {
    return this.others.size;
  }

  updateOthers(cars: (CarPose & { id: string | number; colorKey: string })[]) {
    const seen = new Set<string | number>();
    for (const c of cars) {
      seen.add(c.id);
      let rig = this.others.get(c.id);
      if (!rig) this.others.set(c.id, (rig = new CarRig(this.scene, teamColor(c.colorKey), false)));
      rig.set(c);
      if (c.label) rig.setLabel(c.label);
    }
    for (const [id, rig] of this.others) if (!seen.has(id)) rig.root.dispose(), this.others.delete(id);
  }

  updateTraffic(items: { id: number; type: number; x: number; z: number; heading: number }[]) {
    const seen = new Set<number>();
    for (const t of items) {
      seen.add(t.id);
      let inst = this.trafficPool.get(t.id);
      if (!inst) {
        inst = this.trafficTemplates[t.type]!.createInstance(`tr${t.id}`);
        this.trafficPool.set(t.id, inst);
      }
      const h = t.type === 2 ? 1.6 : t.type === 3 ? 1.5 : t.type === 1 ? 0.65 : 0.72;
      inst.position.set(t.x, h, t.z);
      inst.rotation.y = t.heading;
      inst.setEnabled(true);
    }
    for (const [id, inst] of this.trafficPool) if (!seen.has(id)) inst.setEnabled(false);
  }

  updateSignals(simMs: number) {
    for (const c of this.cells.values()) {
      const sc = c.signals;
      if (!sc) continue;
      const states = sc.heads.map((h) => signalState(h.node, signalGroup(this.net, h.node, h.heading), simMs, this.seed));
      const key = states.join('');
      if (key === sc.state) continue;
      sc.state = key;
      (['R', 'A', 'G'] as SignalColor[]).forEach((col, i) => {
        const on: number[] = [];
        const off: number[] = [];
        sc.heads.forEach((h, j) => {
          const fx = Math.sin(h.heading);
          const fz = Math.cos(h.heading);
          const m = Matrix.Translation(h.x + fx * 0.2, 5.45 - i * 0.45, h.z + fz * 0.2).asArray();
          (states[j] === col ? on : off).push(...m);
        });
        sc.lamps[col].on.thinInstanceSetBuffer('matrix', new Float32Array(on.length ? on : Matrix.Translation(0, -1000, 0).asArray()), 16, false);
        sc.lamps[col].off.thinInstanceSetBuffer('matrix', new Float32Array(off.length ? off : Matrix.Translation(0, -1000, 0).asArray()), 16, false);
      });
    }
  }

  setRain(rain: boolean) {
    if (rain === this.rain) return;
    this.rain = rain;
    this.scene.clearColor = rain ? new Color4(0.35, 0.4, 0.46, 1) : new Color4(0.55, 0.68, 0.82, 1);
    this.scene.fogColor = rain ? new Color3(0.42, 0.46, 0.52) : new Color3(0.62, 0.72, 0.84);
    this.scene.fogDensity = PRESETS[this.quality].fog * (rain ? 1.8 : 1);
    this.sun.intensity = rain ? 0.6 : 1.6;
  }

  setCameraMode(m: CameraMode) {
    this.camMode = m;
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.scale = Math.max(PRESETS[q].minScale, this.scale);
    this.engine.setHardwareScalingLevel(this.scale);
    this.scene.fogDensity = PRESETS[q].fog * (this.rain ? 1.8 : 1);
  }

  updateCamera(p: CarPose, speed: number, dt: number) {
    this.streamCells(p.x, p.z);
    const fx = Math.sin(p.heading);
    const fz = Math.cos(p.heading);
    let target: Vector3;
    let look: Vector3;
    if (this.camMode === 'hood') {
      target = new Vector3(p.x + fx * 0.6, 1.35, p.z + fz * 0.6);
      look = new Vector3(p.x + fx * 30, 1.0, p.z + fz * 30);
      this.camPos.copyFrom(target);
    } else if (this.camMode === 'top') {
      target = new Vector3(p.x - fx * 2, 70, p.z - fz * 2);
      look = new Vector3(p.x + fx * 8, 0, p.z + fz * 8);
      this.camPos = Vector3.Lerp(this.camPos, target, 1 - Math.exp(-dt * 6));
    } else {
      const back = 8 + Math.min(4, speed * 0.08);
      target = new Vector3(p.x - fx * back, 3.2 + Math.min(1.5, speed * 0.03), p.z - fz * back);
      look = new Vector3(p.x + fx * 6, 1.2, p.z + fz * 6);
      this.camPos = Vector3.Lerp(this.camPos, target, 1 - Math.exp(-dt * 8));
    }
    this.camera.position.copyFrom(this.camPos);
    this.camera.setTarget(look);
    this.camera.fov = this.camMode === 'chase' ? 0.95 + Math.min(0.25, speed * 0.005) : 1.0;
  }

  /** Dynamic resolution: hold ~30 FPS by trading render scale (visual only). */
  adaptResolution() {
    const fps = this.engine.getFps();
    this.fpsWindow.push(fps);
    if (this.fpsWindow.length < 4) return;
    const avg = this.fpsWindow.reduce((a, b) => a + b, 0) / this.fpsWindow.length;
    this.fpsWindow = [];
    const min = PRESETS[this.quality].minScale;
    if (avg < 27 && this.scale < 2.5) this.scale = Math.min(2.5, this.scale + 0.25);
    else if (avg > 50 && this.scale > min) this.scale = Math.max(min, this.scale - 0.25);
    else return;
    this.engine.setHardwareScalingLevel(this.scale);
  }

  get renderScale() {
    return this.scale;
  }

  dispose() {
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}

/** Procedural original car: body, cabin, wheels, head/brake lights. PBR clear-coat paint on the own car. */
class CarRig {
  readonly root: TransformNode;
  private readonly brake: AbstractMesh;
  private readonly brakeOn: StandardMaterial;
  private readonly brakeOff: StandardMaterial;
  private readonly wheels: AbstractMesh[] = [];
  private lastX = 0;
  private lastZ = 0;
  private label: Mesh | null = null;
  private labelText = '';
  private ghost = false;

  constructor(scene: Scene, color: Color3, hero: boolean) {
    const root = (this.root = new TransformNode('car', scene));
    let paint: StandardMaterial | PBRMaterial;
    if (hero) {
      const p = new PBRMaterial('paint', scene);
      p.albedoColor = color;
      p.metallic = 0.6;
      p.roughness = 0.35;
      p.clearCoat.isEnabled = true;
      p.clearCoat.intensity = 0.8;
      paint = p;
    } else {
      const s = new StandardMaterial('paintS', scene);
      s.diffuseColor = color;
      s.specularColor = new Color3(0.5, 0.5, 0.5);
      paint = s;
    }
    const glass = new StandardMaterial('glass', scene);
    glass.diffuseColor = new Color3(0.05, 0.07, 0.1);
    glass.specularColor = new Color3(0.8, 0.8, 0.8);
    const tyre = new StandardMaterial('tyre', scene);
    tyre.diffuseColor = new Color3(0.05, 0.05, 0.05);
    const head = new StandardMaterial('headl', scene);
    head.emissiveColor = new Color3(1, 0.95, 0.8);
    this.brakeOn = new StandardMaterial('brakeOn', scene);
    this.brakeOn.emissiveColor = new Color3(1, 0.05, 0.05);
    this.brakeOff = new StandardMaterial('brakeOff', scene);
    this.brakeOff.diffuseColor = new Color3(0.35, 0.02, 0.02);

    const body = MeshBuilder.CreateBox('body', { width: 1.9, height: 0.55, depth: 4.4 }, scene);
    body.position.y = 0.6;
    body.material = paint;
    body.parent = root;
    const cabin = MeshBuilder.CreateBox('cabin', { width: 1.6, height: 0.5, depth: 2.1 }, scene);
    cabin.position.set(0, 1.12, -0.25);
    cabin.material = glass;
    cabin.parent = root;
    const spoiler = MeshBuilder.CreateBox('spoiler', { width: 1.8, height: 0.08, depth: 0.35 }, scene);
    spoiler.position.set(0, 1.05, -2.05);
    spoiler.material = paint;
    spoiler.parent = root;
    for (const [x, z] of [[-0.95, 1.4], [0.95, 1.4], [-0.95, -1.4], [0.95, -1.4]] as const) {
      const w = MeshBuilder.CreateCylinder('wheel', { diameter: 0.7, height: 0.32, tessellation: 12 }, scene);
      w.rotation.z = Math.PI / 2;
      w.position.set(x, 0.35, z);
      w.material = tyre;
      w.parent = root;
      this.wheels.push(w);
    }
    for (const x of [-0.6, 0.6]) {
      const l = MeshBuilder.CreateBox('hl', { width: 0.45, height: 0.14, depth: 0.05 }, scene);
      l.position.set(x, 0.68, 2.21);
      l.material = head;
      l.parent = root;
    }
    const brake = MeshBuilder.CreateBox('bl', { width: 1.6, height: 0.12, depth: 0.05 }, scene);
    brake.position.set(0, 0.72, -2.21);
    brake.material = this.brakeOff;
    brake.parent = root;
    this.brake = brake;
  }

  /** Squad name above the car (SPEC 2.3: squads can see each other's names). */
  setLabel(text: string) {
    if (text === this.labelText) return;
    this.labelText = text;
    this.label?.dispose(false, true);
    const scene = this.root.getScene();
    const tex = new DynamicTexture('lbl', { width: 512, height: 96 }, scene, false);
    tex.hasAlpha = true;
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 512, 96);
    ctx.fillStyle = 'rgba(11,13,18,0.75)';
    ctx.fillRect(0, 12, 512, 72);
    ctx.font = 'bold 52px system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(text.slice(0, 18), 256, 66);
    tex.update();
    const mat = new StandardMaterial('lblm', scene);
    mat.diffuseTexture = tex;
    mat.emissiveColor = new Color3(1, 1, 1);
    mat.disableLighting = true;
    mat.useAlphaFromDiffuseTexture = true;
    mat.backFaceCulling = false;
    const plane = MeshBuilder.CreatePlane('lblp', { width: 4, height: 0.75 }, scene);
    plane.material = mat;
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    plane.position.y = 2.4;
    plane.parent = this.root;
    plane.isPickable = false;
    this.label = plane;
  }

  /** Ghosted (anti-ramming): visible but translucent and non-collidable. */
  setGhost(g: boolean) {
    if (g === this.ghost) return;
    this.ghost = g;
    for (const m of this.root.getChildMeshes()) if (m !== this.label) m.visibility = g ? 0.35 : 1;
  }

  set(p: CarPose) {
    this.setGhost(!!p.ghost);
    const dist = Math.hypot(p.x - this.lastX, p.z - this.lastZ);
    this.lastX = p.x;
    this.lastZ = p.z;
    this.root.position.set(p.x, 0, p.z);
    this.root.rotation.y = p.heading;
    if (dist < 5) for (const w of this.wheels) w.rotation.x += dist / 0.35;
    const m = p.braking ? this.brakeOn : this.brakeOff;
    if (this.brake.material !== m) this.brake.material = m;
  }
}

