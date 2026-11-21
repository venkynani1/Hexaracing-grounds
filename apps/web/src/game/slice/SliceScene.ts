/**
 * Vertical-slice renderer. Mobile-first by construction (see docs/PERF_AUDIT.md for the measurements behind it):
 *  - bounded static world, built once, merged per material, baked lighting, unlit materials, frozen;
 *  - ONE lit object class: cars (PBR + small prefiltered HDR environment, clear-coat paint);
 *  - no shadow map: baked static shadows + per-car contact shadow + sun-projected soft shadow;
 *  - no post-processing pass: ACES tone mapping in the material shaders, MSAA off, adaptive resolution;
 *  - shader warm-up before the first interactive frame.
 * Visual only. Positions come from the shared vehicle physics / traffic AI.
 */
import {
  Color3,
  Color4,
  DynamicTexture,
  Engine,
  HDRCubeTexture,
  HemisphericLight,
  ImageProcessingConfiguration,
  Matrix,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  UniversalCamera,
  Vector3,
  type AbstractMesh,
} from '@babylonjs/core';
import { ProceduralBuildings, signalGroup, signalState, stationExclusions, type SignalColor, type WorldMap } from '@redline/shared';
import { ASSET_BASE, configureKtx2, loadContainer } from '../render/assets';
import { Fx } from '../render/fx';
import { CarFleet, HeroCar, buildCarTemplate, type CarPose, type CarTemplate } from '../render/vehicles';
import { SUN } from './bake';
import { buildSlice, setSliceKtx2, type SliceStatic } from './build';
import { Vegetation } from './vegetation';
import type { Corridor } from './corridor';

export type SliceQuality = 'low' | 'medium' | 'high';

/**
 * Measurement switches (never used in normal play):
 *  ?off=veg,traffic,scenery,fx,wetrefl,env   — disable one feature at a time
 *  ?bench=A  car + road only · B  car + road + vegetation · C  full (traffic, lighting, weather via ?rain=1)
 */
export const OFF: ReadonlySet<string> = (() => {
  const q = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const s = new Set((q.get('off') ?? '').split(',').filter(Boolean));
  if (q.get('noveg') === '1') s.add('veg');
  const b = (q.get('bench') ?? '').toUpperCase();
  if (b === 'A') ['veg', 'traffic', 'scenery', 'fx'].forEach((k) => s.add(k));
  if (b === 'B') ['traffic', 'scenery', 'fx'].forEach((k) => s.add(k));
  return s;
})();
/** materials kept in bench A/B ("car + road"): carriageway, markings, kerbs, footpaths, verges */
const ROAD_MATS = new Set(['s-asphalt', 's-paint', 's-kerb', 's-pavers', 's-grass', 's-ground']);
const Q: Record<SliceQuality, { minScale: number; maxScale: number; fog: number; hero: boolean; particles: number; env: number }> = {
  low: { minScale: 1.6, maxScale: 2.6, fog: 0.0034, hero: false, particles: 0.3, env: 32 },
  medium: { minScale: 1.25, maxScale: 2.2, fog: 0.003, hero: false, particles: 0.6, env: 64 },
  high: { minScale: 1, maxScale: 2, fog: 0.0026, hero: true, particles: 1, env: 128 },
};
const FOG_DRY = new Color3(0.78, 0.8, 0.82);
const FOG_RAIN = new Color3(0.5, 0.54, 0.58);

export class SliceScene {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: UniversalCamera;
  private hero: HeroCar | null = null;
  private fleet: CarFleet | null = null;
  private fx: Fx;
  private world: SliceStatic | null = null;
  private lamps: Record<SignalColor, { on: Mesh; off: Mesh }> | null = null;
  private signalKey = '';
  private camPos = new Vector3();
  private camYaw = 0;
  private scale: number;
  private fpsWin: number[] = [];
  private rain = false;
  private sunShadow: Mesh | null = null;
  private resLocked = false;
  quality: SliceQuality;
  stats = { buildMs: 0, bakeMs: 0, vertices: 0, triangles: 0, staticMeshes: 0, warmupMs: 0 };

  constructor(
    canvas: HTMLCanvasElement,
    private readonly map: WorldMap,
    private readonly cor: Corridor,
    quality: SliceQuality,
  ) {
    this.quality = quality;
    this.engine = new Engine(canvas, false, { stencil: false, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false }, false);
    this.scale = Math.max(Q[quality].minScale, 1 / Math.min(devicePixelRatio || 1, 2));
    this.engine.setHardwareScalingLevel(this.scale);
    const scene = (this.scene = new Scene(this.engine));
    scene.skipPointerMovePicking = true;
    scene.autoClear = true;
    scene.clearColor = new Color4(FOG_DRY.r, FOG_DRY.g, FOG_DRY.b, 1);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogColor = FOG_DRY.clone();
    scene.fogDensity = Q[quality].fog;
    const ip = scene.imageProcessingConfiguration;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = 1.25;
    ip.contrast = 1.18;
    // Only cars are lit: a single hemispheric fill + IBL (no shadow-casting light at all).
    const hemi = new HemisphericLight('hemi', new Vector3(-SUN.x, -SUN.y, -SUN.z), scene);
    hemi.intensity = 1.4;
    hemi.diffuse = new Color3(1, 0.95, 0.86);
    hemi.groundColor = new Color3(0.3, 0.28, 0.25);
    this.camera = new UniversalCamera('cam', new Vector3(0, 5, 0), scene);
    this.camera.minZ = 0.5;
    this.camera.maxZ = 1600;
    this.camera.fov = 0.95;
    this.camera.inputs.clear();
    this.fx = new Fx(scene, Q[quality].particles);
    this.buildSky();
  }

  private buildSky() {
    const scene = this.scene;
    const dome = MeshBuilder.CreateSphere('sky', { diameter: 3000, segments: 16, sideOrientation: Mesh.BACKSIDE }, scene);
    const mat = new StandardMaterial('sky-mat', scene);
    mat.disableLighting = true;
    mat.fogEnabled = false;
    mat.backFaceCulling = false;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    dome.material = mat;
    dome.infiniteDistance = true;
    dome.isPickable = false;
    mat.disableDepthWrite = true;
    this.skyMat = mat;
  }
  private skyMat!: StandardMaterial;

  /** Load licensed assets, build + bake the static world, warm up shaders. */
  async load(onProgress: (p: number, label: string) => void) {
    const scene = this.scene;
    const ktx = new URLSearchParams(location.search).get('ktx2') !== '0';
    setSliceKtx2(ktx);
    configureKtx2();
    const sky = new Texture(`${ASSET_BASE}/env/${ktx ? 'sky.ktx2' : 'sky.webp'}`, scene, true, true);
    sky.uScale = -1;
    sky.wrapU = Texture.WRAP_ADDRESSMODE;
    sky.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.skyMat.emissiveTexture = sky;
    onProgress(0.02, 'Cars');
    const P = Q[this.quality];
    const [hero, lod1, lod2] = await Promise.all([
      P.hero && !OFF.has('hero') ? loadContainer(scene, 'cars/car_hero.glb') : loadContainer(scene, 'cars/car_lod1.glb'),
      loadContainer(scene, 'cars/car_lod1.glb'),
      loadContainer(scene, 'cars/car_lod2.glb'),
    ]);
    const heroTpl = hero ? buildCarTemplate(hero, scene, 'hero') : null;
    const t1 = lod1 ? buildCarTemplate(lod1, scene, 'lod1') : null;
    const t2 = lod2 ? buildCarTemplate(lod2, scene, 'lod2') : null;
    this.fleet = new CarFleet(scene, t1, t2);
    this.fleet.lod1Distance = 28;
    this.heroTpl = heroTpl;
    onProgress(0.15, 'Reflections');
    if (!OFF.has('env')) try {
      const env = new HDRCubeTexture(`${ASSET_BASE}/env/sky_1k.hdr`, scene, P.env, false, true, false, true);
      scene.environmentTexture = env;
      scene.environmentIntensity = 0.75;
    } catch {
      /* cars fall back to hemispheric light only */
    }
    onProgress(0.2, 'Building OMR');
    const pb = new ProceduralBuildings(this.map.net, 'slice', stationExclusions(this.map));
    this.pb = pb;
    this.world = await buildSlice(scene, this.map, this.cor, pb, (p) => onProgress(0.2 + p * 0.6, p < 0.65 ? 'Building OMR' : 'Baking light'));
    Object.assign(this.stats, { buildMs: this.world.stats.buildMs, bakeMs: this.world.stats.bakeMs, vertices: this.world.stats.vertices, triangles: this.world.stats.triangles, staticMeshes: this.world.stats.meshes });
    if (OFF.has('scenery')) for (const m of this.world.meshes) if (!ROAD_MATS.has(m.material?.name ?? '')) m.setEnabled(false);
    if (!OFF.has('scenery')) this.buildSignals();
    this.buildCarShadowTex();
    if (!OFF.has('traffic') && new URLSearchParams(location.search).get('bus') === '1') await this.loadBuses();
    onProgress(0.8, 'Planting trees');
    this.veg = OFF.has('veg') ? null : new Vegetation(scene);
    if (this.veg)
    await this.veg.load(['ficus', 'copal', 'cecropia', 'palm_straight', 'palm_bend', 'palm_dual', 'bush_01', 'bush_04', 'bush_05', 'hedge_long', 'grass'], this.world.veg, this.world.occluders);
    this.veg?.update(this.camera, true);
    onProgress(0.85, 'Compiling shaders');
    const tw = performance.now();
    // Shader warm-up: make every material ready (incl. instanced + vertex-colour variants) before driving.
    if (this.wantHero) this.setHero(this.wantHero);
    await scene.whenReadyAsync();
    for (let i = 0; i < 3; i++) scene.render();
    this.stats.warmupMs = Math.round(performance.now() - tw);
    onProgress(1, 'Ready');
  }
  pb: ProceduralBuildings | null = null;
  veg: Vegetation | null = null;
  private heroTpl: CarTemplate | null = null;
  private wantHero: Color3 | null = null;

  setHero(color: Color3) {
    this.wantHero = color;
    if (!this.heroTpl) return;
    this.hero?.dispose();
    this.hero = new HeroCar(this.scene, this.heroTpl, color);
    this.fx.attachCar(this.hero.rearWheels, this.hero.exhaust);
    this.sunShadow = this.makeSunShadow(this.heroTpl);
    this.sunShadow.parent = this.hero.root;
  }

  private shadowTex: DynamicTexture | null = null;
  private buildCarShadowTex() {
    const t = new DynamicTexture('sun-shadow', { width: 128, height: 128 }, this.scene, true);
    const c = t.getContext() as unknown as CanvasRenderingContext2D;
    const g = c.createRadialGradient(64, 64, 10, 64, 64, 64);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.32)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
    t.update();
    t.hasAlpha = true;
    this.shadowTex = t;
  }

  /** Car's sun shadow without a shadow map: a soft footprint offset along the sun direction (car-local). */
  private makeSunShadow(tpl: CarTemplate): Mesh {
    const p = MeshBuilder.CreateGround('car-sun-shadow', { width: tpl.width * 1.35, height: tpl.length * 1.25 }, this.scene);
    const m = new StandardMaterial('car-sun-shadow', this.scene);
    m.diffuseTexture = this.shadowTex;
    m.useAlphaFromDiffuseTexture = true;
    m.disableLighting = true;
    m.zOffset = -2;
    m.freeze();
    p.material = m;
    p.position.y = 0.04;
    p.isPickable = false;
    return p;
  }

  private buildSignals() {
    if (!this.world?.signals.length) return;
    const scene = this.scene;
    const lc: Record<SignalColor, Color3> = { R: new Color3(1, 0.12, 0.08), A: new Color3(1, 0.62, 0.05), G: new Color3(0.15, 1, 0.45) };
    const mk = (k: SignalColor, on: boolean) => {
      const m = new StandardMaterial(`sig-${k}-${on}`, scene);
      m.disableLighting = true;
      m.emissiveColor = on ? lc[k] : lc[k].scale(0.08);
      m.freeze();
      const s = MeshBuilder.CreateSphere(`sig-${k}-${on}`, { diameter: 0.26, segments: 6 }, scene);
      s.material = m;
      s.isPickable = false;
      return s;
    };
    this.lamps = { R: { on: mk('R', true), off: mk('R', false) }, A: { on: mk('A', true), off: mk('A', false) }, G: { on: mk('G', true), off: mk('G', false) } };
    // poles + heads (static, merged)
    const parts: Mesh[] = [];
    for (const h of this.world.signals) {
      const pole = MeshBuilder.CreateCylinder('p', { height: 5.4, diameterTop: 0.12, diameterBottom: 0.16, tessellation: 8 }, scene);
      pole.position.set(h.x, 2.7, h.z);
      const head = MeshBuilder.CreateBox('h', { width: 0.42, height: 1.25, depth: 0.32 }, scene);
      head.position.set(h.x, 5.0, h.z);
      head.rotation.y = h.heading;
      parts.push(pole, head);
    }
    const m = Mesh.MergeMeshes(parts, true, true)!;
    const mm = new StandardMaterial('sig-body', scene);
    mm.disableLighting = true;
    mm.emissiveColor = new Color3(0.08, 0.085, 0.09);
    mm.freeze();
    m.material = mm;
    m.freezeWorldMatrix();
  }

  updateSignals(simMs: number) {
    if (!this.world || !this.lamps) return;
    const heads = this.world.signals;
    const states = heads.map((h) => signalState(h.node, signalGroup(this.map.net, h.node, h.heading), simMs, 'slice'));
    const key = states.join('');
    if (key === this.signalKey) return;
    this.signalKey = key;
    (['R', 'A', 'G'] as SignalColor[]).forEach((col, i) => {
      const on: number[] = [];
      const off: number[] = [];
      heads.forEach((h, j) => {
        const m = Matrix.Translation(h.x - Math.sin(h.heading) * 0.17, 5.4 - i * 0.38, h.z - Math.cos(h.heading) * 0.17).asArray();
        (states[j] === col ? on : off).push(...m);
      });
      this.lamps![col].on.thinInstanceSetBuffer('matrix', new Float32Array(on.length ? on : Matrix.Translation(0, -999, 0).asArray()), 16, false);
      this.lamps![col].off.thinInstanceSetBuffer('matrix', new Float32Array(off.length ? off : Matrix.Translation(0, -999, 0).asArray()), 16, false);
    });
  }

  signalAt(node: number, heading: number, simMs: number): SignalColor {
    return signalState(node, signalGroup(this.map.net, node, heading), simMs, 'slice');
  }

  private last = performance.now();
  updateMe(p: CarPose) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (!this.hero) return;
    this.hero.set(p, dt);
    if (!OFF.has('fx')) this.fx.updateCar(p.slip ?? 0, Math.abs(p.speed ?? 0), !!p.nitro);
    if (this.sunShadow) {
      // offset along the sun's horizontal travel direction, in car space
      const len = 1.1;
      const wx = SUN.x * len;
      const wz = SUN.z * len;
      const c = Math.cos(p.heading);
      const s = Math.sin(p.heading);
      this.sunShadow.position.x = wx * c - wz * s;
      this.sunShadow.position.z = wx * s + wz * c;
    }
  }

  updateTraffic(cars: (CarPose & { id: number; color: Color3 })[]) {
    this.fleet?.update(cars, this.camera.position, 0, performance.now());
  }

  /** Licensed city buses (CC0 "3D Bus" by ajanhallinta): instanced LOD0 < 45 m, LOD1 beyond. */
  private busTpl: [Mesh[], Mesh[]] = [[], []];
  private buses = new Map<number, { root: TransformNode; lods: TransformNode[]; lod: number }>();
  private async loadBuses() {
    for (const lod of [0, 1] as const) {
      const c = await loadContainer(this.scene, `cars/bus_lod${lod}.glb`, { srgbBuffers: false });
      if (!c) continue;
      c.addAllToScene();
      for (const m of c.meshes) {
        if (!(m instanceof Mesh) || !m.getTotalVertices()) continue;
        m.setParent(null);
        m.computeWorldMatrix(true);
        m.bakeCurrentTransformIntoVertices();
        m.setEnabled(false);
        m.isPickable = false;
        this.busTpl[lod].push(m);
      }
      for (const m of c.meshes) if (!(m instanceof Mesh) || !m.getTotalVertices()) m.dispose();
    }
  }
  updateBuses(list: { id: number; x: number; z: number; heading: number }[]) {
    const seen = new Set<number>();
    const cp = this.camera.position;
    for (const b of list) {
      seen.add(b.id);
      let e = this.buses.get(b.id);
      if (!e) {
        const root = new TransformNode(`bus-${b.id}`, this.scene);
        const lods = this.busTpl.map((tpl, i) => {
          const n = new TransformNode(`bus-${b.id}-lod${i}`, this.scene);
          n.parent = root;
          for (const t of tpl) {
            const inst = t.createInstance(`${t.name}-${b.id}`);
            inst.parent = n;
          }
          return n;
        });
        if (this.shadowTex) {
          const sh = MeshBuilder.CreateGround(`bus-shadow-${b.id}`, { width: 3.2, height: 12.5 }, this.scene);
          sh.material = this.carShadowMat();
          sh.position.y = 0.04;
          sh.parent = root;
        }
        e = { root, lods, lod: -1 };
        this.buses.set(b.id, e);
      }
      e.root.position.set(b.x, 0, b.z);
      e.root.rotation.y = b.heading;
      const want = Math.hypot(b.x - cp.x, b.z - cp.z) < 45 ? 0 : 1;
      if (want !== e.lod) (e.lods.forEach((n, i) => n.setEnabled(i === want)), (e.lod = want));
    }
    for (const [id, e] of this.buses) if (!seen.has(id)) (e.root.dispose(), this.buses.delete(id));
  }
  private shadowMatShared: StandardMaterial | null = null;
  private carShadowMat() {
    if (this.shadowMatShared) return this.shadowMatShared;
    const m = new StandardMaterial('bus-shadow', this.scene);
    m.diffuseTexture = this.shadowTex;
    m.useAlphaFromDiffuseTexture = true;
    m.disableLighting = true;
    m.zOffset = -2;
    m.freeze();
    return (this.shadowMatShared = m);
  }

  setRain(r: boolean) {
    if (r === this.rain) return;
    this.rain = r;
    const f = r ? FOG_RAIN : FOG_DRY;
    this.scene.fogColor = f.clone();
    this.scene.clearColor = new Color4(f.r, f.g, f.b, 1);
    this.scene.fogDensity = Q[this.quality].fog * (r ? 1.9 : 1);
    this.scene.environmentIntensity = r ? 0.45 : 0.75;
    this.skyMat.emissiveColor = r ? new Color3(0.55, 0.58, 0.62) : new Color3(1, 1, 1);
    this.world?.setWet(r, !OFF.has('wetrefl'));
    this.veg?.setWet(r);
    this.fx.wet = r;
  }

  updateCamera(p: CarPose, speed: number, dt: number) {
    // rain volume centred ~14 m ahead of the car (what the chase camera sees), not around it
    this.fx.setRain(this.rain && !OFF.has('fx'), new Vector3(p.x + Math.sin(p.heading) * 14, 0, p.z + Math.cos(p.heading) * 14));
    let dy = p.heading - this.camYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.camYaw += dy * (1 - Math.exp(-dt * 5));
    const fx = Math.sin(this.camYaw);
    const fz = Math.cos(this.camYaw);
    const tall = this.engine.getAspectRatio(this.camera) < 1;
    const back = (tall ? 5.4 : 6.2) + Math.min(2.6, speed * 0.05);
    const target = new Vector3(p.x - fx * back, (tall ? 2.9 : 2.05) + Math.min(0.7, speed * 0.012), p.z - fz * back);
    const look = tall ? new Vector3(p.x + fx * 9, -1.2, p.z + fz * 9) : new Vector3(p.x + fx * 7, 0.95, p.z + fz * 7);
    if (this.camPos.lengthSquared() === 0) this.camPos.copyFrom(target);
    this.camPos = Vector3.Lerp(this.camPos, target, 1 - Math.exp(-dt * 9));
    this.camera.position.copyFrom(this.camPos);
    this.camera.setTarget(look);
    this.veg?.update(this.camera);
    this.camera.fovMode = tall ? UniversalCamera.FOVMODE_HORIZONTAL_FIXED : UniversalCamera.FOVMODE_VERTICAL_FIXED;
    const fovT = (tall ? 1.12 : 0.9) + Math.min(0.22, speed * 0.004) + (p.nitro ? 0.1 : 0);
    this.camera.fov += (fovT - this.camera.fov) * (1 - Math.exp(-dt * 4));
  }

  lockResolution(scale: number) {
    this.resLocked = true;
    this.scale = scale;
    this.engine.setHardwareScalingLevel(scale);
  }

  /** Dynamic resolution: hold ≥ 30 FPS (target 36 headroom) by trading render scale inside the preset's range. */
  adaptResolution() {
    if (this.resLocked) return;
    this.fpsWin.push(this.engine.getFps());
    if (this.fpsWin.length < 6) return;
    const avg = this.fpsWin.reduce((a, b) => a + b, 0) / this.fpsWin.length;
    this.fpsWin = [];
    const P = Q[this.quality];
    if (avg < 33 && this.scale < P.maxScale) this.scale = Math.min(P.maxScale, this.scale + 0.15);
    else if (avg > 52 && this.scale > P.minScale) this.scale = Math.max(P.minScale, this.scale - 0.1);
    else return;
    this.engine.setHardwareScalingLevel(this.scale);
  }

  get renderScale() {
    return this.scale;
  }

  shadowCasters(): AbstractMesh[] {
    return [];
  }

  dispose() {
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
