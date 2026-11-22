/**
 * The racer's 3D view of the ONE shared world. Visual only — every position comes from the server snapshot or
 * the shared client prediction; nothing here can change gameplay.
 *
 * Rendering (see docs/VISUALS.md): licensed GLB car with PBR paint, HDR image-based lighting from a real sky
 * capture, sun with a shadow map that follows your car, contact shadows, ACES tone mapping, haze, PBR asphalt
 * (wet in rain), painted kerbs, paver footpaths, medians, lane markings, zebra crossings, textured buildings,
 * LED street lights, palms, rain/tyre-smoke/nitro particles. Quality presets trade effects for frame rate.
 */
import { RouteSigns } from './render/signs';
import { roadsideVegForCell } from './render/roadsideVeg';
import { Vegetation } from './slice/vegetation';
import type { VegItem } from './slice/build';
import {
  Color3,
  Color4,
  DefaultRenderingPipeline,
  DirectionalLight,
  DynamicTexture,
  Engine,
  HemisphericLight,
  ImageProcessingConfiguration,
  Matrix,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Quaternion,
  Scene,
  SceneInstrumentation,
  ShadowGenerator,
  StandardMaterial,
  UniversalCamera,
  Vector3,
  type AbstractMesh,
} from '@babylonjs/core';
import {
  ProceduralBuildings,
  generateBuildings,
  hash32,
  signalGroup,
  signalState,
  stationExclusions,
  gateLayout,
  nearestEdge,
  type Closure,
  type RoadNetwork,
  type SignalColor,
  type WorldMap,
} from '@redline/shared';
import { loadContainer } from './render/assets';
import { Fx } from './render/fx';
import { createSky, createWorldMaterials, type WorldMaterials } from './render/materials';
import { TrafficRenderer } from './render/traffic';
import { CarFleet, HeroCar, buildCarTemplate, type CarPose, type CarTemplate } from './render/vehicles';
import { CELL, WorldBuilder, Y, type CellContent } from './render/world';

export type { CarPose } from './render/vehicles';
export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export type CameraMode = 'chase' | 'hood' | 'top';
/** Measurement-only switches (perf audit ablations). Never used in the live event. */
export interface Ablation {
  noShadows?: boolean;
  noPost?: boolean;
  noBuildings?: boolean;
  noDetail?: boolean;
  noVeg?: boolean;
  noIBL?: boolean;
  noTraffic?: boolean;
  noFx?: boolean;
  noHero?: boolean;
}

/** Presets change visuals only — never gameplay (SPEC Part 1). */
const PRESETS: Record<Quality, { minScale: number; fog: number; draw: number; shadow: number; post: boolean; bloom: boolean; detailR: number; particles: number; envSize: boolean }> = {
  low: { minScale: 2, fog: 0.0032, draw: 400, shadow: 0, post: false, bloom: false, detailR: 0, particles: 0.35, envSize: true },
  medium: { minScale: 1.5, fog: 0.0022, draw: 800, shadow: 1024, post: true, bloom: false, detailR: 1, particles: 0.6, envSize: true },
  high: { minScale: 1, fog: 0.0016, draw: 1200, shadow: 2048, post: true, bloom: true, detailR: 1, particles: 1, envSize: false },
  ultra: { minScale: 0.75, fog: 0.0013, draw: 1600, shadow: 2048, post: true, bloom: true, detailR: 2, particles: 1.3, envSize: false },
};

const cellOf = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
const cellDist = (k: string, cx: number, cz: number) => {
  const [x, z] = k.split(',').map(Number) as [number, number];
  return (x - cx) ** 2 + (z - cz) ** 2;
};

export function teamColor(id: string): Color3 {
  const h = (hash32(id) % 360) / 360;
  // PBR albedo is linear; HSV/hex are display (sRGB) values.
  return Color3.FromHSV(h * 360, 0.78, 0.8).toLinearSpace();
}

const SUN_DIR = new Vector3(-0.42, -0.78, 0.46).normalize();
const SKY_CLEAR = { fog: new Color3(0.74, 0.79, 0.84), sun: 7, env: 0.42 };
const SKY_RAIN = { fog: new Color3(0.47, 0.51, 0.56), sun: 1.2, env: 0.5 };

export class GameScene {
  readonly engine: Engine;
  readonly scene: Scene;
  private readonly camera: UniversalCamera;
  private readonly sun: DirectionalLight;
  private readonly mats: WorldMaterials;
  private readonly builder: WorldBuilder;
  private readonly fx: Fx;
  private shadows: ShadowGenerator | null = null;
  private pipeline: DefaultRenderingPipeline | null = null;
  private hero: HeroCar | null = null;
  private heroTpl: CarTemplate | null = null;
  private fleet: CarFleet;
  private traffic: TrafficRenderer;
  private barrierTpl: Mesh | null = null;
  private wantTeam: string | null = null;
  private camMode: CameraMode = 'chase';
  private camPos = new Vector3(0, 30, -30);
  private camYaw = 0;
  private quality: Quality;
  private scale: number;
  private fpsWindow: number[] = [];
  private rain = false;
  private readonly net: RoadNetwork;
  private cells = new Map<string, CellContent>();
  private lastCellCheck = '';
  private pending: string[] = [];
  private ground: Mesh;
  private gatePos = Vector3.Zero();
  private readonly routeSigns: RouteSigns | null;
  /** licensed roadside vegetation (medium+ on the real map): one plant set per streamed cell */
  private veg: Vegetation | null = null;
  private vegLoading = false;
  private readonly cellVeg = new Map<string, VegItem[]>();
  private vegDirty = false;
  private readonly procedural: ProceduralBuildings | null;
  private readonly exclusions: { x: number; z: number; r: number }[];
  private readonly realMap: boolean;
  /** Resolves once the licensed assets are loaded (or failed and fell back). */
  readonly ready: Promise<void>;

  constructor(
    canvas: HTMLCanvasElement,
    map: WorldMap,
    private readonly seed: string,
    quality: Quality = 'medium',
    readonly ablate: Ablation = {},
  ) {
    const net = map.net;
    this.net = net;
    this.quality = quality;
    this.engine = new Engine(canvas, false, { stencil: true, preserveDrawingBuffer: false, powerPreference: 'high-performance', antialias: false }, false);
    this.scale = Math.max(PRESETS[quality].minScale, 1 / Math.min(window.devicePixelRatio || 1, 1.5));
    this.engine.setHardwareScalingLevel(this.scale);
    const scene = (this.scene = new Scene(this.engine));
    scene.skipPointerMovePicking = true;
    scene.clearColor = new Color4(SKY_CLEAR.fog.r, SKY_CLEAR.fog.g, SKY_CLEAR.fog.b, 1);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogColor = SKY_CLEAR.fog.clone();
    scene.fogDensity = PRESETS[quality].fog;
    // Filmic tone mapping in-shader (no extra pass needed on low).
    const ip = scene.imageProcessingConfiguration;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = 0.95;
    ip.contrast = 1.3;

    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.18;
    hemi.groundColor = new Color3(0.35, 0.3, 0.25);
    this.sun = new DirectionalLight('sun', SUN_DIR.clone(), scene);
    this.sun.intensity = SKY_CLEAR.sun;
    scene.environmentIntensity = SKY_CLEAR.env;
    this.sun.diffuse = new Color3(1, 0.95, 0.86);
    this.sun.autoUpdateExtends = false;
    this.sun.orthoLeft = -45;
    this.sun.orthoRight = 45;
    this.sun.orthoTop = 45;
    this.sun.orthoBottom = -45;
    this.sun.shadowMinZ = 1;
    this.sun.shadowMaxZ = 260;

    this.camera = new UniversalCamera('cam', new Vector3(0, 20, -20), scene);
    this.camera.minZ = 0.5;
    this.camera.maxZ = 4000;
    this.camera.fov = 0.95;
    this.camera.inputs.clear();

    createSky(scene, PRESETS[quality].envSize);
    if (ablate.noIBL) scene.environmentTexture = null;
    this.mats = createWorldMaterials(scene);
    const g = MeshBuilder.CreateGround('ground', { width: 3000, height: 3000, subdivisions: 1 }, scene);
    g.position.y = Y.ground;
    const gm = this.mats.grass;
    (gm.albedoTexture as import('@babylonjs/core').Texture).uScale = 3000 / 9;
    (gm.albedoTexture as import('@babylonjs/core').Texture).vScale = 3000 / 9;
    g.material = gm;
    g.receiveShadows = true;
    g.isPickable = false;
    this.ground = g;

    const procedural = map.id === 'test' ? null : new ProceduralBuildings(net, seed, stationExclusions(map));
    this.procedural = procedural;
    this.exclusions = stationExclusions(map);
    this.realMap = map.id !== 'test';
    const fixed = map.id === 'test' ? generateBuildings(net, seed, stationExclusions(map)) : [];
    this.builder = new WorldBuilder(scene, net, this.mats, ablate.noBuildings ? null : procedural, ablate.noBuildings ? [] : fixed, seed, { barrier: null });
    this.fx = new Fx(scene, PRESETS[quality].particles);
    this.fleet = new CarFleet(scene, null, null);
    this.traffic = new TrafficRenderer(scene, null);
    this.buildStations(map);
    this.buildGate(map);
    this.routeSigns = map.signs?.length && !ablate.noDetail ? new RouteSigns(scene, map.signs) : null;
    this.applyQuality();
    this.inst = new SceneInstrumentation(scene);
    this.ready = this.loadAssets();
  }

  /* ---------------- assets ---------------- */

  private async loadAssets() {
    const scene = this.scene;
    // Low preset: your own car uses the 20k-triangle LOD instead of the ~105k hero (and skips its 3 MB download).
    const lowEnd = this.quality === 'low';
    const [hero, lod1, lod2, lod3, barrier] = await Promise.all([
      lowEnd ? Promise.resolve(null) : loadContainer(scene, 'cars/car_hero.glb'),
      loadContainer(scene, 'cars/car_lod1.glb'),
      loadContainer(scene, 'cars/car_lod2.glb'),
      loadContainer(scene, 'cars/car_lod3.glb'),
      loadContainer(scene, 'props/barrier.glb'),
    ]);
    if (scene.isDisposed) return;
    const t1 = lod1 ? buildCarTemplate(lod1, scene, 'lod1') : null;
    const t2 = lod2 ? buildCarTemplate(lod2, scene, 'lod2') : null;
    const t3 = lod3 ? buildCarTemplate(lod3, scene, 'lod3') : null;
    // The hero must not share instance sources with the fleet; a separate LOD1 copy is loaded for low.
    this.heroTpl = hero ? buildCarTemplate(hero, scene, 'hero') : lowEnd ? await loadContainer(scene, 'cars/car_lod1.glb').then((c) => (c ? buildCarTemplate(c, scene, 'hero-low') : null)) : t1;
    this.fleet.dispose();
    this.fleet = new CarFleet(scene, t1, t2);
    this.traffic = new TrafficRenderer(scene, t3 ?? t2);
    if (barrier) {
      barrier.addAllToScene();
      const ms = barrier.meshes.filter((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
      for (const m of ms) (m.setParent(null), m.bakeCurrentTransformIntoVertices());
      barrier.meshes[0]?.dispose(false, false);
      const merged = ms.length > 1 ? Mesh.MergeMeshes(ms, true, true) : ms[0]!;
      if (merged) {
        merged.refreshBoundingInfo();
        const b = merged.getBoundingInfo().boundingBox;
        merged.position.set(-(b.minimum.x + b.maximum.x) / 2, -b.minimum.y, -(b.minimum.z + b.maximum.z) / 2);
        merged.bakeCurrentTransformIntoVertices();
        merged.setEnabled(false);
        this.barrierTpl = merged;
      }
    }
    this.closureKey = '';
    if (this.wantTeam) this.setMyCar(this.wantTeam);
    void this.ensureVegetation();
  }

  private vegWanted() {
    return this.realMap && this.quality !== 'low' && !this.ablate.noVeg;
  }

  /** Load the vegetation templates once (only when the preset wants them). */
  private async ensureVegetation() {
    if (!this.vegWanted() || this.veg || this.vegLoading) return;
    this.vegLoading = true;
    const v = new Vegetation(this.scene);
    await v.loadTemplates(['ficus', 'copal', 'cecropia', 'palm_straight', 'palm_bend', 'palm_dual', 'bush_01', 'bush_04', 'bush_05']);
    if (this.scene.isDisposed) return;
    this.veg = v;
    this.vegLoading = false;
    for (const k of this.cells.keys()) if (!this.cellVeg.has(k)) this.cellVeg.set(k, this.vegFor(k));
    this.vegDirty = true;
  }

  private vegFor(key: string): VegItem[] {
    const pb = this.procedural;
    return roadsideVegForCell(this.net, key, CELL, this.seed, (x, z, r) => (pb ? pb.near(x, z, r) : []), this.exclusions);
  }

  /* ---------------- quality ---------------- */

  private applyQuality() {
    const P = { ...PRESETS[this.quality] };
    if (this.ablate.noShadows) P.shadow = 0;
    if (this.ablate.noPost) (P.post = false), (P.bloom = false);
    this.scene.fogDensity = P.fog * (this.rain ? 1.9 : 1);
    if (P.shadow && (!this.shadows || this.shadows.getShadowMap()!.getSize().width !== P.shadow)) {
      this.shadows?.dispose();
      const sg = new ShadowGenerator(P.shadow, this.sun);
      sg.usePercentageCloserFiltering = true;
      sg.filteringQuality = this.quality === 'medium' ? ShadowGenerator.QUALITY_LOW : ShadowGenerator.QUALITY_MEDIUM;
      sg.bias = 0.0004;
      sg.normalBias = 0.02;
      sg.darkness = 0.15;
      sg.getShadowMap()!.refreshRate = 1;
      this.shadows = sg;
    } else if (!P.shadow && this.shadows) {
      this.shadows.dispose();
      this.shadows = null;
    }
    if (P.post && !this.pipeline) {
      const pp = new DefaultRenderingPipeline('pp', false, this.scene, [this.camera]);
      pp.fxaaEnabled = true;
      pp.imageProcessingEnabled = true;
      pp.imageProcessing.toneMappingEnabled = true;
      pp.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
      pp.imageProcessing.exposure = 0.95;
      pp.imageProcessing.contrast = 1.3;
      pp.imageProcessing.vignetteEnabled = true;
      pp.imageProcessing.vignetteWeight = 1.2;
      pp.imageProcessing.vignetteColor = new Color4(0, 0, 0, 0);
      this.pipeline = pp;
    } else if (!P.post && this.pipeline) {
      this.pipeline.dispose();
      this.pipeline = null;
    }
    if (this.pipeline) {
      this.pipeline.bloomEnabled = P.bloom;
      this.pipeline.bloomThreshold = 0.92;
      this.pipeline.bloomWeight = 0.25;
      this.pipeline.bloomKernel = 48;
      this.pipeline.bloomScale = 0.5;
    }
    this.fx.rain.emitRate = Math.round(2600 * P.particles);
    this.shadowListAt = 0;
  }

  /* ---------------- streaming ---------------- */

  private streamCells(x: number, z: number) {
    this.ground.position.x = Math.round(x / 300) * 300;
    this.ground.position.z = Math.round(z / 300) * 300;
    this.routeSigns?.update(x, z);
    const here = cellOf(x, z);
    const R = Math.ceil(PRESETS[this.quality].draw / CELL);
    const [cx, cz] = here.split(',').map(Number) as [number, number];
    if (here !== this.lastCellCheck) {
      this.lastCellCheck = here;
      const want = new Set<string>();
      for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) if (i * i + j * j <= R * R + 1) want.add(`${cx + i},${cz + j}`);
      for (const [k, c] of this.cells)
        if (!want.has(k)) {
          c.meshes.forEach((m) => m.dispose());
          c.detail.forEach((m) => m.dispose());
          this.cells.delete(k);
          if (this.cellVeg.delete(k)) this.vegDirty = true;
        }
      this.pending = [...want].filter((k) => !this.cells.has(k)).sort((a, b) => cellDist(a, cx, cz) - cellDist(b, cx, cz));
      this.shadowListAt = 0;
    }
    for (let n = 0; n < 2 && this.pending.length; n++) {
      const k = this.pending.shift()!;
      if (!this.cells.has(k)) {
        this.cells.set(k, this.builder.buildCell(k));
        if (this.veg && this.vegWanted()) (this.cellVeg.set(k, this.vegFor(k)), (this.vegDirty = true));
      }
      this.shadowListAt = 0;
    }
    if (this.vegDirty && this.veg) {
      this.vegDirty = false;
      if (this.vegWanted()) for (const k of this.cells.keys()) if (!this.cellVeg.has(k)) this.cellVeg.set(k, this.vegFor(k));
      this.veg.setItems(this.vegWanted() ? [...this.cellVeg.values()].flat() : []);
    }
    // Street detail (lamps, palms, signs, tanks) only near the camera.
    const dr = PRESETS[this.quality].detailR;
    for (const [k, c] of this.cells) {
      const near = cellDist(k, cx, cz) <= dr * dr + (dr ? 1 : 0);
      for (const m of c.detail) if (m.isEnabled() !== (near && !this.ablate.noDetail)) m.setEnabled(near && !this.ablate.noDetail);
    }
  }

  get loadedCells() {
    return this.cells.size;
  }

  private shadowListAt = 0;
  /** Shadow casters: cars + buildings/street furniture of the cells around you (rebuilt on change). */
  private refreshShadowCasters(now: number) {
    if (!this.shadows || now < this.shadowListAt) return;
    this.shadowListAt = now + 600;
    const list = this.shadows.getShadowMap()!.renderList!;
    list.length = 0;
    const [cx, cz] = this.lastCellCheck.split(',').map(Number) as [number, number];
    if (this.hero) for (const m of this.hero.root.getChildMeshes()) if (m.name !== 'contact') list.push(m);
    for (const [k, c] of this.cells) {
      if (cellDist(k, cx, cz) > 2) continue;
      for (const m of c.meshes) if (/^(b-|lamp|sig-|palm|tank)/.test(m.name)) list.push(m);
      for (const m of c.detail) if (m.isEnabled()) list.push(m);
    }
    for (const m of this.fleet.shadowCasters()) list.push(m);
    for (const m of this.traffic.templateMeshes) list.push(...(m.instances as AbstractMesh[]));
  }

  /* ---------------- stations & gate (original geometry, PBR) ---------------- */

  private buildStations(map: WorldMap) {
    const scene = this.scene;
    const canopy = new PBRMaterial('st-canopy', scene);
    canopy.albedoColor = new Color3(0.95, 0.95, 0.93);
    canopy.roughness = 0.4;
    const fascia = new PBRMaterial('st-fascia', scene);
    fascia.albedoColor = new Color3(0.08, 0.45, 0.25);
    fascia.emissiveColor = new Color3(0.02, 0.12, 0.06);
    fascia.roughness = 0.35;
    const pumpMat = new PBRMaterial('st-pump', scene);
    pumpMat.albedoColor = new Color3(0.85, 0.86, 0.88);
    pumpMat.roughness = 0.3;
    pumpMat.metallic = 0.3;
    const sign = new DynamicTexture('st-sign', { width: 256, height: 512 }, scene, true);
    const c = sign.getContext() as unknown as CanvasRenderingContext2D;
    c.fillStyle = '#0d5a33';
    c.fillRect(0, 0, 256, 512);
    c.fillStyle = '#fff';
    c.font = 'bold 64px system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText('FUEL', 128, 100);
    c.font = '600 34px system-ui, sans-serif';
    c.fillText('PETROL', 128, 220);
    c.fillText('DIESEL', 128, 300);
    c.fillText('SERVICE', 128, 380);
    sign.update();
    const signMat = new StandardMaterial('st-sign', scene);
    signMat.diffuseTexture = sign;
    signMat.emissiveColor = new Color3(0.5, 0.5, 0.5);
    for (const st of map.stations) {
      // Fit forecourt + canopy to the space beside the road (never overhang a carriageway).
      const half = Math.max(3, Math.min(8, nearestEdge(map.net, st.x, st.z).clearance - 0.4));
      const canW = Math.min(12, half * 2);
      const padW = Math.min(16, half * 2);
      const pillarX = Math.max(1.5, canW / 2 - 1.5);
      const ch = Math.cos(st.heading);
      const sh = Math.sin(st.heading);
      const at = (dx: number, dz: number, y: number) => new Vector3(st.x + dx * ch + dz * sh, y, st.z - dx * sh + dz * ch);
      const pad = MeshBuilder.CreateBox(`st-pad-${st.id}`, { width: padW, depth: 34, height: 0.14 }, scene);
      pad.position.set(st.x, 0.02, st.z);
      pad.rotation.y = st.heading;
      pad.material = this.mats.concrete;
      pad.receiveShadows = true;
      const top = MeshBuilder.CreateBox(`st-can-${st.id}`, { width: canW, depth: 26, height: 0.5 }, scene);
      top.position.set(st.x, 5.6, st.z);
      top.rotation.y = st.heading;
      top.material = canopy;
      const band = MeshBuilder.CreateBox(`st-band-${st.id}`, { width: canW + 0.2, depth: 26.2, height: 0.7 }, scene);
      band.position.set(st.x, 5.15, st.z);
      band.rotation.y = st.heading;
      band.material = fascia;
      for (const [dx, dz] of [[-pillarX, -9], [pillarX, -9], [-pillarX, 9], [pillarX, 9]] as const) {
        const pl = MeshBuilder.CreateCylinder(`st-pl-${st.id}`, { height: 5, diameter: 0.35, tessellation: 10 }, scene);
        pl.position.copyFrom(at(dx, dz, 2.5));
        pl.material = pumpMat;
      }
      for (const dz of [-6, 6]) {
        const island = MeshBuilder.CreateBox(`st-isl-${st.id}`, { width: 1.2, depth: 4.5, height: 0.25 }, scene);
        island.position.copyFrom(at(0, dz, 0.15));
        island.rotation.y = st.heading;
        island.material = this.mats.kerb;
        const pump = MeshBuilder.CreateBox(`st-pump-${st.id}`, { width: 0.8, depth: 1.2, height: 1.9 }, scene);
        pump.position.copyFrom(at(0, dz, 1.2));
        pump.rotation.y = st.heading;
        pump.material = pumpMat;
      }
      const pylon = MeshBuilder.CreatePlane(`st-pylon-${st.id}`, { width: 1.8, height: 3.6, sideOrientation: Mesh.DOUBLESIDE }, scene);
      pylon.position.copyFrom(at(-(padW / 2 - 0.6), -15, 3.2));
      pylon.rotation.y = st.heading + Math.PI / 2;
      pylon.material = signMat;
      for (const b of st.bays) {
        const m = MeshBuilder.CreateBox(`st-bay-${st.id}`, { width: 2.6, depth: 5.2, height: 0.02 }, scene);
        m.position.set(b.x, 0.1, b.z);
        m.rotation.y = b.heading;
        m.material = this.mats.paintWhite;
        m.visibility = 0.6;
      }
    }
  }

  /** Hexaware gate: an original arch over the final approach (plain text, no logo) + the parking lot with 30 bays. */
  private buildGate(map: WorldMap) {
    const scene = this.scene;
    const lay = gateLayout(map);
    const lot = MeshBuilder.CreateGround('gate-lot', { width: lay.lot.r * 2, height: lay.lot.r * 2 }, scene);
    lot.position.set(lay.lot.x, 0.03, lay.lot.z);
    lot.rotation.y = lay.heading;
    lot.material = this.mats.asphalt;
    lot.receiveShadows = true;
    lay.spots.forEach((sp, i) => {
      const m = MeshBuilder.CreateBox(`bay-${i}`, { width: 2.6, depth: 5.2, height: 0.02 }, scene);
      m.position.set(sp.x, 0.06, sp.z);
      m.rotation.y = sp.heading;
      m.material = this.mats.paintWhite;
      m.visibility = 0.5;
    });
    const fx = Math.sin(lay.heading);
    const fz = Math.cos(lay.heading);
    const steel = new PBRMaterial('gate-steel', scene);
    steel.albedoColor = new Color3(0.82, 0.84, 0.87);
    steel.metallic = 0.85;
    steel.roughness = 0.25;
    for (const side of [-1, 1]) {
      const p = MeshBuilder.CreateBox('gate-pillar', { width: 1.2, depth: 1.2, height: 9 }, scene);
      p.position.set(lay.gate.x - fz * 11 * side, 4.5, lay.gate.z + fx * 11 * side);
      p.material = steel;
    }
    const beam = MeshBuilder.CreatePlane('gate-beam', { width: 23, height: 2.2, sideOrientation: Mesh.DOUBLESIDE }, scene);
    beam.position.set(lay.gate.x, 9.4, lay.gate.z);
    beam.rotation.y = lay.heading + Math.PI;
    const tex = new DynamicTexture('gate-text', { width: 1024, height: 96 }, scene, false);
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, 1024, 96);
    ctx.font = 'bold 60px system-ui, sans-serif';
    ctx.fillStyle = '#ffd34d';
    ctx.textAlign = 'center';
    ctx.fillText('WELCOME TO HEXAWARE', 512, 70);
    tex.update();
    const bm = new StandardMaterial('gate-beam-mat', scene);
    bm.diffuseTexture = tex;
    bm.emissiveColor = new Color3(1, 1, 1);
    bm.backFaceCulling = false;
    beam.material = bm;
    this.gatePos = new Vector3(lay.gate.x, 0, lay.gate.z);
  }

  /** Finale: orbiting aerial camera around a point (convoy lead), with fireworks and confetti over the gate. */
  cinematic(cx: number, cz: number, t: number) {
    this.streamCells(cx, cz);
    const r = 70 + 25 * Math.sin(t * 0.07);
    const target = new Vector3(cx, 2, cz);
    this.camPos = new Vector3(cx + Math.cos(t * 0.12) * r, 28 + 10 * Math.sin(t * 0.05), cz + Math.sin(t * 0.12) * r);
    this.camera.position.copyFrom(this.camPos);
    this.camera.setTarget(target);
    this.veg?.update(this.camera);
    this.camera.fov = 0.9;
    this.camera.minZ = 1;
    this.moveSun(cx, cz);
    this.refreshShadowCasters(performance.now());
  }

  startCelebration() {
    this.fx.startCelebration(this.gatePos);
  }

  tickCelebration(t: number) {
    this.fx.tickCelebration(t);
  }

  private barrierMeshes: Mesh[] = [];
  private closureKey = '';
  /** Route Lockdown barriers (the same obstacles the server collides with). */
  setClosures(closures: Closure[]) {
    const key = closures.map((c) => c.id).join(',');
    if (key === this.closureKey) return;
    this.closureKey = key;
    for (const m of this.barrierMeshes) m.dispose();
    this.barrierMeshes = [];
    const mats: number[] = [];
    for (const c of closures)
      for (const b of c.barriers) {
        // Licensed concrete barrier blocks laid across the closure footprint (width × 1.2 m × 1.1 m).
        const n = Math.max(1, Math.round(b.width / 1.55));
        const seg = b.width / n;
        for (let i = 0; i < n; i++) {
          const o = -b.width / 2 + seg * (i + 0.5);
          const x = b.x + Math.cos(b.heading) * o;
          const z = b.z - Math.sin(b.heading) * o;
          Matrix.Compose(new Vector3(seg / 1.55, 1.1 / 0.84, 1.2 / 0.64), Quaternion.RotationYawPitchRoll(b.heading, 0, 0), new Vector3(x, 0, z))
            .asArray()
            .forEach((v) => mats.push(v));
        }
      }
    if (!mats.length) return;
    if (this.barrierTpl) {
      const m = this.barrierTpl.clone('closure-barriers', null, true, false)!;
      m.setEnabled(true);
      m.thinInstanceSetBuffer('matrix', new Float32Array(mats), 16, true);
      m.thinInstanceRefreshBoundingInfo(false);
      this.barrierMeshes.push(m);
    } else {
      const m = MeshBuilder.CreateBox('closure-barriers', { width: 1.55, depth: 0.64, height: 0.84 }, this.scene);
      m.bakeTransformIntoVertices(Matrix.Translation(0, 0.42, 0));
      m.material = this.mats.kerb;
      m.thinInstanceSetBuffer('matrix', new Float32Array(mats), 16, true);
      this.barrierMeshes.push(m);
    }
  }

  /* ---------------- dynamic ---------------- */

  private paintOverride: Color3 | null = null;
  /** Fixed paint (showroom / test drive). */
  setPaint(hex: string) {
    this.paintOverride = Color3.FromHexString(hex).toLinearSpace();
  }

  private resLocked = false;
  /** Disable adaptive resolution (screenshots / measurements at a known resolution). */
  lockResolution(scale: number) {
    this.resLocked = true;
    this.scale = scale;
    this.engine.setHardwareScalingLevel(scale);
  }

  setMyCar(teamId: string) {
    this.wantTeam = teamId;
    if (!this.heroTpl || this.ablate.noHero) return; // assets still loading — created when ready
    this.hero?.dispose();
    this.hero = new HeroCar(this.scene, this.heroTpl, this.paintOverride ?? teamColor(teamId));
    this.fx.attachCar(this.hero.rearWheels, this.hero.exhaust);
    this.shadowListAt = 0;
  }

  private lastFrame = performance.now();
  updateMe(p: CarPose) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!this.hero) return;
    this.hero.set(p, dt);
    if (!this.ablate.noFx) this.fx.updateCar(p.slip ?? 0, Math.abs(p.speed ?? 0), !!p.nitro);
  }

  get othersCount() {
    return this.fleet.size;
  }

  updateOthers(cars: (CarPose & { id: string | number; colorKey: string })[]) {
    this.fleet.update(
      cars.map((c) => ({ ...c, color: teamColor(c.colorKey) })),
      this.camera.position,
      0,
      performance.now(),
    );
  }

  updateTraffic(items: { id: number; type: number; x: number; z: number; heading: number }[]) {
    if (this.ablate.noTraffic) items = [];
    // Draw-distance cull (visual only): far traffic is fogged out anyway.
    const c = this.camera.position;
    const r2 = (PRESETS[this.quality].draw * 0.45) ** 2;
    this.traffic.update(items.filter((t) => (t.x - c.x) ** 2 + (t.z - c.z) ** 2 < r2));
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
          const m = Matrix.Translation(h.x - fx * 0.17, 5.4 - i * 0.38, h.z - fz * 0.17).asArray();
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
    const s = rain ? SKY_RAIN : SKY_CLEAR;
    this.scene.fogColor = s.fog.clone();
    this.scene.clearColor = new Color4(s.fog.r, s.fog.g, s.fog.b, 1);
    this.sun.intensity = s.sun;
    this.scene.environmentIntensity = s.env;
    this.scene.fogDensity = PRESETS[this.quality].fog * (rain ? 1.9 : 1);
    this.mats.setWet(rain);
    this.veg?.setWet(rain);
    if (this.shadows) this.shadows.darkness = rain ? 0.6 : 0.15;
  }

  setCameraMode(m: CameraMode) {
    this.camMode = m;
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.scale = Math.max(PRESETS[q].minScale, this.scale);
    this.engine.setHardwareScalingLevel(this.scale);
    this.lastCellCheck = '';
    this.applyQuality();
    // vegetation follows the preset: low drops every plant, medium+ loads templates on demand
    this.vegDirty = true;
    if (this.vegWanted()) void this.ensureVegetation();
  }

  private moveSun(x: number, z: number) {
    this.sun.position.set(x - SUN_DIR.x * 120, -SUN_DIR.y * 120, z - SUN_DIR.z * 120);
  }

  updateCamera(p: CarPose, speed: number, dt: number) {
    this.camera.minZ = this.camMode === 'hood' ? 0.3 : 0.5;
    this.streamCells(p.x, p.z);
    this.moveSun(p.x, p.z);
    this.refreshShadowCasters(performance.now());
    this.fx.setRain(this.rain && !this.ablate.noFx, new Vector3(p.x, 0, p.z));
    // Smoothed yaw so the camera swings, not snaps, through corners.
    let dy = p.heading - this.camYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.camYaw += dy * (1 - Math.exp(-dt * 5));
    const fx = Math.sin(this.camYaw);
    const fz = Math.cos(this.camYaw);
    let look: Vector3;
    if (this.camMode === 'hood') {
      const hx = Math.sin(p.heading);
      const hz = Math.cos(p.heading);
      this.camPos.set(p.x + hx * 0.3, 1.08, p.z + hz * 0.3);
      look = new Vector3(p.x + hx * 30, 0.9, p.z + hz * 30);
    } else if (this.camMode === 'top') {
      const target = new Vector3(p.x - fx * 2, 70, p.z - fz * 2);
      look = new Vector3(p.x + fx * 8, 0, p.z + fz * 8);
      this.camPos = Vector3.Lerp(this.camPos, target, 1 - Math.exp(-dt * 6));
    } else {
      const tall = this.engine.getAspectRatio(this.camera) < 1;
      const back = (tall ? 5.4 : 6.2) + Math.min(2.6, speed * 0.05);
      const target = new Vector3(p.x - fx * back, (tall ? 2.9 : 2.05) + Math.min(0.7, speed * 0.012), p.z - fz * back);
      // Portrait: aim lower so the road (not the sky) fills the tall screen.
      look = tall ? new Vector3(p.x + fx * 9, -1.2, p.z + fz * 9) : new Vector3(p.x + fx * 7, 0.95, p.z + fz * 7);
      this.camPos = Vector3.Lerp(this.camPos, target, 1 - Math.exp(-dt * 9));
      // tiny high-speed shake (visual only)
      if (speed > 30) this.camPos.y += Math.sin(performance.now() * 0.05) * 0.008 * (speed - 30) * 0.1;
    }
    this.camera.position.copyFrom(this.camPos);
    this.camera.setTarget(look);
    this.veg?.update(this.camera);
    // Portrait phones: fix the HORIZONTAL field of view so the road isn't cropped to a slit.
    const portrait = this.engine.getAspectRatio(this.camera) < 1;
    this.camera.fovMode = portrait ? UniversalCamera.FOVMODE_HORIZONTAL_FIXED : UniversalCamera.FOVMODE_VERTICAL_FIXED;
    const base = portrait ? 1.12 : 0.9;
    const fovTarget = this.camMode === 'chase' ? base + Math.min(0.22, speed * 0.004) + (p.nitro ? 0.1 : 0) : portrait ? 1.35 : 1.0;
    this.camera.fov += (fovTarget - this.camera.fov) * (1 - Math.exp(-dt * 4));
  }

  /** Dynamic resolution: hold ~30 FPS by trading render scale (visual only). */
  adaptResolution() {
    if (this.resLocked) return;
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

  get currentQuality() {
    return this.quality;
  }

  /** Render statistics for the perf overlay / measurements. */
  private inst: SceneInstrumentation;
  /** Per-frame render statistics (draw calls are the last-second average per frame). */
  stats() {
    const s = this.scene;
    return {
      drawCalls: this.inst.drawCallsCounter.current,
      activeMeshes: s.getActiveMeshes().length,
      activeIndices: s.getActiveIndices(),
      cells: this.cells.size,
      routeSigns: this.routeSigns?.liveCount ?? 0,
      vegInstances: this.veg?.stats.instances ?? 0,
    };
  }

  dispose() {
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
