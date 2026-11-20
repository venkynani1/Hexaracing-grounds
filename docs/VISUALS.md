# Visual rebuild — status, measurements, limitations

Directive: make one car on one Chennai road look and feel convincing before expanding. This document records
what was built, what was measured, and what is NOT done. Asset licences: `docs/ASSETS.md`.

## What runs (and is tested)

| Area | Implementation |
|---|---|
| Car | Licensed GLB (Khronos "Car Concept", CC-BY 4.0; logos removed). Pipeline `tools/assets` → hero (105k tris), LOD1 (21k), LOD2 (3.9k), LOD3 (1.2k). Body merged by material; wheels re-centred on hubs; front wheels steer from the real steering input; wheels spin from distance travelled; body pitch/roll from acceleration and steering × speed²; brake lights (emissive, per car); tinted alpha glass; clear-coat PBR paint per squad. |
| Other squads | Same GLB, LOD1 < 70 m, LOD2 beyond; instanced (one draw call per template mesh for all cars), per-car paint via instance colour, brake lights, wheel spin + steering estimated from yaw rate, name labels < 160 m, contact shadows. |
| Roads | Built from the OSM graph the server simulates: PBR asphalt (CC0, world-space UVs, normal + roughness), Indian-style markings (white dashed lanes, solid edge lines, double yellow centre on trunk roads, yellow median edge), stop lines + zebra crossings at signals, black-and-yellow painted kerbs, interlocking-paver footpaths, raised concrete medians on divided arterials. Footpaths/kerbs/medians are clipped wherever they would intrude on another carriageway. |
| Roadside | Buildings = the server's collision boxes, dressed with CC0 facades (glass towers, offices, apartments) or an original painted-plaster Chennai low-rise facade with pastel tints and rooftop water tanks. Original LED street lights (both sides on trunk roads, median side on divided roads), coconut palms on verges (crowns never overhang a carriageway), speed-limit signs, signal heads on poles, fuel stations (forecourt/canopy sized to the space beside the road, pumps, FUEL pylon — generic, no brands). |
| Traffic | Same footprints as the shared traffic sim. Cars = licensed car (LOD3) in 8 baked colours; original procedural bus, truck, motorcycle + rider. Distance-culled. |
| Lighting | HDR image-based lighting (CC0 pure-sky HDRI), sun DirectionalLight with a shadow map that follows your car (1024 medium, 2048 high, PCF), contact shadows under every car, ACES tone mapping, haze (exp² fog), sky dome tonemapped from the same HDRI, FXAA (medium+), bloom (high+), vignette. |
| Weather / FX | Rain streaks, darker sky + heavier haze, wet asphalt (darker, roughness 0.92 → 0.18 so sky reflects), wet pavers; tyre smoke from lateral slip / handbrake; nitro flame at the exhaust; FOV kick on nitro. |
| Camera | Chase camera with smoothed yaw, speed-dependent distance/height/FOV, subtle high-speed shake; portrait phones use a horizontal-fixed FOV and a lower aim. Hood and top cameras kept. |
| HUD | Compact clock pill, arc speedometer with nitro ring + fuel/HP/tyre bars, round minimap with route, small toasts (checkpoint, waypoint, clue, fuel, pit, gate), announcements pop large for 3 s then minimise to a chip, glass touch pads (steer bottom-left; brake/gas/NOS/drift bottom-right). |
| Engineer | One question at a time, line-numbered highlighted code (no ligatures), A/B/C/D options or exact-output input, progress dots (✓ / ✕ / current), server-confirmed result ("Correct! +X" / "Not quite — N attempts left"), auto-advance after a final result, Prev/Next. The console takes the screen during a coding round; lobby details fold away. |
| Quality presets | Default chosen from the reported GPU (software / old low-end → low, known capable → high, else medium); player can change it. Low: no shadows/post, LOD1 for your own car (skips the 3 MB hero download). Dynamic resolution holds ~30 FPS within the preset. Visual only — gameplay identical on every preset. |
| Test drive | `/test-drive` — offline, clearly labelled, on the real OMR approach 1–3 km before the gate, with the shared vehicle physics and shared traffic AI; `?auto=1` autopilot, `?rain=1`, `?q=`, `?bench=60`. Never touches the event server. |

Tests: `npm test` 110 + 4 perf pass; `npm run test:e2e` 7/7 pass (racer view, four role consoles incl. the new Engineer console, monsoon, gate/convoy/podium); `npm run typecheck`; `npm run build`.

## Measurements

**No real mid-range Android phone was available in this environment, so no real-device frame rate is claimed.**
What was measured here: headless Chromium with SwiftShader (a CPU software rasteriser — far slower than any phone GPU),
915×412 landscape, `/test-drive?bench=20` (20 s autopilot after 5 s warm-up, dynamic resolution on):

| Preset | avg FPS | 1%-low FPS | avg frame | draw calls | triangles |
|---|---:|---:|---:|---:|---:|
| low | 30.0 | 21.0 | 33 ms | 87 | 45k |
| medium | 11.3 | 8.8 | 89 ms | 209 | 268k |
| high | 9.8 | 6.5 | 102 ms | 250 | 284k |

Hardware-independent budget: ≤ 250 draw calls and ≤ 290k triangles per frame on high; texture payload 5.7 MB total
(hero car 3.0 MB, skipped on low). For comparison the old box renderer ran ~40 FPS on medium in the same harness.

**How to measure on the phone:** open `https://<web-host>/test-drive?bench=60` on the device (any preset via `&q=`),
wait ~70 s; the result (avg / 1%-low FPS, frame times, draw calls, triangles, GPU string, viewport) is shown on screen.
Acceptance target: medium ≥ 30 FPS avg on the event's reference mid-range phone; otherwise ship low as the default.

## Known limitations (honest list)

- Not verified on a real phone (above). Software-GPU numbers are a worst case, not a prediction.
- Buildings are textured boxes on the server's procedural lots — not real OMR/Siruseri buildings; there are wide empty plots where the shared collision generator places no building. No real Chennai landmarks are modelled.
- Ground is a single tiled CC0 grass/soil texture; no terrain, no drainage, no trees other than palms.
- Street lights, palms, signs and tanks have no collision (thin props); buildings, barriers, traffic and cars do.
- Auto-rickshaws are not present: the shared traffic sim has no auto-rickshaw footprint, and adding one would change the server simulation. Buses/trucks/bikes are original low-poly procedural models, not photo-real.
- The car is a single licensed concept sports car for every squad (colour differs). No car choice visuals yet; headlights are emissive (no projected light beams), no night lighting.
- Rain has no puddles/splash or windscreen drops; tyre smoke and nitro are simple particles.
- Shadows only cover ~90 m around your car; distant buildings are unshadowed.
- Fog/haze and colour grading are tuned by eye on screenshots, not against reference photography.
- The finale/projector camera uses the same world; it looks plainer from the air (flat roofs, open plots).
