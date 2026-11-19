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
  type AbstractMesh,
  type InstancedMesh,
} from '@babylonjs/core';
import {
  TRAFFIC_TYPES,
  TRAFFIC_TYPE_BY_CODE,
  deHeading,
  deReverse,
  hash32,
  lanePoint,
  signalState,
  axisOfHeading,
  type Building,
  type RoadNetwork,
  type SignalColor,
} from '@redline/shared';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export type CameraMode = 'chase' | 'hood' | 'top';

/** Presets change visuals only — never gameplay (SPEC Part 1). */
const PRESETS: Record<Quality, { minScale: number; fog: number; aa: boolean }> = {
  low: { minScale: 2, fog: 0.004, aa: false },
  medium: { minScale: 1.5, fog: 0.0028, aa: false },
  high: { minScale: 1, fog: 0.002, aa: true },
  ultra: { minScale: 0.75, fog: 0.0014, aa: true },
};

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
  private signalHeads: { node: number; heading: number; lamps: Record<SignalColor, Mesh> }[] = [];
  private lampMats!: Record<SignalColor, { on: StandardMaterial; off: StandardMaterial }>;
  private camMode: CameraMode = 'chase';
  private camPos = new Vector3(0, 30, -30);
  private quality: Quality;
  private scale: number;
  private fpsWindow: number[] = [];
  private rain = false;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly net: RoadNetwork,
    private readonly buildings: Building[],
    private readonly seed: string,
    quality: Quality = 'medium',
  ) {
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
    this.camera.maxZ = 2500;
    this.camera.fov = 1.0;
    this.camera.inputs.clear();

    this.buildGround();
    this.buildRoads();
    this.buildBuildings();
    this.buildSignals();
    this.buildTrafficTemplates();
    scene.freezeActiveMeshes(false);
  }

  /* ---------------- static world ---------------- */

  private mat(name: string, color: Color3, spec = 0.05, emissive?: Color3) {
    const m = new StandardMaterial(name, this.scene);
    m.diffuseColor = color;
    m.specularColor = new Color3(spec, spec, spec);
    if (emissive) m.emissiveColor = emissive;
    return m;
  }

  private buildGround() {
    const b = this.net.bounds;
    const size = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 2.5;
    const g = MeshBuilder.CreateGround('ground', { width: size, height: size }, this.scene);
    g.material = this.mat('grass', new Color3(0.32, 0.4, 0.26));
    g.freezeWorldMatrix();
    // Boundary walls so the edge of the playable area is visible.
    const wallMat = this.mat('wall', new Color3(0.55, 0.52, 0.48));
    const w = b.maxX - b.minX;
    const d = b.maxZ - b.minZ;
    for (const [x, z, sx, sz] of [
      [(b.minX + b.maxX) / 2, b.minZ - 1, w, 2],
      [(b.minX + b.maxX) / 2, b.maxZ + 1, w, 2],
      [b.minX - 1, (b.minZ + b.maxZ) / 2, 2, d],
      [b.maxX + 1, (b.minZ + b.maxZ) / 2, 2, d],
    ] as const) {
      const m = MeshBuilder.CreateBox('bwall', { width: sx, depth: sz, height: 3 }, this.scene);
      m.position.set(x, 1.5, z);
      m.material = wallMat;
      m.freezeWorldMatrix();
    }
  }

  private buildRoads() {
    const net = this.net;
    const asphalt = this.mat('asphalt', new Color3(0.16, 0.16, 0.18), 0.15);
    const kerbMat = this.mat('kerb', new Color3(0.62, 0.6, 0.56));
    const W = net.halfWidth * 2;
    const roadMeshes: Mesh[] = [];
    for (const e of net.edges) {
      const a = net.nodes[e.a]!;
      const b = net.nodes[e.b]!;
      const h = Math.atan2(b.x - a.x, b.z - a.z);
      const road = MeshBuilder.CreateBox(`road${e.id}`, { width: W, depth: e.length, height: 0.1 }, this.scene);
      road.position.set((a.x + b.x) / 2, 0.05, (a.z + b.z) / 2);
      road.rotation.y = h;
      roadMeshes.push(road);
      for (const side of [-1, 1]) {
        const k = MeshBuilder.CreateBox(`kerb${e.id}${side}`, { width: 5, depth: e.length - W, height: 0.22 }, this.scene);
        const ox = Math.cos(h) * side * (net.halfWidth + 2.5);
        const oz = -Math.sin(h) * side * (net.halfWidth + 2.5);
        k.position.set((a.x + b.x) / 2 + ox, 0.11, (a.z + b.z) / 2 + oz);
        k.rotation.y = h;
        roadMeshes.push(k);
        k.material = kerbMat;
      }
    }
    for (const n of net.nodes) {
      const pad = MeshBuilder.CreateBox(`junction${n.id}`, { width: W, depth: W, height: 0.1 }, this.scene);
      pad.position.set(n.x, 0.051, n.z);
      roadMeshes.push(pad);
    }
    for (const m of roadMeshes) if (!m.material) m.material = asphalt;
    const merged = Mesh.MergeMeshes(roadMeshes.filter((m) => m.material === asphalt), true, true);
    merged?.freezeWorldMatrix();
    const kerbs = Mesh.MergeMeshes(roadMeshes.filter((m) => !m.isDisposed() && m.material === kerbMat), true, true);
    kerbs?.freezeWorldMatrix();

    // Lane markings: thin instances of one dash mesh (one draw call).
    const dash = MeshBuilder.CreateBox('dash', { width: 0.18, depth: 3, height: 0.02 }, this.scene);
    dash.material = this.mat('paint', new Color3(0.9, 0.9, 0.85), 0, new Color3(0.35, 0.35, 0.33));
    const mats: number[] = [];
    const push = (x: number, z: number, h: number, sx = 1, sz = 1) => {
      const m = Matrix.Compose(new Vector3(sx, 1, sz), Quaternion.RotationAxis(Vector3.Up(), h), new Vector3(x, 0.11, z));
      mats.push(...m.asArray());
    };
    for (const e of net.edges) {
      const de = e.id * 2;
      const h = deHeading(net, de);
      for (let s = net.junctionRadius + 2; s < e.length - net.junctionRadius - 2; s += 8) {
        const c = lanePoint(net, de, -0.5, s); // centre line (between directions)
        push(c.x, c.z, h, 1.2, 1);
        for (const dir of [de, deReverse(de)]) {
          const l = lanePoint(net, dir, 0.5, dir === de ? s : e.length - s); // between lanes 0 and 1
          push(l.x, l.z, h);
        }
      }
      // Stop lines
      for (const dir of [de, deReverse(de)]) {
        const sl = lanePoint(net, dir, 0.5, e.length - net.junctionRadius);
        const hh = deHeading(net, dir);
        const m = Matrix.Compose(new Vector3(40, 1, 0.15), Quaternion.RotationAxis(Vector3.Up(), hh), new Vector3(sl.x, 0.11, sl.z));
        mats.push(...m.asArray());
      }
    }
    dash.thinInstanceSetBuffer('matrix', new Float32Array(mats), 16, true);
  }

  private buildBuildings() {
    const box = MeshBuilder.CreateBox('bldg', { size: 1 }, this.scene);
    const m = this.mat('bldgMat', new Color3(1, 1, 1), 0.1);
    box.material = m;
    const mats = new Float32Array(this.buildings.length * 16);
    const cols = new Float32Array(this.buildings.length * 4);
    const palette = [
      [0.86, 0.82, 0.74], [0.78, 0.8, 0.82], [0.62, 0.66, 0.72], [0.9, 0.86, 0.8], [0.72, 0.62, 0.55], [0.55, 0.62, 0.66],
    ];
    this.buildings.forEach((b, i) => {
      Matrix.Compose(new Vector3(b.w, b.h, b.d), Quaternion.Identity(), new Vector3(b.x, b.h / 2, b.z)).copyToArray(mats, i * 16);
      const c = palette[Math.floor(b.tone * palette.length)]!;
      cols.set([c[0]!, c[1]!, c[2]!, 1], i * 4);
    });
    box.thinInstanceSetBuffer('matrix', mats, 16, true);
    box.thinInstanceSetBuffer('color', cols, 4, true);
  }

  private buildSignals() {
    const net = this.net;
    const pole = MeshBuilder.CreateCylinder('pole', { height: 5, diameter: 0.18, tessellation: 6 }, this.scene);
    pole.material = this.mat('poleMat', new Color3(0.2, 0.2, 0.22));
    const head = MeshBuilder.CreateBox('head', { width: 0.5, height: 1.4, depth: 0.4 }, this.scene);
    head.material = this.mat('headMat', new Color3(0.08, 0.08, 0.09));
    const lampColors: Record<SignalColor, Color3> = { R: new Color3(1, 0.1, 0.08), A: new Color3(1, 0.65, 0.05), G: new Color3(0.1, 1, 0.35) };
    this.lampMats = Object.fromEntries(
      (Object.keys(lampColors) as SignalColor[]).map((k) => [
        k,
        { on: this.mat(`lamp${k}on`, lampColors[k], 0, lampColors[k]), off: this.mat(`lamp${k}off`, lampColors[k].scale(0.15), 0) },
      ]),
    ) as never;
    const poleM: number[] = [];
    const headM: number[] = [];
    for (const n of net.nodes) {
      if (!n.signal) continue;
      for (const out of net.out[n.id]!) {
        const incoming = deReverse(out); // edge arriving at n
        const h = deHeading(net, incoming);
        const e = net.edges[incoming >> 1]!;
        // Signal head on the left kerb at the stop line (keep-left traffic).
        const p = lanePoint(net, incoming, 2.4, e.length - net.junctionRadius);
        poleM.push(...Matrix.Compose(Vector3.One(), Quaternion.Identity(), new Vector3(p.x, 2.5, p.z)).asArray());
        headM.push(...Matrix.Compose(Vector3.One(), Quaternion.RotationAxis(Vector3.Up(), h), new Vector3(p.x, 5, p.z)).asArray());
        const lamps = {} as Record<SignalColor, Mesh>;
        (['R', 'A', 'G'] as SignalColor[]).forEach((c, i) => {
          const l = MeshBuilder.CreateSphere(`lamp${n.id}-${incoming}-${c}`, { diameter: 0.32, segments: 6 }, this.scene);
          const back = -0.22;
          l.position.set(p.x - Math.sin(h) * back, 5.45 - i * 0.45, p.z - Math.cos(h) * back);
          l.material = this.lampMats[c].off;
          l.freezeWorldMatrix();
          lamps[c] = l;
        });
        this.signalHeads.push({ node: n.id, heading: h, lamps });
      }
    }
    pole.thinInstanceSetBuffer('matrix', new Float32Array(poleM), 16, true);
    head.thinInstanceSetBuffer('matrix', new Float32Array(headM), 16, true);
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
    for (const s of this.signalHeads) {
      const c = signalState(s.node, axisOfHeading(s.heading), simMs, this.seed);
      for (const k of ['R', 'A', 'G'] as SignalColor[]) {
        const m = k === c ? this.lampMats[k].on : this.lampMats[k].off;
        if (s.lamps[k].material !== m) s.lamps[k].material = m;
      }
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

