# Asset manifest & acquisition checklist (vertical slice)

Every asset in the slice with source, licence, attribution, complexity, GPU texture memory and shipped size.
Full licence table for all shipped files: `docs/ASSETS.md` (generated). Downloads are sha256-pinned in
`tools/assets/sources.lock.json`.

## In the slice now

| Asset | Source / licence | Attribution required | Geometry | GPU texture memory | Shipped size |
|---|---|---|---|---|---|
| Hero car (your car) | Khronos glTF Sample Assets "Car Concept", **CC BY 4.0** (logos removed) | Yes — on /credits | 83.8k tris (from 189k) | ≈ 12 MB (measured; WebP-in-GLB, RGBA) | 2.47 MB GLB |
| Traffic + other squads, near | same, LOD1 | same | 20.7k tris | ≈ 1 MB | 340 KB |
| Traffic + other squads, far | same, LOD2 | same | 3.9k tris | < 0.1 MB | 103 KB |
| Asphalt | Poly Haven "Clean Asphalt" (Dimitrios Savva), CC0 | No | — | 0.67 MB (KTX2→ETC2, 1024², mips) | 148 KB |
| Pavers | Poly Haven "Concrete Pavers 03" (Charlotte Baglioni), CC0 | No | — | 0.17 MB | 51 KB |
| Concrete (kerbs/podiums/walls/roofs/verge) | Poly Haven "Concrete" (Rob Tuytel), CC0 | No | — | 0.17 MB | 51 KB |
| Grass/soil ground + median | Poly Haven "Sparse Grass" (Amal Kumar), CC0 | No | — | 0.17 MB | 52 KB |
| Facades ×4 | ambientCG Facade001/006/018A/019A (Lennart Demes), CC0 | No | modular boxes on collision lots | 4 × 0.67 MB | 77–131 KB each |
| Sky dome | Poly Haven "Kloofendal 48d Partly Cloudy Pure Sky" (Greg Zaal, Jarod Guest), CC0 — tonemapped by our pipeline | No | 16-segment dome | 0.33 MB (1024×512 ETC2) | 74 KB |
| Car reflections (IBL) | same HDRI, 1k .hdr | No | — | 64–128² float cube | 1.4 MB |
| KTX2 transcoder | Babylon.js KTX2 decoder + basis_universal + zstd, **Apache-2.0** | Licence notice | — | — | 560 KB (self-hosted) |
| Road geometry, markings, kerbs, medians, hedges, palms, rain trees, street lights, gantry, signals, bus shelter, petrol station, compound walls, building modules, shop signs | **Original** (procedural, this project) from OSM road graph (ODbL) | OSM: yes ("© OpenStreetMap contributors") | 129k static tris total, 143 meshes | baked vertex light (no textures) | in JS |

Totals measured in the slice: static 129k tris; frame 159k (low) – 226k (high) tris; 174–192 draw calls;
texture memory 6.7 MB (low) – 17.9 MB (high); `/slice` download ≈ 7.1 MB (JS 1.5 MB gz + assets 5.6 MB).

## Missing — exact acquisition checklist

The directive forbids primitive boxes as final trucks/buses and inventing URLs. These are NOT in the slice
(the slice uses only the six licensed cars as traffic); the live game still shows original procedural
bus/truck/motorbike placeholders, which are **placeholders, not final assets**.

| # | Needed | Requirements | Where to look (verify licence on the asset page before download) | Owner |
|---|---|---|---|---|
| 1 | ~~Chennai MTC-style city bus~~ DONE: CC0 "3D Bus" by ajanhallinta (OpenGameArt) | (generic livery, no operator logo) | GLB, ≤ 15k tris LOD0 + LOD1 ≤ 3k, PBR ≤ 1024², CC0 / CC BY / commercial licence permitting web redistribution | Sketchfab (filter: downloadable + CC licences), TurboSquid / CGTrader (check "web/real-time" rights), or commission | Art lead |
| 2 | Goods truck (Indian 2-axle, painted cab, tarpaulin) | same budgets | same | Art lead |
| 3 | Auto-rickshaw (+ a new traffic type in the shared sim: 2.6 × 1.3 m footprint) | ≤ 8k tris, generic livery | Verified CC BY, downloadable on Sketchfab: "Autorikshaw - Indian Tuk Tuk" (bhagathartworks, 8.1k faces, uid 5775d012693741008acff9dad410e92d); "Low Poly Autorickshaw aka TukTuk" (Nirmal.Justin, 4.8k, uid c7c87455ad014b3f9fc8c9fb2d164a61); "Auto Rickshaw" (rSquare, 12.6k, uid 44776bcb34e04c1a8b9c18a70376304e). Download requires a Sketchfab API token. | Owner: provide token |
| 4 | Commuter motorcycle / scooter + rider (Splendor/Activa class) | ≤ 6k tris | No suitable CC0 found (OGA options are sci-fi / cruiser). Sketchfab CC BY likely — needs the same Sketchfab token as the auto | Owner |
| 5 | Two more licensed sports/sedan car bodies for squad variety | same pipeline as the Khronos car (logo/trademark scrub) | Khronos glTF-Sample-Assets has no other car; Sketchfab CC0/CC BY | Art lead |
| 6 | Licensed OMR photos for texture work (e.g. real shop-front textures) | photos the client owns or CC0; no Street View | client photographer / Commons CC0 | Client |
| 7a | Neem (Azadirachta indica), rain tree (Samanea saman), Indian almond, gulmohar | GLB with LOD0 ≤ 4k tris, alpha-cutout leaf atlas ≤ 1024², CC0/CC-BY | Sketchfab (needs an account to download), SpeedTree/Megascans (commercial licence), or commission | Art lead |
| 7 | Hexaware gate/building reference + approved branding | from Hexaware brand team only (CLAUDE.md §5) | client | Client |

To add any of these: put the source in `tools/assets/src/sources.ts` (licence, authors, modifications), run
`npm run assets:fetch` (pins sha256) and `npm run assets:build` (optimises + regenerates docs/ASSETS.md).
