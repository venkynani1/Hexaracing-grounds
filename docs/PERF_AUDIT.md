# Rendering performance audit (Phase 1) and optimisation results (Phase 2/4)

All numbers below were **measured**, not estimated, with `apps/web/src/game/perf/probe.ts` (per-frame interval,
Babylon SceneInstrumentation: JS frame time, render-target time, active-mesh evaluation, draw calls; triangles;
unique GPU texture memory; compiled effects; time to first ready frame; PerformanceObserver long tasks; JS heap).

## Environment — read this first

- No Android device and no GPU exist in this cloud container. Chromium runs **SwiftShader**, a CPU software
  rasteriser: both vertex and pixel shading run on 4 desktop CPU cores. Absolute FPS here does **not** predict a
  phone (a phone GPU is far faster at shading; a phone CPU is slower at JS).
- Therefore the audit separates costs:
  - **pixel cost**: same scene at render scale 1, ½, ¼ (resolution sweep);
  - **CPU/JS cost**: Babylon `frameTimeCounter` (JS time per frame) and runs with Chrome DevTools
    `Emulation.setCPUThrottlingRate = 4` (a common proxy for a mid-range Android CPU vs this desktop core);
  - **feature attribution**: one feature disabled per run (ablations), same seed, same autopilot drive.
- Viewport 915×412 landscape (Pixel-7-class), dynamic resolution locked, 15–20 s steady autopilot after 5 s warm-up.
- Dev server (Vite) — the 52.7 MB "download" in the baseline is the unbundled dev graph; production sizes below.

## 1. Baseline (existing `/test-drive`, full Chennai renderer)

| Run | median FPS | 1% low | p95 frame | JS/frame | shadow RT | draw calls | tris | tex MB* | effects | first ready |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| low (scale ½) | 22.7 | 13.4 | 59 ms | 3.0 ms | 0 | 90 | 33k | 51 | 30 | 4.7 s |
| medium (scale ⅔) | 6.6 | 2.0 | 210 ms | 7.0 ms | 1.2 ms | 242 | 271k | 176* | 52 | 7.8 s |
| **high (scale 1)** | **3.9** | **2.9** | **332 ms** | **9.1 ms** | 1.3 ms | **297** | **286k** | 200* | 57 | 11.5 s |
| high @ ½ res | 8.6 | 6.7 | 132 ms | 7.6 | | 292 | 285k | | | |
| high @ ¼ res | 12.1 | 9.6 | 98 ms | 7.0 | | 292 | 285k | | | |
| high @ ⅛ res | 14.6 | 11.2 | 83 ms | 7.1 | | 294 | 285k | | | |
| **high @ ⅛ res, CPU ×4** | 7.7 | 3.5 | 186 ms | **37.6 ms** | 6.2 | 288 | 287k | | | 16.8 s |
| low @ ⅛ res, CPU ×4 | 34.0 | 15.7 | 50 ms | 8.6 ms | 0 | 84 | 34k | | | 8.7 s |

\* the first probe double-counted shared textures; corrected unique-GPU-texture totals: **high 93.6 MB**
(of which the 2048² float shadow map = 32 MB), low 50.6 MB.

### Ablations (high, scale 1, one feature off)

| Disabled | median FPS (base 3.9) | JS/frame (base 9.1) | draw calls (297) | tris (286k) |
|---|---:|---:|---:|---:|
| hero car (105k-tri GLB) | **5.7** | 7.0 | 210 | **80k** |
| image-based lighting | 5.0 | 8.8 | 294 | 285k |
| shadow map | 4.7 | **5.6** | **193** | **147k** |
| post-processing (FXAA/bloom) | 4.6 | 8.8 | 289 | 285k |
| buildings | 4.2 | 7.5 | 234 | 283k |
| traffic | 4.1 | 8.0 | 278 | 267k |
| street props | 3.8 | 8.9 | 256 | 253k |
| particles | 3.9 | 9.2 | 297 | 286k |
| **all of the above** | 13.9 | 2.4 | 89 | 23k |

### Findings (measured causes)

1. **Per-pixel shading is the dominant GPU cost**: FPS rises 2.2× at ½ resolution and 3.1× at ¼ — every
   world surface used PBR (IBL + normal/roughness maps + shadow sampling), plus a post-process pass.
2. **The hero car is the most expensive object**: 105k triangles, drawn twice (colour + shadow map) — removing
   it alone gives +46% FPS and −206k triangles.
3. **The shadow map** doubles geometry (286k → 147k tris without it), costs 3.5 ms JS/frame (render-target
   pass) and 32 MB of float texture.
4. **JS/CPU time breaks the budget on a phone-class CPU**: 37.6 ms/frame at 4× throttle on high (budget 33 ms)
   — draw-call submission (~290), active-mesh evaluation (7.7 ms) and the shadow pass.
5. **Shader compilation / startup**: 57 effects, first interactive frame 11.5 s (16.8 s at CPU×4); long tasks
   up to 485 ms during play when new street cells stream in and compile.
6. **Texture memory** 94 MB (high) — uncompressed RGBA WebP decodes, 1024² facades, float shadow map.
7. **Physics is not a bottleneck**: shared vehicle model + IDM traffic = 0.02 ms per 50 ms step (6 cars),
   0.27 ms (140 cars) on this CPU (Node microbenchmark).
8. **Garbage collection**: JS heap steady at 205–245 MB in dev mode (no unbounded growth over a run);
   GC pauses could not be isolated from SwiftShader frame time — must be read on the device (probe reports
   max frame and long tasks).

## 2. What changed (Phase 2/4) and why

| Measured cause | Change | Where |
|---|---|---|
| Per-pixel PBR on the whole world | Static world **unlit + baked lighting**: sun, sky, AO and building/tree/canopy shadows baked into vertex colours at load (yielding every 8 ms; 0.12–0.4 s, 0.9–1.7 s at CPU×4) | `slice/bake.ts`, `slice/build.ts` |
| Shadow map (geometry ×2, RT pass, 32 MB) | **No shadow map**. Cars get a contact shadow + a soft sun-projected footprint; static shadows are baked | `slice/SliceScene.ts` |
| Post-process pass | **None**; ACES tone mapping in-shader; no MSAA; dynamic resolution holds ≥ 30 FPS | `SliceScene` |
| Hero car 105k tris | Hero re-simplified to **83.8k**; **low uses the 20.7k LOD**; traffic LOD1 only < 28 m, 3.9k LOD2 beyond | `tools/assets/src/build.ts`, `render/vehicles.ts` |
| ~300 draw calls, 434 meshes | Bounded slice built once, **merged per material into 400 m chunks**; untextured parts share one vertex-colour material; concrete family shares one texture; materials frozen | `slice/build.ts` |
| 330k static tris | Ground grid 24 m; hedges as strips instead of 400 shrub clumps; kerbs as textured strips instead of 1 m blocks; rain trees only on major roads | `slice/build.ts` |
| 94 MB textures | **KTX2 / Basis ETC1S** (→ ETC2 on Android; verified transcode `0x9274`), self-hosted transcoder; facades 1024², rest 512² | `tools/assets`, `render/assets.ts` |
| Shader compile hitches | **Warm-up** (`whenReadyAsync` + 3 frames) before driving; bounded slice = no new materials appear while driving | `SliceScene.load` |

## 3. Results — vertical slice `/slice` (same harness, same method)

| Run | median FPS | 1% low | p95 | JS/frame | draw calls | tris | tex MB | effects | first ready |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| low, scale 1 | 14.5 | 10.2 | 88 ms | 3.4 ms | 174 | 159k | **6.7** | 22 | 0.9 s |
| medium, scale 1 | 10.0 | 7.4 | 118 ms | 4.0 ms | 190 | 224k | 17.1 | 31 | 1.3 s |
| high, scale 1 | **9.9** (was 3.9) | 7.4 (was 2.9) | 118 ms (was 332) | 4.0 ms (was 9.1) | 192 (was 297) | 225k | **17.9** (was 93.6) | 31 (was 57) | **1.4 s** (was 11.5) |
| low, ⅛ res, CPU ×4 | 18.1 | 11.6 | 77 ms | **13.3 ms** | 174 | 159k | 6.7 | 22 | 3.2 s |
| high, ⅛ res, CPU ×4 | 14.1 | 8.9 | 92 ms | **14.8 ms** (was 37.6) | 192 | 226k | 17.9 | 31 | 4.5 s |

- High preset in the same software-GPU harness: **2.5× median FPS, 2.6× 1%-low, −64% p95, −56% JS per frame,
  −35% draw calls, −81% texture memory, 8× faster first ready frame**.
- On the phone-CPU proxy the JS frame cost is now **13–15 ms of the 33 ms budget** (was 37.6 ms on high).
- The remaining SwiftShader frame time is CPU-emulated vertex/pixel shading, which a phone GPU does in hardware.
- Download for `/slice` (production build): JS 1.5 MB gzip (Babylon 1.04 MB, Chennai map 0.30 MB, app 0.1 MB)
  + assets 5.6 MB ≈ **7.1 MB**.

## 4. What this does NOT prove

The 30 FPS gate is a **device** gate. Nothing above is a phone measurement. The on-device acceptance test is
`/slice?accept=15` (you drive) or `/slice?accept=15&auto=1` (autopilot) — see `docs/ACCEPTANCE.md`.
