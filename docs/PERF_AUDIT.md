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

## 5. Performance & realism blocker (screenshots showed 5 FPS dry / 4 FPS rain on High)

### 5.1 Where the 5 / 4 FPS came from
Those screenshots were taken **in this cloud container**, whose WebGL is SwiftShader (CPU software
rasteriser). The profile below shows that **91–95 % of main-thread samples are `(program)`** — the thread is
blocked inside WebGL calls waiting for the software rasteriser. Everything the game itself does per frame is
small: JS (Babylon scene evaluation + our code) 2–8 ms, shared physics + traffic AI 0.1–0.4 ms, GC ≤ 0.5 %.
So in this environment the slice is **GPU (rasteriser) bound**, and halving the resolution alone doubles FPS.
This does not tell us the phone number; it does tell us which features cost the most pixels/vertices.

### 5.2 Method
- `apps/web/src/game/perf/probe.ts` now also records **simulation ms/frame** (physics + traffic AI, measured
  around the fixed-step loop), **active meshes**, **live particles**, and **GPU frame time** via
  `EXT_disjoint_timer_query` (`EngineInstrumentation.captureGPUFrameTime`). SwiftShader does not expose the timer
  query → "n/a" here; on Android Chrome it is reported when the GPU supports it.
- CDP CPU profile (20 s, 0.5 ms sampling) per run → share of `(program)` (blocked in GL), `(garbage collector)`,
  Babylon, shared sim, app code.
- New measurement switches (never on in normal play): `/slice?bench=A` car + road only, `bench=B` car + road +
  vegetation, no flag = C full (traffic, lighting, weather); `&rain=0|1` pins the weather;
  `&off=veg,traffic,scenery,fx,wetrefl,env,hero` disables one feature.
- 915×412 landscape, High preset, render scale locked at 1 (the preset the screenshots used), autopilot,
  40 s measured after warm-up, CPU unthrottled. Raw rows: `docs/perf/matrix-before.jsonl`, `matrix-after.jsonl`.
- **Shadows:** the slice has **no shadow map at all** (baked into vertex colours since the first slice
  build) → shadow cost is 0 ms by construction; nothing to ablate.

### 5.3 Before (commit 40e7865) — measured

| config | med FPS | 1% low | p95 ms | JS ms | sim ms | GPU ms | draws | active meshes | tris k | tex MB | particles | GC % | blocked-in-GL % | heap MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A car+road dry | 10.5 | 7.9 | 117 | 2.27 | 0.14 | n/a | 69 | 69 | 109 | 19 | 0 | 0.4 | 93.9 | 200 |
| B +vegetation dry | 6.0 | 3.8 | 241.4 | 3.28 | 0.14 | n/a | 90 | 90 | 188 | 32.2 | 0 | 0 | 95.3 | 244 |
| C full dry | 4.5 | 3.2 | 277.2 | 7.14 | 0.28 | n/a | 184 | 295 | 261 | 32.2 | 0 | 0 | 93.9 | 245 |
| C full rain | 3.8 | 2.7 | 309.4 | 8.28 | 0.40 | n/a | 188 | 296 | 262 | 32.2 | 2090 | 0.3 | 94.1 | 249 |
| C dry −vegetation | 8.2 | 5.8 | 147.2 | 5.41 | 0.25 | n/a | 162 | 273 | 178 | 19 | 0 | 0.3 | 92.6 | 226 |
| C dry −traffic | 5.7 | 3.8 | 239.9 | 3.88 | 0.17 | n/a | 131 | 131 | 211 | 32.2 | 0 | 0.4 | 94.9 | 239 |
| C dry −buildings/props | 5.1 | 3.5 | 253.1 | 6.11 | 0.26 | n/a | 140 | 251 | 236 | 32.2 | 0 | 0 | 93.9 | 246 |
| C dry hero car → 20.7k LOD | 6.4 | 4.1 | 218.6 | 5.42 | 0.25 | n/a | 169 | 279 | 198 | 21.9 | 0 | 0.3 | 93.1 | 226 |
| C rain −particles | 4.8 | 3.6 | 255.5 | 5.94 | 0.27 | n/a | 184 | 295 | 262 | 32.2 | 0 | 0.3 | 94.2 | 247 |
| C rain −wet reflection | 4.1 | 3.1 | 295.1 | 7.57 | 0.33 | n/a | 187 | 295 | 262 | 32.2 | 2071 | 0.5 | 93.9 | 249 |
| C full dry, ½ resolution | 9.3 | 6.7 | 128.4 | 6.09 | 0.21 | n/a | 184 | 294 | 262 | 32.2 | 0 | 0.5 | 90.6 | 247 |

**Largest contributors (C full dry = 4.5 FPS, removing one feature):** vegetation +82 % (→ 8.2), hero car
(84k triangles, clear-coat PBR) +42 % (→ 6.4), traffic +27 % (→ 5.7, incl. buses), buildings/props +13 %.
In rain: the 2.1k additive rain streaks +26 % (3.8 → 4.8), wet reflection +8 %. Physics, GC and JS are not
the bottleneck (JS ≤ 8 ms, physics ≤ 0.4 ms of a ≥ 200 ms frame).

### 5.4 Root causes found
1. **Measurement environment** — software GPU (above). Not fixable in code; the gate must run on the phone.
2. **Vegetation fill cost** — alpha-tested leaf cards (no early-Z) layered many deep; full-detail trees out to
   34 m, LOD1 cards to 120 m.
3. **Hero car** — 84k triangles and full PBR (clear coat, normal maps, interior) on High and Medium.
4. **Rain** — 2.1k additive streaks spawned in a 70 × 70 m box centred on the car: most were outside the view
   but still simulated, sorted and rasterised.
5. **Black foliage** (visual, §5.6).
6. **Wet-road "mirror"** (visual) — `setWet` assigned `.level` on the *shared* `scene.environmentTexture`, so the
   road reflection strength and the cars' IBL fought over one value; replaced by per-use texture clones.

### 5.5 What changed (each backed by a row above)
| change | evidence | file |
|---|---|---|
| Trees: full detail < 24 m (was 34), LOD1 < 70 m (was 120), impostors beyond; shrubs 16/55 m, grass 30 m, hedge 10 m | vegetation = largest cost | `slice/vegetation.ts` |
| Hero car re-simplified 83.8k → 62.6k triangles (High); Medium now uses the 20.7k LOD | hero ablation +42 % | `tools/assets/src/build.ts`, `SliceScene.ts` |
| Rain: 1000 × budget streaks (was 2600) in a 36 m box placed 14 m ahead of the car | particle ablation +26 % | `render/fx.ts`, `SliceScene.ts` |
| Wet reflection on cloned env textures (own level) | visual defect, cost unchanged | `slice/build.ts` |
| Placeholder bus removed from traffic (cars only until a licensed detailed bus exists) | visual standard | `SliceDrive.tsx` |
| Foliage colour space + alpha bleed + impostor clear colour | visual (§5.6), cost-neutral | `render/assets.ts`, `slice/vegetation.ts`, `tools/assets/src/vegetation.ts` |

Not changed, because the data does not support it: physics/traffic update rate (≤ 0.4 ms), GC (≤ 0.5 %),
draw-call merging (≤ 190 draws; JS ≤ 8 ms), shadows (none exist).

### 5.6 Black vegetation — root cause and fix
- **Texture colour space (main cause).** The glTF loader uploads base-colour textures as **sRGB buffers**
  (`useSRGBBuffers` default true; verified at runtime: every `veg-*` texture had `_useSRGBBuffer = true`), so the
  GPU returns *linear* texels. Our foliage is drawn with unlit `StandardMaterial`s, which treat the diffuse
  texture as *gamma* and linearise it again before ACES tone mapping. Leaf albedo 0.31 (sRGB) → 0.08 → ≈ 0.01:
  black. Fix: vegetation (and any glTF that ends up on a StandardMaterial) is loaded with
  `useSRGBBuffers: false` (`loadContainer(..., { srgbBuffers: false })`). Cars keep PBR materials, which handle
  sRGB buffers correctly. No global brightening was added; exposure/contrast/tone mapping are unchanged.
- **Mipmaps averaging black.** The leaf atlases ship near-black RGB (≈ 9,9,7) under alpha 0; mips blend that
  into the leaf colour, darkening every card at distance. The asset pipeline now **bleeds the leaf colour into
  the transparent texels** (iterative dilation, alpha untouched) before KTX2 encoding.
- **Impostor atlas** cleared to transparent black → same darkening in the far LOD; now cleared to the mean
  foliage colour with alpha 0.
- Checked and unchanged: alpha cutoff 0.45 (cutout, no blending), leaves double-sided, bark opaque/back-face
  culled; foliage receives no shadow map (baked); environment intensity only affects the (PBR) cars.
- Result: `docs/perf/foliage-after.jpg` (ficus, copal, cecropia, coconut palm at 14–90 m), `docs/perf/before-after.jpg`.

### 5.7 After — measured (same harness, same settings)

| config | med FPS | 1% low | p95 ms | JS ms | sim ms | GPU ms | draws | active meshes | tris k | tex MB | particles | GC % | blocked-in-GL % | heap MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A car+road dry | 11.3 | 8.5 | 105.1 | 2.33 | 0.12 | n/a | 69 | 69 | 88 | 19 | 0 | 0.2 | 93.9 | 212 |
| B +vegetation dry | 8.2 | 5.5 | 153.3 | 3.33 | 0.14 | n/a | 86 | 86 | 125 | 32.2 | 0 | 0.5 | 93.8 | 236 |
| C full dry | 6.7 | 4.4 | 181.4 | 6.22 | 0.29 | n/a | 165 | 310 | 186 | 32.2 | 0 | 0.5 | 91.9 | 241 |
| C full rain | 6.1 | 4.4 | 198.8 | 6.38 | 0.28 | n/a | 168 | 309 | 185 | 32.2 | 820 | 0 | 93.1 | 246 |
| C dry −vegetation | 9.5 | 6.6 | 134.9 | 5.21 | 0.25 | n/a | 148 | 294 | 146 | 19 | 0 | 0.3 | 91.8 | 227 |
| C dry −traffic | 8.2 | 5.8 | 155.0 | 3.38 | 0.12 | n/a | 126 | 126 | 148 | 32.2 | 0 | 0.4 | 94.2 | 235 |
| C dry −buildings/props | 7.4 | 4.9 | 169.5 | 5.78 | 0.26 | n/a | 123 | 268 | 162 | 32.2 | 0 | 0.5 | 91.9 | 240 |
| C dry hero car → 20.7k LOD | 9.1 | 6.5 | 136.8 | 5.28 | 0.25 | n/a | 150 | 292 | 143 | 21.9 | 0 | 0.3 | 91.8 | 226 |
| C rain −particles | 6.6 | 4.6 | 183.6 | 6.36 | 0.27 | n/a | 165 | 310 | 186 | 32.2 | 0 | 0.5 | 92.6 | 244 |
| C rain −wet reflection | 5.9 | 3.6 | 212.0 | 6.91 | 0.27 | n/a | 168 | 311 | 185 | 32.2 | 823 | 0.3 | 92.5 | 244 |
| C full dry, ½ resolution | 11.9 | 8.3 | 104.2 | 6.10 | 0.22 | n/a | 165 | 310 | 185 | 32.2 | 0 | 0.4 | 88.4 | 244 |

**Before → after, High, scale 1:** full dry 4.5 → **6.7** (+49 %), full rain 3.8 → **6.1** (+61 %), car + road
+ vegetation 6.0 → **8.2** (+37 %), p95 frame time dry 277 → 181 ms, triangles 261k → 186k. (C "−traffic" and
"full" after no longer include buses.) Remaining cost order: vegetation (+42 % if removed), hero car on High
(+36 % with the 20.7k LOD → which is why Medium now uses it), traffic (+22 %), buildings (+10 %).

### 5.8 Verdict for this blocker
**FAIL in this environment** — no configuration reaches 30 FPS on SwiftShader; even car + road only is 11 FPS,
so the software rasteriser alone rules out a pass here. **Device gate: NOT RUN** (no Android phone available).
The benchmark configurations A/B/C × dry/rain are ready to run on the reference phone (docs/ACCEPTANCE.md).

### 5.9 Fifteen-minute continuous runs (this environment, Medium preset, adaptive resolution, autopilot)
Raw JSON: `docs/perf/endurance-15min.jsonl`. Dynamic resolution settled at its floor (render scale 0.45).

| run | med FPS | 1% low | p95 ms | max frame | stalls > 250 ms | JS ms | sim ms | heap end / peak MB | texture MB | crash |
|---|---|---|---|---|---|---|---|---|---|---|
| dry, 900 s, 15,200 frames | 16.9 | 11.2 | 79.0 | 289 ms | 1 | 4.65 | 0.11 | 190 / 242 | 21.2 | none |
| rain, 900 s, 13,054 frames | 14.5 | 10.1 | 88.8 | 227 ms | 0 | 4.84 | 0.11 | 190 / 225 | 21.2 | none |

Memory is flat (same heap at the end of both runs, no growth trend) and FPS shows no downward drift over the
15 min (`fpsTimeline`). Gate result in this environment: **FAIL** (median < 30, 1 % low < 24, p95 > 40 ms) —
caused by the software rasteriser (≈ 86–87 % of main-thread time blocked in GL; JS ≈ 5 ms, physics 0.1 ms).
