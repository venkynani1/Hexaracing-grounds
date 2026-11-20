/** PBR materials, sky dome and image-based lighting. Visual only. */
import {
  Color3,
  Constants,
  DynamicTexture,
  HDRCubeTexture,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  StandardMaterial,
  Texture,
  type BaseTexture,
  type Scene,
} from '@babylonjs/core';
import { ASSET_BASE, tiled } from './assets';

export interface WorldMaterials {
  asphalt: PBRMaterial;
  pavers: PBRMaterial;
  concrete: PBRMaterial;
  kerb: PBRMaterial;
  median: PBRMaterial;
  grass: PBRMaterial;
  paintWhite: PBRMaterial;
  paintYellow: PBRMaterial;
  facades: { glassTower: PBRMaterial; glassOffice: PBRMaterial; office: PBRMaterial; apartment: PBRMaterial; plaster: PBRMaterial };
  roof: PBRMaterial;
  metal: PBRMaterial;
  darkMetal: PBRMaterial;
  palmTrunk: PBRMaterial;
  palmLeaf: PBRMaterial;
  setWet(wet: boolean): void;
}

function pbr(scene: Scene, name: string, o: { albedo?: BaseTexture; color?: Color3; bump?: BaseTexture; rough?: number; metal?: number; uv?: number }) {
  const m = new PBRMaterial(name, scene);
  m.albedoColor = o.color ?? new Color3(1, 1, 1);
  if (o.albedo) m.albedoTexture = o.albedo;
  if (o.bump) {
    m.bumpTexture = o.bump;
    m.invertNormalMapY = false;
  }
  m.roughness = o.rough ?? 0.8;
  m.metallic = o.metal ?? 0;
  m.environmentIntensity = 0.9;
  return m;
}

/** Original procedural low-rise facade (painted plaster, windows with grilles, rolling shutters at street level). */
function plasterFacade(scene: Scene): DynamicTexture {
  const t = new DynamicTexture('plaster-facade', { width: 512, height: 512 }, scene, true);
  const c = t.getContext() as unknown as CanvasRenderingContext2D;
  c.fillStyle = '#e9e1d2';
  c.fillRect(0, 0, 512, 512);
  // grime gradient
  const g = c.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(60,45,30,0.18)');
  c.fillStyle = g;
  c.fillRect(0, 0, 512, 512);
  // two floors per tile: windows with sunshades (chajja)
  for (let f = 0; f < 2; f++) {
    const y = 40 + f * 256;
    for (let i = 0; i < 2; i++) {
      const x = 52 + i * 256;
      c.fillStyle = 'rgba(70,60,50,0.35)';
      c.fillRect(x - 10, y - 14, 172, 14); // sunshade
      c.fillStyle = '#2b3138';
      c.fillRect(x, y, 152, 120);
      c.fillStyle = '#56636e';
      c.fillRect(x + 6, y + 6, 68, 108);
      c.fillRect(x + 78, y + 6, 68, 108);
      c.strokeStyle = 'rgba(30,30,30,0.8)';
      c.lineWidth = 3;
      for (let k = 1; k < 6; k++) (c.beginPath(), c.moveTo(x, y + k * 20), c.lineTo(x + 152, y + k * 20), c.stroke());
    }
    c.fillStyle = 'rgba(0,0,0,0.12)';
    c.fillRect(0, y + 150, 512, 6); // floor band
  }
  t.update();
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
  t.anisotropicFilteringLevel = 4;
  return t;
}

/** Original coconut-palm frond (alpha). */
function frondTexture(scene: Scene): DynamicTexture {
  const t = new DynamicTexture('frond', { width: 256, height: 64 }, scene, true);
  const c = t.getContext() as unknown as CanvasRenderingContext2D;
  c.clearRect(0, 0, 256, 64);
  c.strokeStyle = '#5b6b2a';
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(0, 32);
  c.lineTo(256, 32);
  c.stroke();
  for (let i = 4; i < 250; i += 5) {
    const len = 28 * Math.sin((i / 256) * Math.PI) + 4;
    c.strokeStyle = i % 2 ? '#4f7a26' : '#5f8b2e';
    c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(i, 32);
    c.lineTo(i + 10, 32 - len);
    c.moveTo(i, 32);
    c.lineTo(i + 10, 32 + len);
    c.stroke();
  }
  t.update();
  t.hasAlpha = true;
  return t;
}

export function createWorldMaterials(scene: Scene): WorldMaterials {
  const asphalt = pbr(scene, 'asphalt', { albedo: tiled(scene, 'asphalt_diff.webp', 16), bump: tiled(scene, 'asphalt_nor.webp', 8), rough: 0.92, color: new Color3(0.78, 0.78, 0.8) });
  asphalt.metallicTexture = tiled(scene, 'asphalt_rough.webp', 4);
  asphalt.useRoughnessFromMetallicTextureGreen = true;
  asphalt.useRoughnessFromMetallicTextureAlpha = false;
  asphalt.useMetallnessFromMetallicTextureBlue = false;
  const pavers = pbr(scene, 'pavers', { albedo: tiled(scene, 'pavers_diff.webp'), bump: tiled(scene, 'pavers_nor.webp'), rough: 0.85 });
  const concreteTex = tiled(scene, 'concrete_diff.webp');
  const concrete = pbr(scene, 'concrete', { albedo: concreteTex, rough: 0.9 });
  const kerb = pbr(scene, 'kerb', { albedo: concreteTex, rough: 0.85, color: new Color3(0.92, 0.92, 0.9) });
  const median = pbr(scene, 'median', { albedo: concreteTex, rough: 0.8 });
  const grass = pbr(scene, 'grass', { albedo: tiled(scene, 'grass_diff.webp'), rough: 0.95, color: new Color3(0.9, 0.9, 0.85) });
  const paintWhite = pbr(scene, 'paint-white', { color: new Color3(0.92, 0.92, 0.88), rough: 0.6 });
  const paintYellow = pbr(scene, 'paint-yellow', { color: new Color3(0.95, 0.72, 0.08), rough: 0.6 });
  for (const p of [paintWhite, paintYellow]) (p.zOffset = -1), (p.emissiveColor = p.albedoColor.scale(0.12));
  const facade = (file: string, rough: number, metal: number) => {
    const t = tiled(scene, file, 4);
    return pbr(scene, `facade-${file}`, { albedo: t, rough, metal });
  };
  const plaster = pbr(scene, 'facade-plaster', { albedo: plasterFacade(scene), rough: 0.9 });
  const roof = pbr(scene, 'roof', { albedo: concreteTex, rough: 0.95, color: new Color3(0.75, 0.74, 0.72) });
  const metal = pbr(scene, 'metal', { color: new Color3(0.55, 0.57, 0.6), rough: 0.45, metal: 0.8 });
  const darkMetal = pbr(scene, 'dark-metal', { color: new Color3(0.06, 0.065, 0.07), rough: 0.5, metal: 0.4 });
  const palmTrunk = pbr(scene, 'palm-trunk', { color: new Color3(0.42, 0.36, 0.29), rough: 0.95 });
  const palmLeaf = pbr(scene, 'palm-leaf', { albedo: frondTexture(scene), rough: 0.8 });
  palmLeaf.useAlphaFromAlbedoTexture = true;
  palmLeaf.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  palmLeaf.alphaCutOff = 0.4;
  palmLeaf.backFaceCulling = false;
  palmLeaf.twoSidedLighting = true;

  const dry = { asphaltRough: 0.92, asphaltColor: asphalt.albedoColor.clone() };
  return {
    asphalt,
    pavers,
    concrete,
    kerb,
    median,
    grass,
    paintWhite,
    paintYellow,
    facades: {
      glassTower: facade('facade019a_diff.webp', 0.25, 0.4),
      glassOffice: facade('facade001_diff.webp', 0.2, 0.5),
      office: facade('facade006_diff.webp', 0.5, 0.2),
      apartment: facade('facade018a_diff.webp', 0.75, 0),
      plaster,
    },
    roof,
    metal,
    darkMetal,
    palmTrunk,
    palmLeaf,
    setWet(wet: boolean) {
      // Wet asphalt: darker, much smoother (sky + headlight reflections), the roughness map is ignored.
      asphalt.albedoColor = wet ? dry.asphaltColor.scale(0.55) : dry.asphaltColor;
      asphalt.metallicTexture = wet ? null : asphalt.metallicTexture;
      asphalt.roughness = wet ? 0.18 : dry.asphaltRough;
      if (!wet && !asphalt.metallicTexture) {
        asphalt.metallicTexture = tiled(scene, 'asphalt_rough.webp', 4);
        asphalt.useRoughnessFromMetallicTextureGreen = true;
      }
      pavers.roughness = wet ? 0.35 : 0.85;
      pavers.albedoColor = wet ? new Color3(0.7, 0.7, 0.7) : new Color3(1, 1, 1);
    },
  };
}

/** Sky dome (tonemapped equirect photo of a real sky, CC0) + HDR image-based lighting from the same capture. */
export function createSky(scene: Scene, lowEnd: boolean): { dome: Mesh; env: HDRCubeTexture | null } {
  let env: HDRCubeTexture | null = null;
  try {
    env = new HDRCubeTexture(`${ASSET_BASE}/env/sky_1k.hdr`, scene, lowEnd ? 64 : 128, false, true, false, true);
    env.rotationY = 0;
    scene.environmentTexture = env;
  } catch (e) {
    console.warn('[sky] HDR environment unavailable', e);
  }
  // UV-mapped dome: sphere UVs are equirectangular (v = 0 at the bottom pole), so the photo's horizon sits
  // exactly at eye level for every heading. Lower hemisphere is hidden by the ground plane + haze.
  const dome = MeshBuilder.CreateSphere('sky', { diameter: 5000, segments: 32, sideOrientation: Mesh.BACKSIDE }, scene);
  const mat = new StandardMaterial('sky-mat', scene);
  const tex = new Texture(`${ASSET_BASE}/env/sky.webp`, scene, true, true);
  tex.uScale = -1;
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  mat.emissiveTexture = tex;
  mat.disableLighting = true;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.fogEnabled = false;
  mat.backFaceCulling = false;
  dome.material = mat;
  dome.infiniteDistance = true;
  dome.isPickable = false;
  dome.applyFog = false;
  mat.disableDepthWrite = true;
  void Constants;
  return { dome, env };
}
