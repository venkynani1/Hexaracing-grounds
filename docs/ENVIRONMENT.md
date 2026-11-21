# Environment rebuild (vegetation + roadside) — report

Scope: the `/slice` OMR benchmark (≈ 805 m of Rajiv Gandhi Salai at Taramani). Primitive trees are gone;
all vegetation is licensed, downloaded, inspected, sha256-pinned (`tools/assets/sources.lock.json`) and
converted by `tools/assets/src/vegetation.ts` (`npm run assets:build`).

## 1. Licensed vegetation inventory

| Species (game id) | Source pack | Author | Licence | Attribution | LOD0 tris | LOD1 tris | LOD0 / LOD1 file |
|---|---|---|---|---|---:|---:|---|
| Ficus / rain-tree-like broadleaf (`ficus`) | 3TD Tropical Environment Pack v2.0 — "CiabaTree_01" | Ron Kapaun / 3 Tier Digital Studios | CC0 | not required | 3,375 | 1,456 | 320 / 128 KB |
| Broadleaf roadside tree (`copal`) | same — "CopalTree01" | same | CC0 | — | 2,849 | 1,285 | 273 / 138 KB |
| Broadleaf tree (`cecropia`) | same — "CecropiaTree01" | same | CC0 | — | 2,034 | 807 | 326 / 149 KB |
| Coconut palm straight / bend / dual (`palm_*`) | Free palm treeZ v3 | Nobiax / Yughues | CC0 | — | 940 | ≈ 592 | 285 / 104 KB |
| Shrubs ×3 (`bush_01/04/05`) | Bushes | Nobiax / Yughues | CC0 | — | 500–880 | 188–345 | 78–99 / 32–42 KB |
| Clipped median hedge (`hedge_long`) | Free Hedges | Nobiax / Yughues | CC0 | — | 2,410 | 370 | 195 / 50 KB |
| Grass tufts (`grass`) | Grass Pack #01 | Nobiax / Yughues | CC0 (readme: free for any use) | — | 4 (cross cards) | 4 | 26 / 9 KB |
| Turf ground (`leafygrass`) | Poly Haven "Leafy Grass" | Charlotte Baglioni | CC0 | — | — | — | KTX2 1024² |

Pages: opengameart.org/content/{3td-tropical-environment-pack-v20, free-palm-treez-v3, bushes, free-hedges,
grass-pack-01}; polyhaven.com/a/leafy_grass. Licence text verified in each pack's readme / page.
**Considered and rejected:** "Free Realistic Tree 9/10/12" (CC-BY, Unity-package only, no plain mesh);
Sketchfab CC-BY palms (download requires an authenticated account — not available here); Quaternius
(Google-Drive downloads, stylised); Kenney (site unreachable).
**Not native to Chennai:** the 3TD trees are generic tropical species standing in for neem / rain tree /
Indian almond; true neem (Azadirachta indica) and rain tree (Samanea saman) models remain on the acquisition
list. Coconut palms are correct for OMR.

### Pipeline (per species)
OBJ / COLLADA → assimp (WASM) → GLB · textures re-linked from the pack (TGA/DDS → PNG) · transforms baked ·
scaled to real height (ficus 13 m, copal 11 m, cecropia 10 m, palms 11–12.5 m, shrubs 1.1–1.6 m, hedge
0.9 m) · bark opaque / leaves **alpha-cutout** (MASK, double-sided, no blending) · normal/spec maps dropped ·
**LOD1**: bark simplified (meshoptimizer) + leaf cards thinned to 45 % with survivors scaled up ·
textures **KTX2 / Basis ETC1S in-GLB** (`KHR_texture_basisu`; verified transcode to ETC2 0x9274/0x9278),
bark ≤ 512², leaves ≤ 1024² (LOD1 half) · **LOD2**: impostor cards rendered once at load from each species'
LOD0 into one shared atlas.

### Runtime (`apps/web/src/game/slice/vegetation.ts`)
- One template per species × LOD shared by every plant; **thin instances** → 1 draw call per template mesh.
- Lighting baked into the template vertex colours once (canopy-spherical normals, inner-canopy darkening,
  light wrap); per-instance colour = natural tint ×(0.85–1.1) × baked sun visibility at that spot.
- LOD distances: trees LOD0 < 34 m, LOD1 < 120 m, impostor beyond; shrubs 26/80 m; hedge LOD0 only < 14 m
  (it was the measured triangle hog); grass < 42 m. 8 % hysteresis → no popping at boundaries.
- LOD reassignment only after the camera moves 4 m, via a 40 m spatial grid; buffers rebuilt only for
  species whose membership changed; no per-frame allocations.
- Placement follows the road's character: median = clipped hedge run + coconut palms + edge grass; verge =
  grass turf + broadleaf trees (spaced 17–37 m, never over a carriageway) + shrubs + tufts; empty frontages =
  compound wall with gate + campus planting behind; a sparse distant tree belt beyond 70 m (impostors).

## 2. Performance (measured, same harness as docs/PERF_AUDIT.md — SwiftShader software GPU)

| Run | median FPS | 1% low | p95 | JS/frame* | draws | tris | GPU tex |
|---|---:|---:|---:|---:|---:|---:|---:|
| slice **without** vegetation, high, scale 1 | 10.2 | 7.5 | 120 ms | 4.3 | 151 | 163k | 18.4 MB |
| slice **with** vegetation, high, scale 1 | 5.6 | 4.3 | 225 ms | 5.2 | 173 | 253k | 31.5 MB |
| without vegetation, low, ⅛ res, CPU ×4 | 22.3 | 12.0 | 69 ms | 12.5 | 135 | 100k | 7.2 MB |
| with vegetation, low, ⅛ res, CPU ×4 | 11.6 | 6.5 | 124 ms | 20.3 | 157 | 185k | 20.3 MB |

Vegetation first measured at 180k tris / 68 MB textures; after the fixes above: 97k tris / +13 MB.
\* A CPU profile (CDP, CPU ×4) shows 67 % of frame time is "(program)" — the renderer **blocked inside WebGL
calls waiting for SwiftShader**, i.e. GPU work emulated on the CPU; our vegetation JS is ≈ 1 %. The
remaining cost is GPU-side alpha-tested foliage fill + vertices. That is exactly what must be read on a real
GPU; this environment cannot.

## 3. Verdict

| Criterion | Status |
|---|---|
| No primitive-looking trees | **PASS** — all trees/palms/shrubs/hedges/grass are licensed models |
| No repeated identical silhouettes | **PASS (partial)** — 3 broadleaf + 3 palm variants + rotation/scale/tint; long runs still show repetition |
| No flat triangular palm fronds in foreground | **PASS** — textured, alpha-cutout fronds |
| No empty brown terrain beside major roads | **PASS** — turf verges, walled + planted frontages |
| Believable proportions | **PASS** — real-height scaling |
| Chennai roadside scenery | **PARTIAL** — species are generic tropical stand-ins for neem/rain tree; no autos/buses/bikes models |
| Daylight + wet presentation | **PARTIAL** — baked daylight, wet darkening, tyre spray, restrained rain; **no road reflections** |
| No placeholders | **PARTIAL** — buildings are textured boxes; compound walls can render dark on their shaded side |
| Performance gate (30 FPS median, 24 1%-low, p95 ≤ 40 ms, no stalls > 250 ms, 15 min) | **NOT TESTED ON A DEVICE** — no Android device here; software-GPU numbers above are not phone numbers |

**Overall: FAIL / NOT YET ACCEPTED.** Visual criteria largely met for vegetation; the performance gate cannot
be passed or failed without the reference phone, and the vegetation measurably doubled GPU cost in the proxy.
Run `/slice?accept=15` on the device (docs/ACCEPTANCE.md). If it fails, the measured knobs in order:
foliage LOD0 distances, grass density, impostor distance, render-scale range.

## 4. Remaining visual defects
1. Broadleaf species are not Chennai-native (neem / rain tree / Indian almond / gulmohar models needed).
2. Buildings are textured boxes on procedural lots. Variety improved: a 5th CC0 facade (ambientCG Facade020A) and per-building tint, but the massing is still boxes.
3. ~~Compound walls render dark~~ — fixed: `G.wall` stored the normal of the back face (winding mismatch), so every wall and facade was baked as if facing the other way. Fixed in the slice and in the live renderer (`render/geo.ts`).
4. Buses: licensed CC0 "3D Bus" (ajanhallinta) in the slice traffic (14.5k / 4.7k tris, generic red livery). Auto-rickshaws: still missing — candidates found on Sketchfab (CC BY) but downloading needs a Sketchfab API token. Motorcycles still missing: the only CC0 options found (OpenGameArt "fancy motorcycle", sci-fi; "Custom Harley Davidson FLH 1972", cruiser) don't match Chennai commuter bikes/scooters and were not used.
5. Wet roads: darkening + spray + a Fresnel sky sheen (environment-cube reflection at grazing angles, no extra render pass). No puddles, no reflections of cars/lights.
6. Impostors are single-view cards (visible when orbiting closely; fine from the chase camera).
7. Grass tufts are cross-cards; up close they read as cards.
