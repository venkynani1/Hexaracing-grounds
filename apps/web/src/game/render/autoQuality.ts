import type { Quality } from '../scene';

/**
 * Default graphics preset from the GPU the browser reports (visual only — never affects gameplay).
 * Software rasterisers and older low-end mobile GPUs start on "low"; known capable desktop/mobile GPUs on "high";
 * everything else on "medium". Dynamic resolution then holds ~30 FPS within the preset. Players can always change it.
 */
export function detectGpu(): string {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return 'none';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return r;
  } catch {
    return 'unknown';
  }
}

export function autoQuality(gpu = detectGpu()): Quality {
  const g = gpu.toLowerCase();
  if (/swiftshader|llvmpipe|softpipe|software|none|mali-[4t]\d{2}\b|adreno \(tm\) [3-5]\d{2}\b|powervr/.test(g)) return 'low';
  if (/apple m\d|apple gpu|nvidia|radeon rx|adreno \(tm\) (7[3-9]\d|8\d\d)|mali-g7[1-9]|mali-g[7-9]\d\d|immortalis|xclipse/.test(g)) return 'high';
  return 'medium';
}
