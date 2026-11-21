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
2. Hero car LOD (use the 20.7k LOD on medium) — single most expensive object.
3. Fog/draw distance + chunk culling radius (fewer static tris/draws).
4. Car IBL size (32/64) or hemispheric-only car lighting.
5. Particles budget (rain/smoke).
Re-run the same procedure after each change; record both runs.

## Phase 6 — multiplayer validation

Results are recorded in `docs/PROGRESS.md` (this session) with the exact commands. The automated suites
(`npm test`, `npm run test:perf`) cover 1 → 5 → 10 → 20 → 30 cars in one world, shared positions, collisions,
120 clients, reconnection storm and restart recovery; `tools/loadtest/src/rehearsal.ts` runs a real-time
60-minute rehearsal with 120 participant connections + host/projector observers.
