/**
 * Loads the licensed, pre-optimised assets from /assets (built by tools/assets — see docs/ASSETS.md).
 * Visual only: nothing here may influence gameplay. Every loader degrades to `null` so the game still runs
 * (with simpler visuals) if a file fails to load on a weak connection.
 */
import '@babylonjs/loaders/glTF';
import { LoadAssetContainerAsync, Texture, type AssetContainer, type Scene } from '@babylonjs/core';

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
