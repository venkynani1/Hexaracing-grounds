/**
 * Squad cars from the licensed GLB (Khronos "Car Concept", CC-BY 4.0 — see docs/ASSETS.md).
 *
 * The GLB is normalised once into templates: body meshes merged by material (few draw calls), four wheel
 * meshes re-centred on their hubs (so they can spin and steer), front aligned to +Z, ground at y = 0.
 *  - your own car: the hero LOD, its own materials, animated steering, spinning wheels, body roll/pitch,
 *    brake lights, headlights, nitro flame, tyre smoke.
 *  - other squads: instances of LOD1 (near) / LOD2 (far); one draw call per template mesh for ALL cars,
 *    paint colour per car through an instanced colour buffer.
 * Visual only — positions come from the server/prediction exactly as before.
 */
import {
  Color3,
  Color4,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  StandardMaterial,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type AssetContainer,
  type InstancedMesh,
  type Material,
  type Scene,
} from '@babylonjs/core';

export type WheelKey = 'FL' | 'FR' | 'RL' | 'RR';
const WHEELS: [WheelKey, RegExp][] = [
  ['FL', /WheelFrontL/],
  ['FR', /WheelFrontR/],
  ['RL', /WheelRearL/],
  ['RR', /WheelRearR/],
];

export interface CarTemplate {
  body: Mesh[];
  wheels: Record<WheelKey, { meshes: Mesh[]; center: Vector3 }>;
  paint: Mesh[];
  brake: Mesh[];
  radius: number;
  length: number;
  width: number;
}

const ancestorWheel = (m: AbstractMesh): WheelKey | null => {
  for (let n: TransformNode | AbstractMesh | null = m; n; n = n.parent as TransformNode | null) for (const [k, re] of WHEELS) if (re.test(n.name)) return k;
  return null;
};

/** Normalise a loaded car container into merged, re-centred templates (disabled; used as instance sources). */
export function buildCarTemplate(container: AssetContainer, scene: Scene, tag: string): CarTemplate {
  container.addAllToScene();
  const root = container.meshes[0]!;
  root.computeWorldMatrix(true);
  const geo = container.meshes.filter((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
  for (const m of geo) m.computeWorldMatrix(true);
  const centerOf = (re: RegExp) => {
    const ms = geo.filter((m) => re.test(m.name));
    if (!ms.length) return null;
    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = min.scale(-1);
    for (const m of ms) {
      const b = m.getBoundingInfo().boundingBox;
      min = Vector3.Minimize(min, b.minimumWorld);
      max = Vector3.Maximize(max, b.maximumWorld);
    }
    return min.add(max).scale(0.5);
  };
  // Front = headlights side. Rotate so the car faces +Z (our heading 0 = north).
  const head = centerOf(/Headlights/) ?? new Vector3(0, 0, 1);
  const tail = centerOf(/Taillights$/) ?? new Vector3(0, 0, -1);
  const yaw = Math.atan2(head.x - tail.x, head.z - tail.z);

  // Bake every mesh into car space.
  const groups = new Map<string, Mesh[]>();
  for (const m of geo) {
    const wk = ancestorWheel(m) ?? 'body';
    m.setParent(null);
    m.bakeCurrentTransformIntoVertices();
    m.rotation.set(0, -yaw, 0);
    m.bakeCurrentTransformIntoVertices();
    if (m.isVerticesDataPresent('tangent')) m.removeVerticesData('tangent');
    const key = `${wk}|${m.material?.uniqueId ?? 'none'}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(m);
  }
  root.dispose(false, false);
  // Ground offset + centre on the wheelbase.
  let min = new Vector3(Infinity, Infinity, Infinity);
  let max = min.scale(-1);
  for (const ms of groups.values())
    for (const m of ms) {
      m.refreshBoundingInfo();
      const b = m.getBoundingInfo().boundingBox;
      min = Vector3.Minimize(min, b.minimumWorld);
      max = Vector3.Maximize(max, b.maximumWorld);
    }
  const shift = new Vector3(-(min.x + max.x) / 2, -min.y, -(min.z + max.z) / 2);

  const merged = new Map<string, Mesh>();
  for (const [key, ms] of groups) {
    for (const m of ms) (m.position.copyFrom(shift), m.bakeCurrentTransformIntoVertices());
    let mesh: Mesh | null = ms[0]!;
    if (ms.length > 1) {
      try {
        mesh = Mesh.MergeMeshes(ms, true, true, undefined, false, false);
      } catch {
        mesh = null;
      }
      if (!mesh) {
        // Incompatible attribute sets — keep them separate rather than fail.
        ms.forEach((m, i) => merged.set(`${key}#${i}`, m));
        continue;
      }
    }
    mesh.name = `${tag}:${key}`;
    merged.set(key, mesh);
  }

  const tpl: CarTemplate = {
    body: [],
    wheels: { FL: { meshes: [], center: Vector3.Zero() }, FR: { meshes: [], center: Vector3.Zero() }, RL: { meshes: [], center: Vector3.Zero() }, RR: { meshes: [], center: Vector3.Zero() } },
    paint: [],
    brake: [],
    radius: 0.34,
    length: max.z - min.z,
    width: max.x - min.x,
  };
  for (const [key, mesh] of merged) {
    const wk = key.split('|')[0] as WheelKey | 'body';
    mesh.isPickable = false;
    mesh.setEnabled(false);
    mesh.alwaysSelectAsActiveMesh = false;
    const mat = mesh.material;
    if (mat && /^Paint/.test(mat.name)) tpl.paint.push(mesh);
    if (mat && /Brakelight/.test(mat.name)) tpl.brake.push(mesh);
    if (wk === 'body') tpl.body.push(mesh);
    else tpl.wheels[wk].meshes.push(mesh);
  }
  // Re-centre wheels on their hubs.
  for (const k of ['FL', 'FR', 'RL', 'RR'] as WheelKey[]) {
    const w = tpl.wheels[k];
    if (!w.meshes.length) continue;
    let wmin = new Vector3(Infinity, Infinity, Infinity);
    let wmax = wmin.scale(-1);
    for (const m of w.meshes) {
      m.refreshBoundingInfo();
      const b = m.getBoundingInfo().boundingBox;
      wmin = Vector3.Minimize(wmin, b.minimumWorld);
      wmax = Vector3.Maximize(wmax, b.maximumWorld);
    }
    w.center = wmin.add(wmax).scale(0.5);
    tpl.radius = (wmax.y - wmin.y) / 2;
    for (const m of w.meshes) (m.position.copyFrom(w.center.scale(-1)), m.bakeCurrentTransformIntoVertices());
  }
  // Paint: neutral base so per-car colour (instance buffer / material) defines it.
  for (const m of tpl.paint) {
    const pm = m.material as PBRMaterial;
    pm.albedoColor = new Color3(1, 1, 1);
  }
  void scene;
  return tpl;
}

/* ------------------------------------------------------------------------------------------------------- */

export interface CarPose {
  x: number;
  z: number;
  heading: number;
  braking?: boolean;
  ghost?: boolean;
  label?: string;
  /** −1…1 steering (own car) */
  steer?: number;
  /** m/s forward */
  speed?: number;
  nitro?: boolean;
  /** lateral slip (m/s) for tyre smoke */
  slip?: number;
}

/** Contact shadow texture (soft ellipse), shared. */
let shadowTex: DynamicTexture | null = null;
let shadowMat: StandardMaterial | null = null;
export function contactShadow(scene: Scene, w: number, l: number): Mesh {
  if (!shadowTex || shadowTex.getScene() !== scene || !shadowMat) {
    shadowTex = new DynamicTexture('contact-shadow', { width: 128, height: 128 }, scene, true);
    const ctx = shadowTex.getContext() as unknown as CanvasRenderingContext2D;
    const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
    g.addColorStop(0, 'rgba(0,0,0,0.85)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.55)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    shadowTex.update();
    shadowTex.hasAlpha = true;
    const m = (shadowMat = new StandardMaterial('contact-mat', scene));
    m.diffuseTexture = shadowTex;
    m.useAlphaFromDiffuseTexture = true;
    m.disableLighting = true;
    m.emissiveColor = Color3.Black();
    m.zOffset = -2;
    m.backFaceCulling = false;
  }
  const p = MeshBuilder.CreateGround('contact', { width: w * 1.25, height: l * 1.12 }, scene);
  p.material = shadowMat;
  p.position.y = 0.03;
  p.isPickable = false;
  return p;
}

/** Your own car: the hero LOD, animated. */
export class HeroCar {
  readonly root: TransformNode;
  private readonly body: TransformNode;
  private readonly wheelSteer: Partial<Record<WheelKey, TransformNode>> = {};
  private readonly wheelSpin: Partial<Record<WheelKey, TransformNode>> = {};
  private readonly brakeMats: PBRMaterial[] = [];
  private lastX = 0;
  private lastZ = 0;
  private lastSpeed = 0;
  private roll = 0;
  private pitch = 0;
  private spin = 0;
  private ghost = false;
  readonly exhaust: TransformNode;
  readonly rearWheels: TransformNode[] = [];

  constructor(scene: Scene, readonly tpl: CarTemplate, color: Color3) {
    this.root = new TransformNode('hero', scene);
    this.body = new TransformNode('hero-body', scene);
    this.body.parent = this.root;
    const paintMat = new Map<Material, PBRMaterial>();
    for (const t of tpl.body) {
      const m = t.clone(`hero-${t.name}`, this.body, true, false)!;
      m.setEnabled(true);
      m.isPickable = false;
      this.recolor(m, color, paintMat);
    }
    for (const k of ['FL', 'FR', 'RL', 'RR'] as WheelKey[]) {
      const w = tpl.wheels[k];
      const steer = new TransformNode(`hero-steer-${k}`, scene);
      steer.parent = this.root;
      steer.position.copyFrom(w.center);
      const spin = new TransformNode(`hero-spin-${k}`, scene);
      spin.parent = steer;
      for (const t of w.meshes) {
        const m = t.clone(`hero-${t.name}`, spin, true, false)!;
        m.setEnabled(true);
        m.isPickable = false;
      }
      this.wheelSteer[k] = steer;
      this.wheelSpin[k] = spin;
      if (k[0] === 'R') this.rearWheels.push(steer);
    }
    const sh = contactShadow(scene, tpl.width, tpl.length);
    sh.parent = this.root;
    this.exhaust = new TransformNode('hero-exhaust', scene);
    this.exhaust.parent = this.root;
    this.exhaust.position.set(0, 0.35, -tpl.length / 2 - 0.1);
    for (const m of this.root.getChildMeshes()) {
      const mat = m.material;
      if (mat instanceof PBRMaterial && /Brakelight/.test(mat.name) && !this.brakeMats.includes(mat)) {
        const own = mat.clone(`hero-brake`);
        m.material = own;
        this.brakeMats.push(own);
      }
    }
  }

  private recolor(m: Mesh, color: Color3, cache: Map<Material, PBRMaterial>) {
    const mat = m.material;
    if (!(mat instanceof PBRMaterial) || !/^Paint/.test(mat.name)) return;
    let own = cache.get(mat);
    if (!own) {
      own = mat.clone(`hero-${mat.name}`);
      // "Paint 1" = main body colour; "Paint 2" = darker accent panels.
      own.albedoColor = /Paint 2/.test(mat.name) ? color.scale(0.18) : color;
      own.metallic = 0.25;
      own.roughness = 0.32;
      own.clearCoat.isEnabled = true;
      own.clearCoat.intensity = 1;
      own.clearCoat.roughness = 0.04;
      cache.set(mat, own);
    }
    m.material = own;
  }

  setGhost(g: boolean) {
    if (g === this.ghost) return;
    this.ghost = g;
    for (const m of this.root.getChildMeshes()) m.visibility = g ? 0.4 : 1;
  }

  set(p: CarPose, dt: number) {
    this.setGhost(!!p.ghost);
    const dist = Math.hypot(p.x - this.lastX, p.z - this.lastZ);
    this.lastX = p.x;
    this.lastZ = p.z;
    this.root.position.set(p.x, 0, p.z);
    this.root.rotation.y = p.heading;
    const v = p.speed ?? (dt > 0 ? dist / dt : 0);
    if (dist < 5) this.spin += (Math.sign(v) || 1) * (dist / this.tpl.radius);
    const steerAngle = (p.steer ?? 0) * 0.55;
    for (const k of ['FL', 'FR', 'RL', 'RR'] as WheelKey[]) {
      this.wheelSpin[k]!.rotation.x = this.spin;
      if (k[0] === 'F') this.wheelSteer[k]!.rotation.y = steerAngle;
    }
    // Weight transfer: pitch with longitudinal acceleration, roll with lateral load (steer × speed²).
    if (dt > 0) {
      const accel = (v - this.lastSpeed) / dt;
      this.lastSpeed = v;
      const tp = Math.max(-0.035, Math.min(0.035, -accel * 0.006));
      const tr = Math.max(-0.05, Math.min(0.05, (p.steer ?? 0) * v * v * 0.00012));
      const k = 1 - Math.exp(-dt * 6);
      this.pitch += (tp - this.pitch) * k;
      this.roll += (tr - this.roll) * k;
      this.body.rotation.x = this.pitch;
      this.body.rotation.z = this.roll;
    }
    for (const m of this.brakeMats) m.emissiveIntensity = p.braking ? 6 : 1;
  }

  dispose() {
    this.root.dispose(false, false);
  }
}

/** Shared instance sources for other squads' cars (LOD1 near, LOD2 far). */
export class CarFleet {
  private readonly cars = new Map<string | number, FleetCar>();
  private brakeOnTemplates: Mesh[] = [];
  constructor(
    private readonly scene: Scene,
    private readonly lod1: CarTemplate | null,
    private readonly lod2: CarTemplate | null,
  ) {
    for (const t of [lod1, lod2]) {
      if (!t) continue;
      for (const m of t.paint) m.registerInstancedBuffer('color', 4), (m.instancedBuffers.color = new Color4(1, 1, 1, 1));
    }
    // Lit brake-light variant for LOD1 (toggled per car).
    if (lod1)
      this.brakeOnTemplates = lod1.brake.map((b) => {
        const c = b.clone(`${b.name}-on`, null, true, false)!;
        const mat = (b.material as PBRMaterial).clone('brake-on');
        mat.emissiveColor = new Color3(1, 0.05, 0.03);
        mat.emissiveIntensity = 5;
        c.material = mat;
        c.setEnabled(false);
        return c;
      });
  }

  /** Distance (m) under which the detailed LOD is used. */
  lod1Distance = 70;

  get size() {
    return this.cars.size;
  }

  update(list: (CarPose & { id: string | number; color: Color3 })[], cam: Vector3, dt: number, now: number) {
    const seen = new Set<string | number>();
    for (const c of list) {
      seen.add(c.id);
      let car = this.cars.get(c.id);
      if (!car) this.cars.set(c.id, (car = new FleetCar(this.scene, this.lod1, this.lod2, this.brakeOnTemplates, c.color)));
      car.lod1Distance = this.lod1Distance;
      car.set(c, cam, dt, now);
      if (c.label) car.setLabel(c.label);
    }
    for (const [id, car] of this.cars) if (!seen.has(id)) (car.dispose(), this.cars.delete(id));
  }

  /** Near (LOD1) car meshes — shadow casters. */
  shadowCasters(): AbstractMesh[] {
    const out: AbstractMesh[] = [];
    for (const c of this.cars.values()) out.push(...c.casters());
    return out;
  }

  dispose() {
    for (const c of this.cars.values()) c.dispose();
    this.cars.clear();
  }
}

class FleetCar {
  readonly root: TransformNode;
  private readonly lods: { node: TransformNode; spin: TransformNode[]; steer: TransformNode[]; brakeOff: InstancedMesh[]; brakeOn: InstancedMesh[] }[] = [];
  private lodIdx = -1;
  private lastX = NaN;
  private lastZ = 0;
  private lastH = 0;
  private spin = 0;
  private label: Mesh | null = null;
  private labelText = '';
  private readonly radius: number;
  lod1Distance = 70;

  constructor(scene: Scene, lod1: CarTemplate | null, lod2: CarTemplate | null, brakeOnTpl: Mesh[], color: Color3) {
    this.root = new TransformNode('car', scene);
    this.radius = (lod1 ?? lod2)?.radius ?? 0.34;
    for (const tpl of [lod1, lod2]) {
      const node = new TransformNode('lod', scene);
      node.parent = this.root;
      const entry = { node, spin: [] as TransformNode[], steer: [] as TransformNode[], brakeOff: [] as InstancedMesh[], brakeOn: [] as InstancedMesh[] };
      if (tpl) {
        for (const t of tpl.body) {
          const inst = t.createInstance(`${t.name}-i`);
          inst.parent = node;
          inst.isPickable = false;
          if (tpl.paint.includes(t)) inst.instancedBuffers.color = new Color4(color.r, color.g, color.b, 1);
          if (tpl.brake.includes(t)) entry.brakeOff.push(inst);
        }
        if (tpl === lod1)
          for (const t of brakeOnTpl) {
            const inst = t.createInstance(`${t.name}-i`);
            inst.parent = node;
            inst.setEnabled(false);
            entry.brakeOn.push(inst);
          }
        for (const k of ['FL', 'FR', 'RL', 'RR'] as WheelKey[]) {
          const w = tpl.wheels[k];
          const steer = new TransformNode('w', scene);
          steer.parent = node;
          steer.position.copyFrom(w.center);
          const spin = new TransformNode('ws', scene);
          spin.parent = steer;
          for (const t of w.meshes) {
            const inst = t.createInstance(`${t.name}-i`);
            inst.parent = spin;
            inst.isPickable = false;
          }
          entry.spin.push(spin);
          if (k[0] === 'F') entry.steer.push(steer);
        }
        const sh = contactShadow(scene, tpl.width, tpl.length);
        sh.parent = node;
      }
      node.setEnabled(false);
      this.lods.push(entry);
    }
  }

  casters(): AbstractMesh[] {
    return this.lodIdx === 0 ? this.lods[0]!.node.getChildMeshes().filter((m) => m.name !== 'contact') : [];
  }

  set(p: CarPose, cam: Vector3, dt: number, now: number) {
    if (Number.isNaN(this.lastX)) (this.lastX = p.x), (this.lastZ = p.z), (this.lastH = p.heading);
    const dist = Math.hypot(p.x - this.lastX, p.z - this.lastZ);
    let dh = p.heading - this.lastH;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    this.lastX = p.x;
    this.lastZ = p.z;
    this.lastH = p.heading;
    this.root.position.set(p.x, 0, p.z);
    this.root.rotation.y = p.heading;
    const d = Math.hypot(cam.x - p.x, cam.z - p.z);
    const want = d < this.lod1Distance ? 0 : 1;
    if (want !== this.lodIdx) {
      this.lods.forEach((l, i) => l.node.setEnabled(i === want));
      this.lodIdx = want;
    }
    // Ghost-out (anti-ramming): blink so it reads as non-solid.
    this.root.setEnabled(!p.ghost || Math.floor(now / 160) % 2 === 0);
    if (dist < 5) this.spin += dist / this.radius;
    // Steering estimated from yaw rate (bicycle model, 2.6 m wheelbase).
    const steer = dist > 0.01 ? Math.max(-0.5, Math.min(0.5, Math.atan((dh * 2.6) / dist))) : 0;
    const l = this.lods[this.lodIdx]!;
    for (const s of l.spin) s.rotation.x = this.spin;
    for (const s of l.steer) s.rotation.y = steer;
    for (const b of l.brakeOff) b.setEnabled(!p.braking);
    for (const b of l.brakeOn) b.setEnabled(!!p.braking);
    if (this.label) this.label.setEnabled(d < 160);
    void dt;
  }

  /** Squad name above the car (SPEC 2.3: squads can see each other's names). */
  setLabel(text: string) {
    if (text === this.labelText) return;
    this.labelText = text;
    this.label?.dispose(false, true);
    this.label = null;
    const scene = this.root.getScene();
    const tex = new DynamicTexture('lbl', { width: 512, height: 96 }, scene, false);
    tex.hasAlpha = true;
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 512, 96);
    ctx.fillStyle = 'rgba(8,10,14,0.72)';
    const w = Math.min(500, 40 + text.slice(0, 18).length * 26);
    ctx.beginPath();
    ctx.roundRect?.(256 - w / 2, 16, w, 64, 32);
    ctx.fill();
    ctx.font = '600 44px system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(text.slice(0, 18), 256, 63);
    tex.update();
    const mat = new StandardMaterial('lblm', scene);
    mat.diffuseTexture = tex;
    mat.emissiveColor = new Color3(1, 1, 1);
    mat.disableLighting = true;
    mat.useAlphaFromDiffuseTexture = true;
    mat.backFaceCulling = false;
    mat.fogEnabled = false;
    const plane = MeshBuilder.CreatePlane('lblp', { width: 3.2, height: 0.6 }, scene);
    plane.material = mat;
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    plane.position.y = 2.1;
    plane.parent = this.root;
    plane.isPickable = false;
    this.label = plane;
  }

  dispose() {
    this.label?.dispose(false, true);
    this.root.dispose(false, false);
  }
}
