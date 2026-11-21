/**
 * Turn the pinned sources (.cache) into game-ready, mobile-sized files under apps/web/public/assets and write
 * docs/ASSETS.md. Run `npm run assets:fetch` first. Deterministic for a given cache.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO, type Material, type Node as GNode, type Texture } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP, KHRMaterialsClearcoat } from '@gltf-transform/extensions';
import { dedup, prune, quantize, simplify, textureCompress, weld, join as joinPrims } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { SOURCES } from './sources';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REPO = join(ROOT, '..', '..');
const CACHE = join(ROOT, '.cache');
const OUT = join(REPO, 'apps', 'web', 'public', 'assets');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

rmSync(OUT, { recursive: true, force: true });
for (const d of ['cars', 'props', 'tex', 'env', 'ktx2']) mkdirSync(join(OUT, d), { recursive: true });
await MeshoptSimplifier.ready;

const triCount = (doc: Document) =>
  doc
    .getRoot()
    .listMeshes()
    .reduce((n, m) => n + m.listPrimitives().reduce((k, p) => k + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')!.getCount()) / 3, 0), 0);

/* ------------------------------------------------------------------ car ------------------------------------------------------------------ */

/** Original Tamil Nadu style plate (black on white, no real registration). */
async function plateTexture(): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="128">
    <rect width="512" height="128" rx="10" fill="#f4f4f0"/><rect x="5" y="5" width="502" height="118" rx="8" fill="none" stroke="#111" stroke-width="4"/>
    <text x="256" y="90" font-family="DejaVu Sans Mono, monospace" font-weight="bold" font-size="66" text-anchor="middle" fill="#111">TN 09 RL 26</text></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

async function buildCar(lod: 'hero' | 'lod1' | 'lod2' | 'lod3') {
  const doc = await io.read(join(CACHE, 'car-concept', 'CarConcept.glb'));
  const root = doc.getRoot();
  // 1. Trademarks out (licence excludes logos).
  const imgOf = (t: Texture | null) => (t ? t.getImage() : null);
  const logo = root.listTextures().find((t) => t.getSize()?.[0] === 512 && t.getSize()?.[1] === 128 && root.listMaterials().some((m) => m.getName() === 'License' && m.getBaseColorTexture() === t));
  const plate = await plateTexture();
  for (const m of root.listMaterials()) {
    if (m.getName() === 'License') {
      const t = doc.createTexture('plate').setImage(plate).setMimeType('image/png');
      m.setBaseColorTexture(t);
      continue;
    }
    if (logo && m.getEmissiveTexture() === logo) m.setEmissiveTexture(null).setEmissiveFactor([0, 0, 0]);
    if (m.getName() === 'Tireside') {
      // colour map carries the Khronos/3D Commerce logos, normal map embosses "KHRONOS" — drop both.
      m.setBaseColorTexture(null).setBaseColorFactor([0.018, 0.018, 0.018, 1]).setNormalTexture(null).setRoughnessFactor(0.85);
    }
  }
  void imgOf;
  // 2. Variants/iridescence out; transmission glass → tinted alpha glass (far cheaper on phones).
  for (const ext of root.listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_materials_variants' || ext.extensionName === 'KHR_materials_iridescence' || ext.extensionName === 'KHR_materials_transmission') ext.dispose();
  }
  for (const m of root.listMaterials()) {
    if (m.getName() === 'Glass') m.setAlphaMode('BLEND').setBaseColorFactor([0.05, 0.07, 0.09, 0.42]).setRoughnessFactor(0.05).setMetallicFactor(0);
    if (/Paint/.test(m.getName())) m.setName(m.getName().replace(/ Carmine$/, ''));
    if (m.getName() === 'Interior 3 Carmine') m.setName('Interior 3');
  }
  // 3. LOD: the light version drops interior, brake pads, wipers, engine.
  const drop = (n: GNode) => {
    for (const c of n.listChildren()) drop(c);
    n.dispose();
  };
  if (lod !== 'hero') {
    for (const n of root.listNodes()) if (!n.isDisposed?.() && /^(Interior|Engine|BodyWindshieldWipers$|BodyHoodInterior|BodyHoodUnder|Axles)|BrakePad|BrakeDisc/.test(n.getName())) drop(n);
    // Normal maps and AO don't read at LOD distance.
    for (const m of root.listMaterials()) m.setNormalTexture(null).setOcclusionTexture(null);
    for (const m of root.listMaterials()) m.getExtension<import('@gltf-transform/extensions').Clearcoat>('KHR_materials_clearcoat')?.setClearcoatNormalTexture(null);
  } else {
    for (const n of root.listNodes()) if (/^BodyWindshieldWipers$/.test(n.getName())) drop(n); // 24k triangles hidden under the bonnet line
  }
  await doc.transform(prune(), dedup());
  const before = triCount(doc);
  await doc.transform(
    weld({}),
    simplify({ simplifier: MeshoptSimplifier, ratio: lod === 'hero' ? 0.27 : lod === 'lod1' ? 0.12 : lod === 'lod2' ? 0.025 : 0.006, error: lod === 'hero' ? 0.0008 : lod === 'lod1' ? 0.004 : lod === 'lod2' ? 0.03 : 0.08 }),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: lod === 'hero' ? [1024, 1024] : lod === 'lod1' ? [256, 256] : [64, 64], quality: 82 }),
    quantize(),
  );
  void KHRMaterialsClearcoat;
  void EXTTextureWebP;
  void joinPrims;
  const out = join(OUT, 'cars', `car_${lod}.glb`);
  await io.write(out, doc);
  return { file: out, trisBefore: Math.round(before), tris: Math.round(triCount(doc)) };
}

/* ---------------------------------------------------------------- props ---------------------------------------------------------------- */

async function buildProp(id: string, outName: string, ratio: number) {
  const doc = await io.read(join(CACHE, id, `${id}_1k.gltf`));
  const before = triCount(doc);
  await doc.transform(
    dedup(),
    weld({}),
    simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.002 }),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], quality: 80 }),
    quantize(),
  );
  const out = join(OUT, 'props', outName);
  await io.write(out, doc);
  return { file: out, trisBefore: Math.round(before), tris: Math.round(triCount(doc)) };
}

/* -------------------------------------------------------------- textures -------------------------------------------------------------- */

async function tex(src: string, out: string, size: number, quality = 80) {
  await sharp(src).resize(size, size, { fit: 'fill' }).webp({ quality }).toFile(join(OUT, 'tex', out));
  await toKtx2(join(OUT, 'tex', out), size, size);
}

/** GPU-compressed copy (KTX2 / Basis ETC1S + mipmaps): transcoded on device to ETC2/ASTC/BC — ~1/6 the VRAM of RGBA. */
async function toKtx2(webpPath: string, w: number, h: number, normal = false) {
  const { encodeToKTX2 } = await import('ktx2-encoder');
  const png = await sharp(webpPath).resize(w, h, { fit: 'fill' }).png().toBuffer();
  const imageDecoder = async (buf: Uint8Array) => {
    const { data, info } = await sharp(Buffer.from(buf)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
  };
  const out = await encodeToKTX2(new Uint8Array(png), { isUASTC: false, generateMipmap: true, qualityLevel: normal ? 200 : 140, compressionLevel: 2, isNormalMap: normal, imageDecoder } as never);
  writeFileSync(webpPath.replace(/\.webp$/, '.ktx2'), out);
}

async function buildTextures() {
  const c = (id: string, f: string) => join(CACHE, id, f);
  await tex(c('clean_asphalt', 'clean_asphalt_diff_1k.jpg'), 'asphalt_diff.webp', 1024);
  await tex(c('clean_asphalt', 'clean_asphalt_nor_gl_1k.jpg'), 'asphalt_nor.webp', 512, 90);
  await tex(c('clean_asphalt', 'clean_asphalt_rough_1k.jpg'), 'asphalt_rough.webp', 512);
  await tex(c('concrete_pavers_03', 'concrete_pavers_03_diff_1k.jpg'), 'pavers_diff.webp', 512);
  await tex(c('concrete_pavers_03', 'concrete_pavers_03_nor_gl_1k.jpg'), 'pavers_nor.webp', 512, 90);
  await tex(c('concrete', 'concrete_diff_1k.jpg'), 'concrete_diff.webp', 512);
  await tex(c('sparse_grass', 'sparse_grass_diff_1k.jpg'), 'grass_diff.webp', 512);
  await tex(c('leafy_grass', 'leafy_grass_diff_1k.jpg'), 'leafygrass_diff.webp', 1024);
  for (const id of ['Facade006', 'Facade019A', 'Facade018A', 'Facade001']) {
    const dir = join(CACHE, id, 'x');
    mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-oq', join(CACHE, id, `${id}_1K-JPG.zip`), '-d', dir]);
    await tex(join(dir, `${id}_1K-JPG_Color.jpg`), `${id.toLowerCase()}_diff.webp`, 1024, 82);
  }
  // Sky: tonemap the 2k pure-sky HDR (no terrain) into the visible dome + the 1k HDR for IBL.
  const hdr = decodeHdr(readFileSync(join(CACHE, 'kloofendal_48d_partly_cloudy_puresky', 'sky_2k.hdr')));
  const rgb = Buffer.alloc(hdr.w * hdr.h * 3);
  const aces = (x: number) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
  for (let i = 0; i < hdr.w * hdr.h; i++)
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(255 * Math.pow(aces(hdr.data[i * 3 + c]! * 0.9), 1 / 2.2));
  await sharp(rgb, { raw: { width: hdr.w, height: hdr.h, channels: 3 } }).resize(2048, 1024).webp({ quality: 84 }).toFile(join(OUT, 'env', 'sky.webp'));
  await toKtx2(join(OUT, 'env', 'sky.webp'), 1024, 512);
  // self-hosted KTX2 transcoder runtime (Apache-2.0)
  mkdirSync(join(OUT, 'ktx2'), { recursive: true });
  for (const f of ['babylon.ktx2Decoder.js', 'msc_basis_transcoder.js', 'msc_basis_transcoder.wasm', 'zstddec.wasm']) copyFileSync(join(CACHE, 'babylon-ktx2-decoder', f), join(OUT, 'ktx2', f));
  copyFileSync(join(CACHE, 'kloofendal_48d_partly_cloudy_puresky', 'sky_1k.hdr'), join(OUT, 'env', 'sky_1k.hdr'));
}

/** Minimal Radiance RGBE (.hdr) decoder (new-style RLE scanlines). */
function decodeHdr(buf: Buffer): { w: number; h: number; data: Float32Array } {
  let p = 0;
  const line = () => {
    const s = p;
    while (buf[p] !== 0x0a) p++;
    return buf.toString('latin1', s, p++);
  };
  let l = line();
  if (!l.startsWith('#?')) throw new Error('not an HDR file');
  while ((l = line()) !== '') if (l.startsWith('FORMAT') && !l.includes('32-bit_rle_rgbe')) throw new Error('unsupported HDR format');
  const m = /-Y (\d+) \+X (\d+)/.exec(line());
  if (!m) throw new Error('unsupported HDR orientation');
  const h = Number(m[1]);
  const w = Number(m[2]);
  const data = new Float32Array(w * h * 3);
  const scan = new Uint8Array(w * 4);
  for (let y = 0; y < h; y++) {
    if (buf[p] !== 2 || buf[p + 1] !== 2) throw new Error('flat HDR scanlines not supported');
    p += 4;
    for (let c = 0; c < 4; c++)
      for (let x = 0; x < w; ) {
        let n = buf[p++]!;
        if (n > 128) {
          n -= 128;
          const v = buf[p++]!;
          while (n--) scan[x++ * 4 + c] = v;
        } else while (n--) scan[x++ * 4 + c] = buf[p++]!;
      }
    for (let x = 0; x < w; x++) {
      const e = scan[x * 4 + 3]!;
      const f = e ? Math.pow(2, e - 136) : 0;
      const o = (y * w + x) * 3;
      data[o] = scan[x * 4]! * f;
      data[o + 1] = scan[x * 4 + 1]! * f;
      data[o + 2] = scan[x * 4 + 2]! * f;
    }
  }
  return { w, h, data };
}

/* ----------------------------------------------------------------- run ----------------------------------------------------------------- */

const stats: Record<string, { trisBefore: number; tris: number }> = {};
for (const lod of ['hero', 'lod1', 'lod2', 'lod3'] as const) {
  const r = await buildCar(lod);
  stats[relative(OUT, r.file)] = r;
}
stats['props/barrier.glb'] = await buildProp('concrete_road_barrier', 'barrier.glb', 0.02);
await buildTextures();
const { buildVegetation } = await import('./vegetation');
const vegStats = await buildVegetation();
for (const [id, v] of Object.entries(vegStats)) {
  stats[`veg/${id}_lod0.glb`] = { trisBefore: v.lod0, tris: v.lod0 };
  stats[`veg/${id}_lod1.glb`] = { trisBefore: v.lod0, tris: v.lod1 };
}

const files: { path: string; kb: number }[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push({ path: relative(OUT, p), kb: Math.round(statSync(p).size / 1024) });
  }
};
walk(OUT);
const total = files.reduce((a, f) => a + f.kb, 0);
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ files, totalKB: total, meshes: stats }, null, 2) + '\n');

/* ------------------------------------------------------------ inventory doc ------------------------------------------------------------ */
const lock = JSON.parse(readFileSync(join(ROOT, 'sources.lock.json'), 'utf8')) as Record<string, string>;
const md = [
  '# Asset inventory',
  '',
  '> Generated by `npm run assets:build` from `tools/assets/src/sources.ts`. Do not edit by hand.',
  '',
  'Every third-party file the game ships is listed here with its licence. Downloads are pinned by sha256 in',
  '`tools/assets/sources.lock.json`; a changed upstream file fails the fetch until the licence is re-checked.',
  'Map data (© OpenStreetMap contributors, ODbL 1.0) is documented separately in `packages/shared/src/map/CHENNAI_DATA_LICENSE.md`.',
  '',
  '| Asset | Kind | Authors | Licence | Source | Modifications | Used for |',
  '|---|---|---|---|---|---|---|',
  ...SOURCES.map((s) => `| ${s.title} | ${s.kind} | ${s.authors} | [${s.licence}](${s.licenceUrl}) | ${s.page} | ${s.modifications} | ${s.usage} |`),
  '',
  '## Original (made for this project, no third-party licence)',
  '',
  '- Number plate texture `TN 09 RL 26` (fictional) — generated in `tools/assets/src/build.ts`.',
  '- Procedural road geometry, lane markings, kerbs, footpaths, medians, junction surfaces — built at runtime from the OSM road graph (`apps/web/src/game/world/`).',
  '- Procedural building massing (shared with server collision), plaster facade texture, kerb paint, LED street lights, coconut palms, rooftop water tanks, speed-limit signs, signal heads, fuel-station forecourts, traffic vehicles (bus, motorcycle, truck), particle textures — runtime code in `apps/web/src/game/render/`.',
  '',
  '## Shipped files',
  '',
  '| File | Size (KB) | Triangles (source → shipped) |',
  '|---|---:|---|',
  ...files.map((f) => `| \`public/assets/${f.path}\` | ${f.kb} | ${stats[f.path] ? `${stats[f.path]!.trisBefore.toLocaleString('en')} → ${stats[f.path]!.tris.toLocaleString('en')}` : ''} |`),
  `| **total** | **${total}** | |`,
  '',
  '## Source pins (sha256)',
  '',
  ...Object.entries(lock).map(([k, v]) => `- \`${k}\` — \`${v}\``),
  '',
].join('\n');
writeFileSync(join(REPO, 'docs', 'ASSETS.md'), md);
console.log(JSON.stringify(stats, null, 1), `total ${total} KB`);
