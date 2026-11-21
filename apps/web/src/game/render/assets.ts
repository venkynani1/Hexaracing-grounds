/**
 * Loads the licensed, pre-optimised assets from /assets (built by tools/assets — see docs/ASSETS.md).
 * Visual only: nothing here may influence gameplay. Every loader degrades to `null` so the game still runs
 * (with simpler visuals) if a file fails to load on a weak connection.
 */
import '@babylonjs/loaders/glTF';
import { KhronosTextureContainer2, LoadAssetContainerAsync, Texture, type AssetContainer, type Scene } from '@babylonjs/core';

export const ASSET_BASE = '/assets';

export async function loadContainer(scene: Scene, path: string): Promise<AssetContainer | null> {
  try {
    return await LoadAssetContainerAsync(`${ASSET_BASE}/${path}`, scene);
  } catch (e) {
    console.warn(`[assets] ${path} failed to load — falling back`, e);
    return null;
  }
}

/** Tiling texture with mipmaps + trilinear/anisotropic filtering (roads read at grazing angles). */
export function tiled(scene: Scene, file: string, aniso = 8): Texture {
  const t = new Texture(`${ASSET_BASE}/tex/${file}`, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
  t.anisotropicFilteringLevel = aniso;
  return t;
}

/** Self-hosted KTX2 transcoder (Apache-2.0, pinned in tools/assets) — no third-party CDN on event day. */
let ktxConfigured = false;
export function configureKtx2() {
  if (ktxConfigured) return;
  ktxConfigured = true;
  const base = `${location.origin}${ASSET_BASE}/ktx2`;
  Object.assign(KhronosTextureContainer2.URLConfig, {
    jsDecoderModule: `${base}/babylon.ktx2Decoder.js`,
    jsMSCTranscoder: `${base}/msc_basis_transcoder.js`,
    wasmMSCTranscoder: `${base}/msc_basis_transcoder.wasm`,
    wasmZSTDDecoder: `${base}/zstddec.wasm`,
  });
}

/** GPU-compressed tiling texture (KTX2/Basis → ETC2/ASTC/BC on device); WebP if KTX2 is unavailable. */
export function tiledCompressed(scene: Scene, webpPath: string, useKtx2: boolean, aniso = 4): Texture {
  configureKtx2();
  const url = `${ASSET_BASE}/${useKtx2 ? webpPath.replace(/\.webp$/, '.ktx2') : webpPath}`;
  const t: Texture = new Texture(url, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE, null, () => {
    if (!useKtx2) return;
    console.warn(`[assets] ${url} failed — falling back to WebP`);
    t.updateURL(`${ASSET_BASE}/${webpPath}`);
  });
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
  t.anisotropicFilteringLevel = aniso;
  return t;
}
