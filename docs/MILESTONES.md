# Milestones & executable acceptance tests

A milestone is **done** only when every test listed for it is automated, committed, and passing in CI (`npm test` / `npm run test:e2e` / `npm run loadtest`). Manual checks are additionally listed where hardware is involved.

## M1 — Foundation
Scope: monorepo, Drizzle schema + migrations, registration (create squad / join by 6-char code), names + role selection, 4-player lobby, QR join, host dashboard (pre-START), server-authoritative event clock, signed sessions.

Acceptance tests:
- [x] `db`: migrations apply cleanly to an empty Postgres (PGlite in CI, Neon in staging). *PGlite ✅; Neon staging not yet run.*
- [x] `api`: creating a squad returns a 6-char code from the safe alphabet; creator is Captain (slot 4).
- [x] `api`: 3 more players join; a 5th join is rejected; duplicate role rejected; unknown code rejected.
- [x] `api`: role swap allowed before START only with Captain authorisation; rejected after START.
- [x] `api`: 30 squads × 4 players = 120 registrations succeed; 31st squad rejected (capacity).
- [x] `auth`: rejoin token restores the same slot on a new connection; tampered token rejected; host endpoints reject missing/invalid host key.
- [x] `clock`: START transitions REGISTRATION_LOCKED → COUNTDOWN → LIVE; pause/resume preserves elapsed time exactly (fake timers); phase at given elapsed ms matches the timeline table.
- [x] `ws`: a lobby client receives roster updates when a teammate joins (real WS in test).
- [x] `rate-limit`: >N join attempts per minute per IP returns 429.
- [x] `web` (Playwright): scan URL → create squad → 3 browser contexts join → all four see the full lobby; host page shows the squad and enables START when ready.

Status: all M1 tests pass locally (`npm test` 28 tests, `npm run test:e2e` 2 tests). GitHub Actions workflow added; first CI run still to be observed.

## M2 — Shared 3D world (single car)
- [x] Shared deterministic vehicle model: unit tests for accel/brake/steer, grip change in rain, fuel burn, health damage. (`packages/shared/test/sim.test.ts`)
- [x] Server runs fixed 20 Hz tick; tick p99 < 2 ms with 1 car + 100 traffic agents (benchmark test). (`apps/server/test/world.test.ts`, measured p99 ≈ 0.6 ms in the dev container)
- [x] Client renders test road network, chase camera, touch controls (Playwright smoke: canvas renders, FPS counter > 0, input moves car on server). (`apps/web/e2e/lobby.spec.ts`)
- [x] Traffic agents follow lanes, stop at red signals (sim unit test).
- [ ] Manual: 30 FPS on reference mid-range Android phone, Medium preset. **Not yet measured** — headless CI renders in software (~20 FPS) and is not representative.

Status: automated M2 tests pass locally (`npm test` 50 tests, `npm run test:e2e` 3 tests). First GitHub Actions run still to be observed.

## M3 — Actual multiplayer (same world, 5 → 10 → 20 → 30)
- [x] For each N in {5,10,20,30}: N headless racer bots in **one** `WorldRoom`; assert all share one room id, one tick counter, and that each bot's snapshot contains every other bot within Near range at server-truth positions (±0.5 m).
- [x] Two bots driving onto the same edge see each other; overtake changes order consistently on both clients.
- [x] Collision: two cars collide → both receive identical server-resolved impulses; damage capped; anti-ramming ghost-out triggers on repeated hits.
- [x] Prediction/reconciliation: with 150 ms simulated latency and 2% loss, own-car correction error < 1 m p95. (Measured: p95 ≈ 0.01 m with 150 ms one-way + 0–30 ms jitter, 2% loss each way.)
- [x] Interest tiers: far cars arrive at ≤ 1 Hz, near at 20 Hz; no squad ever missing from the global map channel. (Plus 10% hysteresis test.)
- [x] Static check: codebase contains no code path creating a second `WorldRoom` per event (test asserts singleton).

Status: all in `apps/server/test/multiplayer.test.ts`, passing locally. Real-time run (29 bots + 1 browser racer, 45 s, localhost): 1 room, 0 disconnects, 31.5 KB/s avg downstream per racer, 19.4 snapshots/s, server tick 20 Hz p99 1.74 ms. First GitHub Actions run still to be observed.

## M4 — Four-player squad mechanics
- [x] Engineer challenge: correct answer → scoring event + vehicle buff applied to the real squad car on server.
- [x] Deceiver bluffing: one entry per team, cannot vote own team, one vote per player, points deterministic.
- [x] Captain: navigation choice, power-up deploy, combined four-key submission.
- [x] Private clues: a player's WS stream never contains another role's clue (assert over full message log).
- [x] Playwright: four browser contexts, each role UI active simultaneously during one challenge.

Status: `apps/server/test/squad.test.ts` (+ `content.test.ts`, which executes every generated snippet to verify answer keys) and `apps/web/e2e/lobby.spec.ts` pass locally. First GitHub Actions run still to be observed.

## M5 — Chennai geography
- [x] mapbuild produces a connected graph: every enabled start location has a path to Hexaware (graph test).
- [x] All start locations verified (coordinates stored with `verified_at`); disabled ones not selectable.
- [x] Route calibration: reference-car simulated time for every route within ±10% after normalisation. (Measured: 29.4–30.8 min vs 30-min target.)
- [x] OSM attribution visible in-game and in credits.

Status: `apps/server/test/chennai.test.ts` + `apps/web/e2e/lobby.spec.ts` (M5 test) pass locally. First GitHub Actions run still to be observed.

## M6 — Fuel & suspense
- [x] Pit-stop 6-step flow end-to-end with four roles; FIFO queue; max dwell enforced; station never blocked.
- [x] Fuel exhaustion → roadside recovery, no elimination.
- [x] Director: running a full 60-min timeline in fast-forward fires every beat exactly once, in order; same seed → identical beat log; road closure always leaves a valid route for every squad.
- [x] Weather change visible to all clients within one global update.

Status: `apps/server/test/m6.test.ts` + M6 Playwright test pass locally. First GitHub Actions run still to be observed.

## M7 — Final experience
- [x] Gate assessment open to all squads 50:00–55:00; escort transition awards 0 driving points for skipped checkpoints.
- [x] Convoy: all 30 real cars placed in convoy slots in the same world; all clients receive the same convoy timeline (timestamps equal).
- [x] Offer letters: one PDF per player, contains required fields and the exact disclaimer string.
- [x] Championship: totals derived from `scoring_events`; tie-break test cases.

Status: `apps/server/test/m7.test.ts` + M7 Playwright test pass locally. First GitHub Actions run still to be observed.

## M8 — Production testing
- [x] Load test: 120 connected clients (30 racers + 90 role clients) + host + projector, 60-min fast-forward and a 15-min real-time run: server tick p99 < 10 ms, per-client downstream < 40 KB/s avg, zero disconnects without recovery.
  - Fast-forward (`load.perf.test.ts`, Chennai, 400 traffic, concurrent submissions at every challenge): tick p99 5.85 ms, downstream avg 8.7 KB/s, 0 disconnects, 30 standings, 120 letters.
  - Real-time 15 min (CLI, bots in a separate process, same 4-vCPU machine): tick p99 6.75 ms over 17,973 ticks at 20 Hz, downstream avg 5.8 KB/s (racers 10.8, host/projector 12.3), 0 disconnects, 19.9 snaps/s.
- [x] Reconnection storm: drop 40 clients at once, all rejoin to the same slots within 10 s. (`storm.test.ts`: ~0.4 s.)
- [x] Server restart mid-event: recovers from snapshot, state diff vs. pre-crash within one snapshot interval. (`restart.test.ts`.)
- [x] Fairness simulation: 1000 seeded runs × all routes × all cars; max-score reachable for every combination; mean driving score spread across routes < 5%. (`fairness.perf.test.ts`: 28,000/28,000 reachable; typical-player spread 2.41%; cars within ±2%. Timeline model — see PROGRESS.)
- [x] Security: replayed input seq rejected, forged session rejected, rate limits hold, no clue leakage, host routes protected. (`security.test.ts`.)
- [ ] Full 60-minute rehearsal with real phones on venue Wi-Fi (manual, logged in PROGRESS.md). **Needs the owner: devices, venue Wi-Fi, a deployed server.** Checklist in `docs/RUNBOOK.md` §6.

Status: all automated M8 items pass locally (`npm test` runs the perf suite isolated after the main suite). First GitHub Actions run still to be observed.
