/**
 * Ambient traffic visuals. Footprints match the shared traffic sim exactly (TRAFFIC_TYPES length/width) so
 * what you see is what you can hit.
 *  - car:        the licensed car (far LOD), merged into ONE mesh, colour per vehicle (instance colour)
 *  - motorcycle: original procedural bike + rider
 *  - bus:        original procedural city bus (generic livery, no operator branding)
 *  - truck:      original procedural goods truck (painted cab, tarp load)
 * One draw call per type for all vehicles (instances).
 */
import {
  Color3,
  Color4,
  DynamicTexture,
  Matrix,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Quaternion,
  Vector3,
  VertexBuffer,
  type InstancedMesh,
  type Scene,
} from '@babylonjs/core';
import { TRAFFIC_TYPES } from '@redline/shared';
import type { CarTemplate } from './vehicles';

type Part = { mesh: Mesh; color: [number, number, number] };

function paint(m: Mesh, c: [number, number, number]) {
  const n = m.getTotalVertices();
  const col = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) col.set([c[0], c[1], c[2], 1], i * 4);
  m.setVerticesData(VertexBuffer.ColorKind, col);
}

function mergeParts(name: string, parts: Part[], scene: Scene, mat: PBRMaterial): Mesh {
  for (const p of parts) {
    if (!p.mesh.isVerticesDataPresent(VertexBuffer.UVKind)) p.mesh.setVerticesData(VertexBuffer.UVKind, new Float32Array(p.mesh.getTotalVertices() * 2));
    paint(p.mesh, p.color);
    p.mesh.bakeCurrentTransformIntoVertices();
  }
  const m = Mesh.MergeMeshes(
    parts.map((p) => p.mesh),
    true,
    true,
  )!;
  m.name = name;
  m.material = mat;
  m.useVertexColors = true;
  m.registerInstancedBuffer('color', 4);
  m.instancedBuffers.color = new Color4(1, 1, 1, 1);
  m.isPickable = false;
  m.setEnabled(false);
  void scene;
  return m;
}

const box = (scene: Scene, w: number, h: number, d: number, x: number, y: number, z: number) => {
  const b = MeshBuilder.CreateBox('p', { width: w, height: h, depth: d }, scene);
  b.position.set(x, y, z);
  return b;
};
const wheel = (scene: Scene, r: number, w: number, x: number, z: number) => {
  const c = MeshBuilder.CreateCylinder('w', { diameter: r * 2, height: w, tessellation: 14 }, scene);
  c.rotation.z = Math.PI / 2;
  c.position.set(x, r, z);
  return c;
};

/** The far-LOD licensed car merged into one vertex-coloured mesh (paint white → instance colour). */
function mergedCar(tpl: CarTemplate, scene: Scene, mat: PBRMaterial): Mesh {
  const parts: Part[] = [];
  const add = (src: Mesh, offset?: Vector3) => {
    const c = src.clone('c', null, true, false)!;
    c.makeGeometryUnique();
    c.setEnabled(true);
    if (offset) c.position.copyFrom(offset);
    const pm = src.material as PBRMaterial | null;
    const a = pm?.albedoColor ?? new Color3(0.3, 0.3, 0.3);
    const isPaint = !!pm && /^Paint/.test(pm.name);
    const isGlass = !!pm && /Glass/.test(pm.name);
    const isLight = !!pm && /light/i.test(pm.name);
    const col: [number, number, number] = isPaint ? (/Paint 2/.test(pm!.name) ? [0.25, 0.25, 0.25] : [1, 1, 1]) : isGlass ? [0.03, 0.04, 0.05] : isLight ? [0.9, 0.85, 0.75] : [Math.min(1, a.r * 2), Math.min(1, a.g * 2), Math.min(1, a.b * 2)];
    for (const k of [VertexBuffer.UV2Kind, VertexBuffer.TangentKind]) if (c.isVerticesDataPresent(k)) c.removeVerticesData(k);
    parts.push({ mesh: c, color: col });
  };
  for (const m of tpl.body) add(m);
  for (const k of ['FL', 'FR', 'RL', 'RR'] as const) for (const m of tpl.wheels[k].meshes) add(m, tpl.wheels[k].center);
  const m = mergeParts('traffic-car', parts, scene, mat);
  // Scale to the sim's car footprint (4.5 × 1.8) so visuals match collisions.
  const s = TRAFFIC_TYPES.car.length / tpl.length;
  m.scaling.set(TRAFFIC_TYPES.car.width / tpl.width, s, s);
  m.bakeCurrentTransformIntoVertices();
  return m;
}

function busLivery(scene: Scene): PBRMaterial {
  const t = new DynamicTexture('bus-tex', { width: 4, height: 4 }, scene, false);
  t.update();
  const m = new PBRMaterial('bus-mat', scene);
  m.albedoColor = new Color3(1, 1, 1);
  m.roughness = 0.45;
  m.metallic = 0.1;
  void t;
  return m;
}

function proceduralBus(scene: Scene, mat: PBRMaterial): Mesh {
  const { length: L, width: W } = TRAFFIC_TYPES.bus;
  const p: Part[] = [
    { mesh: box(scene, W, 0.9, L, 0, 0.95, 0), color: [0.72, 0.12, 0.1] }, // lower body
    { mesh: box(scene, W * 1.002, 1.05, L - 0.6, 0, 1.92, -0.2), color: [0.06, 0.08, 0.1] }, // window band
    { mesh: box(scene, W, 0.45, L, 0, 2.66, 0), color: [0.92, 0.9, 0.84] }, // upper body
    { mesh: box(scene, W - 0.2, 0.2, L - 1.5, 0, 2.98, -0.3), color: [0.75, 0.75, 0.72] }, // roof
    { mesh: box(scene, W * 0.98, 1.3, 0.05, 0, 1.95, L / 2), color: [0.05, 0.07, 0.09] }, // windscreen
    { mesh: box(scene, 0.5, 0.18, 0.06, -0.8, 0.8, L / 2 + 0.01), color: [1, 0.95, 0.8] },
    { mesh: box(scene, 0.5, 0.18, 0.06, 0.8, 0.8, L / 2 + 0.01), color: [1, 0.95, 0.8] },
    { mesh: box(scene, 0.4, 0.2, 0.06, -0.9, 0.8, -L / 2 - 0.01), color: [0.8, 0.05, 0.05] },
    { mesh: box(scene, 0.4, 0.2, 0.06, 0.9, 0.8, -L / 2 - 0.01), color: [0.8, 0.05, 0.05] },
  ];
  for (const z of [L / 2 - 2.2, -L / 2 + 2.6]) for (const x of [-W / 2 + 0.15, W / 2 - 0.15]) p.push({ mesh: wheel(scene, 0.5, 0.3, x, z), color: [0.03, 0.03, 0.03] });
  return mergeParts('traffic-bus', p, scene, mat);
}

function proceduralTruck(scene: Scene, mat: PBRMaterial): Mesh {
  const { length: L, width: W } = TRAFFIC_TYPES.truck;
  const p: Part[] = [
    { mesh: box(scene, W, 1.7, 2.2, 0, 1.75, L / 2 - 1.1), color: [0.95, 0.55, 0.08] }, // cab (painted)
    { mesh: box(scene, W * 1.003, 0.7, 0.05, 0, 2.1, L / 2 + 0.01), color: [0.05, 0.07, 0.09] }, // windscreen
    { mesh: box(scene, W, 0.5, L - 2.4, 0, 1.15, -1.2), color: [0.25, 0.2, 0.15] }, // bed
    { mesh: box(scene, W - 0.05, 1.9, L - 2.6, 0, 2.35, -1.25), color: [0.12, 0.32, 0.55] }, // tarp load
    { mesh: box(scene, W, 0.25, 0.3, 0, 0.75, L / 2 + 0.05), color: [0.2, 0.2, 0.2] },
  ];
  for (const z of [L / 2 - 1.3, -L / 2 + 2.6, -L / 2 + 1.4]) for (const x of [-W / 2 + 0.15, W / 2 - 0.15]) p.push({ mesh: wheel(scene, 0.5, 0.3, x, z), color: [0.03, 0.03, 0.03] });
  return mergeParts('traffic-truck', p, scene, mat);
}

function proceduralBike(scene: Scene, mat: PBRMaterial): Mesh {
  const { length: L } = TRAFFIC_TYPES.motorcycle;
  const p: Part[] = [
    { mesh: wheel(scene, 0.32, 0.1, 0, L / 2 - 0.35), color: [0.03, 0.03, 0.03] },
    { mesh: wheel(scene, 0.32, 0.12, 0, -L / 2 + 0.35), color: [0.03, 0.03, 0.03] },
    { mesh: box(scene, 0.32, 0.35, 1.0, 0, 0.62, 0), color: [0.75, 0.75, 0.78] }, // tank/body
    { mesh: box(scene, 0.3, 0.12, 0.7, 0, 0.86, -0.35), color: [0.05, 0.05, 0.05] }, // seat
    { mesh: box(scene, 0.6, 0.05, 0.05, 0, 1.05, 0.55), color: [0.1, 0.1, 0.1] }, // handlebar
    { mesh: box(scene, 0.4, 0.62, 0.3, 0, 1.25, -0.25), color: [0.2, 0.3, 0.55] }, // rider torso
    { mesh: MeshBuilder.CreateSphere('h', { diameter: 0.3, segments: 6 }, scene), color: [0.85, 0.85, 0.85] }, // helmet
  ];
  p[p.length - 1]!.mesh.position.set(0, 1.7, -0.15);
  return mergeParts('traffic-bike', p, scene, mat);
}

const CAR_COLOURS: [number, number, number][] = [
  [0.92, 0.92, 0.9],
  [0.92, 0.92, 0.9],
  [0.7, 0.71, 0.73],
  [0.7, 0.71, 0.73],
  [0.1, 0.1, 0.11],
  [0.55, 0.06, 0.06],
  [0.12, 0.22, 0.45],
  [0.45, 0.42, 0.38],
];
const BIKE_COLOURS: [number, number, number][] = [
  [0.75, 0.75, 0.78],
  [0.08, 0.08, 0.08],
  [0.6, 0.05, 0.05],
  [0.1, 0.2, 0.5],
];

export class TrafficRenderer {
  private readonly templates: Mesh[];
  private readonly pool = new Map<number, InstancedMesh>();
  constructor(
    private readonly scene: Scene,
    carTpl: CarTemplate | null,
  ) {
    const mat = new PBRMaterial('traffic-mat', scene);
    mat.albedoColor = new Color3(1, 1, 1);
    mat.roughness = 0.42;
    mat.metallic = 0.25;
    const busMat = busLivery(scene);
    const car = carTpl
      ? mergedCar(carTpl, scene, mat)
      : mergeParts('traffic-car', [{ mesh: box(scene, TRAFFIC_TYPES.car.width, 1.4, TRAFFIC_TYPES.car.length, 0, 0.75, 0), color: [1, 1, 1] }], scene, mat);
    this.templates = [car, proceduralBike(scene, mat), proceduralBus(scene, busMat), proceduralTruck(scene, mat)];
  }

  update(items: { id: number; type: number; x: number; z: number; heading: number }[]) {
    const seen = new Set<number>();
    for (const t of items) {
      seen.add(t.id);
      let inst = this.pool.get(t.id);
      if (!inst) {
        const tpl = this.templates[t.type] ?? this.templates[0]!;
        inst = tpl.createInstance(`tr${t.id}`);
        inst.isPickable = false;
        const pal = t.type === 0 ? CAR_COLOURS : t.type === 1 ? BIKE_COLOURS : [[1, 1, 1] as [number, number, number]];
        const c = pal[t.id % pal.length]!;
        inst.instancedBuffers.color = new Color4(c[0], c[1], c[2], 1);
        this.pool.set(t.id, inst);
      }
      inst.position.set(t.x, 0, t.z);
      inst.rotation.y = t.heading;
      inst.setEnabled(true);
    }
    for (const [id, inst] of this.pool) if (!seen.has(id)) inst.setEnabled(false);
  }

  get templateMeshes() {
    return this.templates;
  }
}

export { Matrix, Quaternion };
