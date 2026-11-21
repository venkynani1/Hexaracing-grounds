/**
 * Licensed vegetation → game-ready GLBs (run after `npm run assets:fetch`; needs python3 with Pillow + py7zr
 * to unpack .7z and read TGA, like tools/mapbuild needs pyosmium).
 *
 * For every species:  source mesh (OBJ / COLLADA) → assimp → GLB → textures re-linked from the pack →
 * transforms baked → scaled to a real-world height, base at y = 0, trunk centred → merged into ≤ 2 primitives
 * (bark: opaque, leaves: alpha-cutout) → textures resized + WebP →
 *   LOD0  as authored (already game-res: 0.2–3.4k tris)
 *   LOD1  bark simplified (meshoptimizer) + leaf cards thinned (keep ~45 %, survivors scaled up to keep volume)
 *   LOD2  built at runtime: one impostor atlas for all species (apps/web/src/game/slice/vegetation.ts).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, join as joinMeshes, prune, simplify, weld, transformPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import assimpjs from 'assimpjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '..', '.cache');
const OUT = join(HERE, '..', '..', '..', 'apps', 'web', 'public', 'assets', 'veg');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

export interface Species {
  id: string;
  source: string;
  /** directory inside the extracted pack + mesh file */
  dir: string;
  file: string;
  /** target height in metres (world scale 0.85 already applied by the game? no — real metres) */
  height: number;
  kind: 'tree' | 'palm' | 'shrub' | 'hedge' | 'grass';
  /** leaf texture longest side */
  leafTex: number;
}

const T = '3td-tropical/x/Tropical_Environment_Pack_v2.0_Ready/Tropical Rain Forest_Source v2.0/game/art/shapes/trees';
export const SPECIES: Species[] = [
  { id: 'ficus', source: '3td-tropical', dir: `${T}/CiabaTree_01`, file: 'CiabaTree_01.dae', height: 13, kind: 'tree', leafTex: 1024 },
  { id: 'copal', source: '3td-tropical', dir: `${T}/CopalTree`, file: 'CopalTree01.DAE', height: 11, kind: 'tree', leafTex: 1024 },
  { id: 'cecropia', source: '3td-tropical', dir: `${T}/Cecropia`, file: 'CecropiaTree01.DAE', height: 10, kind: 'tree', leafTex: 1024 },
  { id: 'palm_straight', source: 'nobiax-palms', dir: 'nobiax-palms/x', file: 'palm_straight.obj', height: 12, kind: 'palm', leafTex: 1024 },
  { id: 'palm_bend', source: 'nobiax-palms', dir: 'nobiax-palms/x', file: 'palm_bend.obj', height: 11, kind: 'palm', leafTex: 1024 },
  { id: 'palm_dual', source: 'nobiax-palms', dir: 'nobiax-palms/x', file: 'palm_dual.obj', height: 12.5, kind: 'palm', leafTex: 1024 },
  { id: 'bush_01', source: 'nobiax-bushes', dir: 'nobiax-bushes/x/01', file: 'bush_01.obj', height: 1.3, kind: 'shrub', leafTex: 512 },
  { id: 'bush_04', source: 'nobiax-bushes', dir: 'nobiax-bushes/x/04', file: 'bush_04.obj', height: 1.1, kind: 'shrub', leafTex: 512 },
  { id: 'bush_05', source: 'nobiax-bushes', dir: 'nobiax-bushes/x/05', file: 'bush_05.obj', height: 1.6, kind: 'shrub', leafTex: 512 },
  { id: 'hedge_long', source: 'nobiax-hedges', dir: 'nobiax-hedges/x/Long', file: 'HedgeLong.obj', height: 0.9, kind: 'hedge', leafTex: 512 },
  { id: 'grass', source: 'nobiax-grass-01', dir: 'nobiax-grass-01/x', file: 'grass.obj', height: 0.55, kind: 'grass', leafTex: 256 },
];

/** Unpack .7z / .zip once. */
function unpack(id: string) {
  const d = join(CACHE, id);
  if (existsSync(join(d, 'x'))) return;
  mkdirSync(join(d, 'x'), { recursive: true });
  if (existsSync(join(d, 'pack.7z'))) execFileSync('python3', ['-c', `import py7zr; py7zr.SevenZipFile('${join(d, 'pack.7z')}').extractall('${join(d, 'x')}')`]);
  else execFileSync('unzip', ['-oq', join(d, 'pack.zip'), '-d', join(d, 'x')]);
}

/** TGA → PNG next to the original (browsers and sharp can't read TGA). Grass ships colour + separate opacity. */
function tgaToPng(dir: string) {
  for (const f of readdirSync(dir)) {
    if (!f.includes('.') && existsSync(join(dir, f)) && readdirSync(join(dir, f)).length >= 0) {
      try {
        tgaToPng(join(dir, f));
      } catch {
        /* not a directory */
      }
      continue;
    }
    if (!/\.(tga|dds)$/i.test(f) || /_(NRM|SPEC)\.dds$/i.test(f) || /imposter/i.test(f)) continue;
    const out = join(dir, f.replace(/\.(tga|dds)$/i, '.png'));
    if (existsSync(out)) continue;
    execFileSync('python3', ['-I', '-c', `from PIL import Image; Image.open(${JSON.stringify(join(dir, f))}).save(${JSON.stringify(out)})`]);
  }
}

const findCI = (dir: string, name: string) => {
  const want = basename(name.replace(/\\/g, '/')).toLowerCase();
  return readdirSync(dir).find((f) => f.toLowerCase() === want) ?? null;
};

async function convert(sp: Species): Promise<Document> {
  const dir = join(CACHE, sp.dir);
  const ajs = await assimpjs();
  const fl = new ajs.FileList();
  for (const f of readdirSync(dir)) if (/\.(obj|mtl|dae)$/i.test(f)) fl.AddFile(f, new Uint8Array(readFileSync(join(dir, f))));
  const r = ajs.ConvertFileList(fl, 'glb2');
  if (!r.IsSuccess()) throw new Error(`${sp.id}: assimp failed (${r.GetErrorCode()})`);
  const glb = Buffer.from(r.GetFile(0).GetContent());
  // Re-link image URIs (absolute 3ds Max paths in the sources) to files in the pack folder.
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  for (const img of json.images ?? []) {
    const cand = findCI(dir, img.uri ?? '') ?? findCI(dir, (img.uri ?? '').replace(/\.(tga|dds|jpg|jpeg)$/i, '.png'));
    img.uri = cand ?? 'missing.png';
  }
  const j = Buffer.from(JSON.stringify(json).padEnd(Math.ceil(JSON.stringify(json).length / 4) * 4, ' '));
  const rest = glb.subarray(20 + jsonLen);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + j.length + rest.length, 8);
  head.writeUInt32LE(j.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  const tmp = join(dir, `__${sp.id}.glb`);
  writeFileSync(tmp, Buffer.concat([head, j, rest]));
  return io.read(tmp);
}

/** Bake node transforms into vertices, drop the hierarchy. */
function flattenToRoot(doc: Document) {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0]!;
  const prims: { p: Primitive; m: number[] }[] = [];
  const walk = (n: import('@gltf-transform/core').Node) => {
    const mesh = n.getMesh();
    if (mesh) for (const p of mesh.listPrimitives()) prims.push({ p, m: n.getWorldMatrix() as unknown as number[] });
    n.listChildren().forEach(walk);
  };
  scene.listChildren().forEach(walk);
  const mesh = doc.createMesh('veg');
  for (const { p, m } of prims) {
    const c = p.clone();
    transformPrimitive(c, m as never);
    mesh.addPrimitive(c);
  }
  for (const n of root.listNodes()) n.dispose();
  const node = doc.createNode('veg').setMesh(mesh);
  scene.addChild(node);
  return mesh;
}

function bbox(prims: Primitive[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    const a = p.getAttribute('POSITION')!;
    const v = [0, 0, 0];
    for (let i = 0; i < a.getCount(); i++) {
      a.getElement(i, v);
      for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k]!, v[k]!)), (max[k] = Math.max(max[k]!, v[k]!));
    }
  }
  return { min, max };
}

const isLeaf = (p: Primitive) => {
  const m = p.getMaterial();
  const t = m?.getBaseColorTexture();
  const name = `${m?.getName() ?? ''} ${t?.getURI() ?? ''}`.toLowerCase();
  if (/bark|trunk|wood/.test(name)) return false;
  return true;
};

/** Leaf-card thinning for LOD1: keep a deterministic subset of connected components, scale survivors up. */
function thinCards(p: Primitive, keep: number) {
  const idx = p.getIndices()!;
  const pos = p.getAttribute('POSITION')!;
  const n = pos.getCount();
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  const I = idx.getArray()!;
  for (let t = 0; t < I.length; t += 3) {
    const a = find(I[t]!);
    for (const b of [I[t + 1]!, I[t + 2]!]) parent[find(b)] = a;
  }
  // also union vertices at identical positions (welded seams between card halves)
  const comps = new Map<number, number[]>();
  for (let t = 0; t < I.length; t += 3) {
    const r = find(I[t]!);
    (comps.get(r) ?? comps.set(r, []).get(r)!).push(t);
  }
  const roots = [...comps.keys()];
  if (roots.length < 8) return; // a few big cards (e.g. palm fronds): keep all
  const kept: number[] = [];
  const scale = 1 / Math.sqrt(keep);
  const v = [0, 0, 0];
  const centroid = new Map<number, number[]>();
  roots.forEach((r, i) => {
    const h = (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;
    if (h > keep) return;
    const tris = comps.get(r)!;
    const c = [0, 0, 0];
    const verts = new Set<number>();
    for (const t of tris) for (let k = 0; k < 3; k++) verts.add(I[t + k]!);
    for (const vi of verts) {
      pos.getElement(vi, v);
      c[0]! += v[0]!;
      c[1]! += v[1]!;
      c[2]! += v[2]!;
    }
    for (let k = 0; k < 3; k++) c[k]! /= verts.size;
    centroid.set(r, c);
    for (const vi of verts) {
      pos.getElement(vi, v);
      pos.setElement(vi, [c[0]! + (v[0]! - c[0]!) * scale, c[1]! + (v[1]! - c[1]!) * scale, c[2]! + (v[2]! - c[2]!) * scale]);
    }
    for (const t of tris) kept.push(I[t]!, I[t + 1]!, I[t + 2]!);
  });
  idx.setArray(new Uint32Array(kept));
}

async function buildSpecies(sp: Species, lod: 0 | 1) {
  unpack(sp.source);
  const dir = join(CACHE, sp.dir);
  tgaToPng(dir);
  const doc = await convert(sp);
  const mesh = flattenToRoot(doc);
  await doc.transform(prune({ keepAttributes: true }), dedup());
  // Nobiax OBJs have no .mtl: one atlas texture (diffuse with alpha) covers trunk + leaves.
  const atlas = findCI(dir, 'diffuse.png');
  for (const p of mesh.listPrimitives()) {
    if (p.getMaterial()?.getBaseColorTexture()) continue;
    if (atlas) {
      const m = doc.createMaterial(`atlas_${sp.id}`);
      m.setBaseColorTexture(doc.createTexture(atlas).setImage(new Uint8Array(readFileSync(join(dir, atlas)))).setMimeType('image/png'));
      p.setMaterial(m);
    } else if (sp.kind !== 'grass') mesh.removePrimitive(p); // untextured fragments (e.g. a stray vine) are dropped
  }
  // Materials: leaves = alpha cutout + double-sided; bark = opaque. Grass ships opacity in a separate map.
  for (const p of mesh.listPrimitives()) {
    const m = p.getMaterial();
    if (!m) continue;
    m.setMetallicFactor(0).setRoughnessFactor(0.85).setEmissiveFactor([0, 0, 0]).setEmissiveTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null).setOcclusionTexture(null);
    if (isLeaf(p)) m.setAlphaMode('MASK').setAlphaCutoff(0.45).setDoubleSided(true).setName(`leaf_${sp.id}`);
    else m.setAlphaMode('OPAQUE').setDoubleSided(false).setName(`bark_${sp.id}`);
  }
  if (sp.kind === 'grass' || sp.source.startsWith('nobiax')) await mergeOpacity(doc, dir);
  // Nobiax textures are authored very dark (frond mean ≈ 0.17): lift RGB to sit with the CC0 3TD foliage
  // (mean ≈ 0.35) under the same baked light. Alpha (the cutout) is untouched.
  if (sp.source.startsWith('nobiax')) {
    for (const t of doc.getRoot().listTextures()) {
      const img = t.getImage();
      if (!img) continue;
      const { data, info } = await sharp(Buffer.from(img)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const gain = sp.kind === 'palm' ? 2.0 : 1.6;
      for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = Math.min(255, Math.round(data[i + c]! * gain + 6));
      t.setImage(new Uint8Array(await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer())).setMimeType('image/png');
    }
  }
  // scale to real height, base at 0, centred on the trunk (bark bbox) or the whole plant
  const prims = mesh.listPrimitives();
  const all = bbox(prims);
  const s = sp.height / (all.max[1]! - all.min[1]!);
  const bark = prims.filter((p) => !isLeaf(p));
  const ref = bark.length ? bbox(bark) : all;
  const cx = (ref.min[0]! + ref.max[0]!) / 2;
  const cz = (ref.min[2]! + ref.max[2]!) / 2;
  for (const p of prims) transformPrimitive(p, [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, -cx * s, -all.min[1]! * s, -cz * s, 1] as never);
  // merge by material, strip tangents/second UVs (unused), weld
  await doc.transform(weld({}), joinMeshes({ keepNamed: false }));
  for (const p of mesh.listPrimitives()) {
    for (const sem of p.listSemantics()) if (!['POSITION', 'NORMAL', 'TEXCOORD_0'].includes(sem)) p.setAttribute(sem, null);
    // assimp writes COLLADA UVs as VEC3 — glTF/WebGL loaders expect VEC2
    const uv = p.getAttribute('TEXCOORD_0');
    if (uv && uv.getType() === 'VEC3') {
      const a = uv.getArray()!;
      const out = new Float32Array((a.length / 3) * 2);
      for (let i = 0, j = 0; i < a.length; i += 3, j += 2) (out[j] = a[i]!), (out[j + 1] = a[i + 1]!);
      p.setAttribute('TEXCOORD_0', doc.createAccessor('uv').setType('VEC2').setArray(out).setBuffer(uv.getBuffer()));
    }
  }
  if (lod === 1) {
    for (const p of mesh.listPrimitives()) if (isLeaf(p)) thinCards(p, sp.kind === 'palm' ? 1 : 0.45);
    // simplify only the bark (leaf cards must keep their shape)
    const leafPrims = mesh.listPrimitives().filter(isLeaf);
    const tmpMesh = doc.createMesh('tmp');
    for (const p of leafPrims) (mesh.removePrimitive(p), tmpMesh.addPrimitive(p));
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: 0.35, error: 0.01 }));
    for (const p of leafPrims) (tmpMesh.removePrimitive(p), mesh.addPrimitive(p));
    tmpMesh.dispose();
  }
  // GPU-compressed textures (KHR_texture_basisu / ETC1S + mips): transcoded to ETC2/ASTC on Android.
  // Resize first (bark ≤ 512², leaves ≤ leafTex, LOD1 half), then encode.
  for (const t of doc.getRoot().listTextures()) {
    const img = t.getImage();
    if (!img) continue;
    const bark = doc
      .getRoot()
      .listMaterials()
      .some((m) => m.getBaseColorTexture() === t && /^bark/.test(m.getName()));
    const max = (bark ? 512 : sp.leafTex) / (lod === 1 ? 2 : 1);
    const out = await sharp(Buffer.from(img)).resize(max, max, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    t.setImage(new Uint8Array(out)).setMimeType('image/png');
  }
  const { ktx2 } = await import('ktx2-encoder/gltf-transform');
  const imageDecoder = async (buf: Uint8Array) => {
    const { data, info } = await sharp(Buffer.from(buf)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
  };
  await doc.transform(prune({ keepAttributes: true }), ktx2({ isUASTC: false, generateMipmap: true, qualityLevel: 160, compressionLevel: 2, imageDecoder } as never));
  mkdirSync(OUT, { recursive: true });
  const out = join(OUT, `${sp.id}_lod${lod}.glb`);
  await io.write(out, doc);
  const tris = mesh.listPrimitives().reduce((a, p) => a + (p.getIndices()?.getCount() ?? 0) / 3, 0);
  return { file: out, tris: Math.round(tris), kb: Math.round(readFileSync(out).length / 1024) };
}

/** Nobiax packs: diffuse has alpha in the TGA for leaves (already in PNG); grass uses diffus + opacity maps. */
async function mergeOpacity(doc: Document, dir: string) {
  const op = findCI(dir, 'opacity.png') ?? (existsSync(join(dir, 'grass_01')) ? 'grass_01/opacity.png' : null);
  const col = existsSync(join(dir, 'grass_01')) ? 'grass_01/diffus.png' : null;
  if (!op || !col) return;
  const c = await sharp(join(dir, col)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const a = await sharp(join(dir, op)).greyscale().resize(c.info.width, c.info.height).raw().toBuffer();
  const rgba = Buffer.alloc(c.info.width * c.info.height * 4);
  for (let i = 0; i < c.info.width * c.info.height; i++) {
    rgba[i * 4] = c.data[i * 3]!;
    rgba[i * 4 + 1] = c.data[i * 3 + 1]!;
    rgba[i * 4 + 2] = c.data[i * 3 + 2]!;
    rgba[i * 4 + 3] = a[i]!;
  }
  const png = await sharp(rgba, { raw: { width: c.info.width, height: c.info.height, channels: 4 } }).png().toBuffer();
  for (const m of doc.getRoot().listMaterials()) {
    const t = doc.createTexture('grass').setImage(new Uint8Array(png)).setMimeType('image/png');
    m.setBaseColorTexture(t);
  }
}

export async function buildVegetation(only?: string[]) {
  await MeshoptSimplifier.ready;
  const stats: Record<string, { lod0: number; lod1: number; kb0: number; kb1: number }> = {};
  for (const sp of SPECIES) {
    if (only && !only.includes(sp.id)) continue;
    const a = await buildSpecies(sp, 0);
    const b = await buildSpecies(sp, 1);
    stats[sp.id] = { lod0: a.tris, lod1: b.tris, kb0: a.kb, kb1: b.kb };
    console.log(sp.id, stats[sp.id]);
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ species: SPECIES.map((s) => ({ id: s.id, kind: s.kind, height: s.height, source: s.source })), stats }, null, 2) + '\n');
  return stats;
}




/* ------------------------------------------------------------------ vehicles (traffic props) */

export interface VehicleSpec {
  id: string;
  source: string;
  dir: string;
  file: string;
  /** target footprint (shared sim TRAFFIC_TYPES) */
  length: number;
  width: number;
  /** material name → new base colour (linear) */
  repaint: Record<string, [number, number, number]>;
  /** material whose centroid marks the FRONT */
  front: string;
  upAxis: 'y' | 'z';
}

export const VEHICLES: VehicleSpec[] = [
  { id: 'bus', source: 'ajan-bus', dir: 'ajan-bus/x/OBJ', file: 'BUS.obj', length: 11, width: 2.5, front: 'FrontLights', upAxis: 'y', repaint: { Body: [0.62, 0.06, 0.05], Metal: [0.75, 0.75, 0.72] } },
];

async function buildVehicle(v: VehicleSpec, lod: 0 | 1) {
  unpack(v.source);
  const doc = await convert({ id: v.id, source: v.source, dir: v.dir, file: v.file, height: 1, kind: 'shrub', leafTex: 0 });
  const mesh = flattenToRoot(doc);
  await doc.transform(prune({ keepAttributes: true }), dedup());
  const prims = mesh.listPrimitives();
  if (v.upAxis === 'z') for (const p of prims) transformPrimitive(p, [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1] as never);
  const centroid = (name: string) => {
    let n = 0;
    const c = [0, 0, 0];
    const t = [0, 0, 0];
    for (const p of prims) {
      if (p.getMaterial()?.getName() !== name) continue;
      const a = p.getAttribute('POSITION')!;
      for (let i = 0; i < a.getCount(); i++) (a.getElement(i, t), (c[0]! += t[0]!), (c[1]! += t[1]!), (c[2]! += t[2]!), n++);
    }
    return n ? c.map((x) => x / n) : null;
  };
  const all0 = bbox(prims);
  const mid = [0, 1, 2].map((k) => (all0.min[k]! + all0.max[k]!) / 2);
  const f = centroid(v.front) ?? [mid[0]!, 0, all0.max[2]!];
  const yaw = Math.atan2(f[0]! - mid[0]!, f[2]! - mid[2]!);
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  for (const p of prims) transformPrimitive(p, [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1] as never);
  const all = bbox(prims);
  const sz = v.length / (all.max[2]! - all.min[2]!);
  const sx = v.width / (all.max[0]! - all.min[0]!);
  const sy = (sx + sz) / 2;
  const cx = (all.min[0]! + all.max[0]!) / 2;
  const cz = (all.min[2]! + all.max[2]!) / 2;
  for (const p of prims) transformPrimitive(p, [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, -cx * sx, -all.min[1]! * sy, -cz * sz, 1] as never);
  for (const m of doc.getRoot().listMaterials()) {
    const r = v.repaint[m.getName()];
    if (r) m.setBaseColorFactor([r[0], r[1], r[2], 1]);
    m.setMetallicFactor(0).setRoughnessFactor(0.6);
  }
  for (const p of mesh.listPrimitives()) for (const sem of p.listSemantics()) if (!['POSITION', 'NORMAL'].includes(sem)) p.setAttribute(sem, null);
  await doc.transform(weld({}), joinMeshes({ keepNamed: false }));
  if (lod === 1) await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: 0.25, error: 0.01 }));
  await doc.transform(prune({ keepAttributes: true }));
  mkdirSync(join(OUT, '..', 'cars'), { recursive: true });
  const out = join(OUT, '..', 'cars', `${v.id}_lod${lod}.glb`);
  await io.write(out, doc);
  const tris = doc.getRoot().listMeshes().reduce((a, m) => a + m.listPrimitives().reduce((k, p) => k + (p.getIndices()?.getCount() ?? 0) / 3, 0), 0);
  return { tris: Math.round(tris), kb: Math.round(readFileSync(out).length / 1024) };
}

export async function buildVehicles() {
  await MeshoptSimplifier.ready;
  const stats: Record<string, unknown> = {};
  for (const v of VEHICLES) {
    stats[v.id] = { lod0: await buildVehicle(v, 0), lod1: await buildVehicle(v, 1) };
    console.log(v.id, JSON.stringify(stats[v.id]));
  }
  return stats;
}

if (process.argv[1] && /vegetation\.ts$/.test(process.argv[1])) {
  if (process.argv[2] === 'vehicles') await buildVehicles();
  else await buildVegetation(process.argv.slice(2).length ? process.argv.slice(2) : undefined);
}
