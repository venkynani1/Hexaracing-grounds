# Acceptance testing — vertical slice (Phase 5) and multiplayer (Phase 6)

## Phase 5 — on-device performance gate (`/slice`)

**Status: NOT YET RUN ON A DEVICE.** No Android phone is available to the build environment. The test page,
metrics and pass/fail evaluation are implemented and exercised in CI (`e2e/slice.spec.ts`); the gate result
below must be filled in from a real run on the agreed reference device.

### Agree the reference device first
Pick one mid-range Android phone that represents the audience (example class: 6 GB RAM, Snapdragon 7-series /
Dimensity 7000-series / Exynos 1380, Android 13–15, current Chrome). Record it here before testing.

### Procedure (≈ 20 min per run)
1. Serve a production build (`npm run build`, deploy or `vite preview`) over HTTPS on the venue Wi-Fi.
2. Phone: charged ≥ 50 %, unplugged, brightness 50 %, no battery saver, Chrome freshly restarted, room
   temperature noted.
3. Open `https://<host>/slice?accept=15&q=medium` — **a person drives** (overtakes, brakes at the signal,
   turns through the curves, uses nitro, drifts). Weather switches dry ↔ monsoon every 90 s automatically;
   the slice loops with a disclosed lap restart; traffic LODs switch continuously.
4. After 15 min of driving the page shows **PASS/FAIL** with every check and the full JSON (Copy / Download).
   Attach the JSON to this document.
5. Repeat with `&auto=1` (autopilot, for a reproducible baseline) and with `q=low` / `q=high` if medium fails/passes.
6. Note thermal behaviour: touch-temperature after the run, and the `fpsTimeline` / `scaleTimeline` trend.

### Benchmark configurations (same phone, same procedure, autopilot `&auto=1` for reproducibility)
Run each for 15 min and attach the JSON. `rain=0|1` pins the weather so dry and wet are measured separately.

| Run | URL | Measures |
|---|---|---|
| A dry | `/slice?accept=15&auto=1&q=high&bench=A&rain=0` | car + road only (floor cost of the renderer) |
| B dry | `/slice?accept=15&auto=1&q=high&bench=B&rain=0` | + vegetation |
| C dry | `/slice?accept=15&auto=1&q=high&rain=0` | full: traffic, lighting, buildings, vegetation |
| C rain | `/slice?accept=15&auto=1&q=high&rain=1` | full + monsoon (particles, wet road) |
| C dry / rain, Medium | same with `q=medium` | the preset we expect to ship |
| one feature off | add `&off=veg` / `traffic` / `scenery` / `fx` / `wetrefl` / `hero` | attribution if C fails |

The JSON includes `gpuFrameMsAvg` (EXT_disjoint_timer_query; null if the phone's browser hides it),
`simMsAvg` (physics + traffic AI), `jsFrameMsAvg`, `drawCallsAvg`, `activeMeshesAvg`, `trianglesK`,
`textureMemMB`, `particlesAvg`, long tasks and heap. Feature cost = FPS(C) vs FPS(C with `off=`).

### Gate (evaluated automatically on the page)
| Check | Requirement |
|---|---|
| Median FPS | ≥ 30 |
| 1% low FPS | ≥ 24 |
| p95 frame time | ≤ 40 ms |
| Steady-play stalls | 0 frames > 250 ms (after the 5 s warm-up) |
| Duration | ≥ 15 min continuous |
| Thermal | FPS of last 3 min ≥ 85 % of first 3 min **and** render-resolution drift < ×1.35 |
| Memory | no crash / reload (page completes); JS heap peak reported |

### Results (fill in)
| Field | Value |
|---|---|
| Device model / RAM | _pending_ |
| Android version | _pending_ |
| Browser + version | _pending_ |
| Screen resolution / DPR | _pending_ |
| Graphics preset | _pending_ |
| Median FPS / 1% low | _pending_ |
| p95 frame time / max stall | _pending_ |
| JS heap peak / texture memory | _pending_ |
| Download size (first load) | ≈ 7.1 MB expected (see PERF_AUDIT §3) |
| Thermal (FPS timeline, scale timeline, touch temp) | _pending_ |
| **Verdict** | **PENDING DEVICE RUN** |

### If a check fails — knobs, in order of measured impact (docs/PERF_AUDIT.md)
1. Render scale range (`SliceScene` `Q[preset].minScale/maxScale`) — pixel cost dominated the audit.
2. Vegetation LOD distances (`slice/vegetation.ts`) — largest measured feature cost (PERF_AUDIT §5).
3. Hero car LOD (Medium already uses the 20.7k LOD; High uses 62.6k) — single most expensive object.
4. Fog/draw distance + chunk culling radius (fewer static tris/draws).
5. Car IBL size (32/64) or hemispheric-only car lighting.
6. Particles budget (rain/smoke).
Re-run the same procedure after each change; record both runs.

## Phase 6 — multiplayer validation

Results are recorded in `docs/PROGRESS.md` (this session) with the exact commands. The automated suites
(`npm test`, `npm run test:perf`) cover 1 → 5 → 10 → 20 → 30 cars in one world, shared positions, collisions,
120 clients, reconnection storm and restart recovery; `tools/loadtest/src/rehearsal.ts` runs a real-time
60-minute rehearsal with 120 participant connections + host/projector observers.

### Phase 6 results — real-time 60-minute rehearsal (this environment)
`npx tsx tools/loadtest/src/rehearsal.ts --minutes 62` against a local server (PGlite): 30 squads × 4 role
clients = 120 participant WebSockets + host + projector observers, racers driving their real courses.

| Metric | Result |
|---|---|
| Unplanned disconnects | 0 |
| One logical world (every client same roomId, every minute) | yes, 56/56 samples |
| Server tick p99 (whole run / worst 400-tick window) | 5.0 ms / 6.8 ms (budget 50 ms) |
| RTT p95 worst minute (localhost) | 22 ms |
| Downstream per client | 6.7 KB/s |
| Phases | IGNITION → … → WELCOME_CONVOY → CHAMPIONSHIP_REVEAL → FINISHED |
| Reconnection storm (40 clients dropped at 20:00) | all rejoined, same world, 425 ms total, p95 417 ms |
| Final standings | 30 squads |

Not covered here: real phones, venue Wi-Fi, a deployed Neon database (PGlite was used), client FPS on devices.
