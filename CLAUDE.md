# CODE REDLINE: ROAD TO HEXAWARE — Claude Code project guide

> Race. Decode. Survive. Arrive.

This file is loaded automatically in every Claude Code session. **Do not ask the user to re-paste the spec.** The full original brief is in `docs/SPEC.md` (authoritative, verbatim). The engineering design is in `docs/DESIGN.md`. Milestones and acceptance tests are in `docs/MILESTONES.md`. Keep `docs/PROGRESS.md` updated at the end of every working session.

## What we are building
A 60-minute live event game: **120 players, 30 squads of exactly 4, one shared persistent 3D Chennai world**, all driving to **Hexaware Technologies, Siruseri**. Host presses START once; the server-side **Redline Director** runs everything else. Finale: synchronized **Hexaware Gate** assessment, **Welcome Convoy** of all 30 real cars, championship reveal, commemorative offer letters.

Roles per squad: **P1 Racer** (drives), **P2 Engineer** (coding/debug challenges), **P3 Deceiver** (bluffing), **P4 Captain** (strategy, navigation, fuel, combined submissions; squad creator starts as Captain).

## NON-NEGOTIABLES (read before every change)
1. **ONE WORLD.** One authoritative world simulation, one global coordinate system, one clock, one weather state, one traffic sim, one leaderboard, one destination, one convoy. Never create per-team rooms, per-team maps, separate race instances, ghost cars, or client-animated fake opponents. If you are tempted to shard for performance, use interest management / streaming cells inside the same world (see DESIGN §5).
2. **Server-authoritative.** Physics, positions, collisions, scoring, timers, random events and clue distribution are decided on the server. Clients send inputs only.
3. **Fairness.** Start location, car choice, device quality and graphics preset must not change the maximum achievable score. All random events are seeded, bounded, reproducible and audit-logged.
4. **Honesty.** Never claim a feature works unless it runs and has a passing test. No fabricated positions on the projector. No secret teleports — any assisted transition is disclosed in-game.
5. **No copied IP.** Original or properly licensed 3D assets and map data only (e.g. OpenStreetMap under ODbL with attribution). No Google Maps/Street View scraping. No GTA assets. Hexaware branding only from approved sources; offer letters are stamped `COMMEMORATIVE GAME OFFER LETTER — NOT AN EMPLOYMENT OFFER`.
6. **Secrets.** Never commit `.env` files or credentials. DB credentials never reach the browser.

## Stack
| Layer | Choice |
|---|---|
| Frontend | React + TypeScript + Vite + Babylon.js, deployed on **Vercel** (`apps/web`) |
| Realtime | Persistent **Node.js** authoritative server, WebSockets (Colyseus single `WorldRoom`, or `ws` with equivalent design), deployed on a long-running host (Fly.io / Railway / Render / VM) — **never** a serverless function (`apps/server`) |
| Shared | Types, constants, protocol, scoring rubric, director schedule, seeded RNG, vehicle tuning (`packages/shared`) |
| Database | **Neon PostgreSQL** + **Drizzle ORM** (`packages/db`); pooled connections; tests may use PGlite |
| Tests | Vitest (unit/integration), Playwright (web), custom headless WS bots for load tests (`tools/loadtest`) |

## Repo layout (target)
```
apps/web          React + Babylon client: join/lobby, showroom, racer HUD, role UIs, host dashboard, projector
apps/server       Authoritative world sim, Redline Director, scoring, HTTP API, WS gateway
packages/shared   Protocol, enums, scoring rubric, timeline, RNG, vehicle stats
packages/db       Drizzle schema, migrations, repositories
tools/loadtest    120-client headless bot harness
tools/mapbuild    OSM -> road graph + streaming cells pipeline
docs/             SPEC, DESIGN, MILESTONES, PROGRESS, RUNBOOK, SCORING
```

## Working rules for Claude Code
- Work milestone by milestone (docs/MILESTONES.md). A milestone is done only when its acceptance tests pass in CI.
- Multiplayer scale-up must go 1 → 5 → 10 → 20 → 30 real cars in the **same** world, testing shared positions at each step.
- Do not persist vehicle positions per frame; keep live state in memory, write checkpoints, scoring events and periodic recovery snapshots.
- All DB writes that can be retried must be idempotent (client-generated or server-generated idempotency keys).
- Scoring: every point awarded is a row in `scoring_events` with category, reason, source event id and server timestamp. Totals are derived, never edited.
- Keep balancing values (fuel 75%, credits 500, etc.) in `packages/shared/src/balance.ts` — they are provisional.
- When you finish a session, update `docs/PROGRESS.md` (what runs, what's tested, what's next, open risks).

## Commands (fill in as they become real)
```
npm install
npm run dev          # server (:2567, embedded PGlite if DATABASE_URL unset) + web (:5173, proxies /api and /ws)
npm test             # vitest: shared, db (PGlite), server (HTTP inject + real WS); then timing benchmarks alone (vitest.perf.config.ts)
npm run test:e2e     # Playwright (boots its own server :2599 + vite :5199)
npm run typecheck    # tsc for every workspace
npm run build        # vite build of apps/web
npm run db:generate -- --name <change>   # drizzle-kit generate (packages/db/migrations)
npm run db:migrate   # apply migrations + seed catalogue to DATABASE_URL (server also migrates on boot)
npm run map:extract  # PBF → tools/mapbuild/data/raw/chennai-extract.json (needs pyosmium + the PBF; see M5 notes)
npm run map:build    # extract → packages/shared/src/map/chennai.map.json (graph, verified starts, calibrated courses)
npm run loadtest -- --url http://localhost:2567 --bots 30 --seconds 60 --host-key <key> --start
npm run assets:fetch # download licensed 3D/texture sources (sha256-pinned, tools/assets/sources.lock.json)
npm run assets:build # optimise → apps/web/public/assets + regenerate docs/ASSETS.md
# /test-drive?auto=1&bench=60  offline visual checkpoint + on-device benchmark (never touches the event)
# /slice?accept=15[&auto=1][&q=low|medium|high]  vertical slice + on-device PERFORMANCE GATE (docs/ACCEPTANCE.md)
# cd tools/loadtest && npx tsx src/rehearsal.ts --url <server> --host-key <key> --minutes 62   # real-time 60-min rehearsal, 120 clients
```

## Environment variables
See `.env.example`. Server: `DATABASE_URL`, `SESSION_SECRET`, `HOST_ADMIN_KEY`, `PORT`, `PUBLIC_WEB_ORIGIN`, `EVENT_SEED`. Web: `VITE_SERVER_URL`, `VITE_WS_URL`.

## Current status
M1–M8 automated acceptance tests pass locally. Visual rebuild done (docs/VISUALS.md); realistic-engine vertical slice `/slice` built and measured (docs/PERF_AUDIT.md) — the on-device 30 FPS gate (docs/ACCEPTANCE.md) is NOT yet run (no device in the build env). Do not expand the full Chennai environment until that gate passes. Open, manual and owner-dependent: phone FPS check (M2), full 60-minute rehearsal on real phones/venue Wi-Fi (M8), first deploy, CI run, approved branding. See docs/PROGRESS.md and docs/RUNBOOK.md.

## Code map (M1)
- `packages/shared/src` — enums, timeline (`phaseAt`, `beatsBetween`), `balance.ts`, scoring caps + tie-break, join codes, seeded RNG, protocol types.
- `packages/db/src/schema.ts` — all DESIGN §6 tables; migrations in `packages/db/migrations` (0001 is hand-written: deferrable role uniqueness for atomic swaps).
- `apps/server/src/world/WorldRoom.ts` — THE single world (one per event, enforced), owns `EventClock`, Director tick, connections, broadcasts.
- `apps/server/src/services/registration.ts` — squads/join/roles/rejoin/sessions. `apps/server/src/app.ts` — Fastify routes + WS gateway.
- `apps/web/src/pages` — Home (create/join), Lobby, Host.

## Code map (M2)
- `packages/shared/src/sim/vehicle.ts` — deterministic vehicle model (server + client prediction run the SAME code). Frame: x east, z north, heading 0 = north, clockwise.
- `packages/shared/src/sim/road.ts` — road network format, synthetic test grid (replaced by OSM graph in M5), keep-LEFT lanes, signals (pure fn of sim time + seed), procedural buildings, static collision, spawn grid.
- `packages/shared/src/sim/traffic.ts` — IDM car-following traffic, signals, junction connectors, lane changes, yields to squad cars.
- `apps/server/src/world/WorldSim.ts` — the one world sim (cars + traffic + weather), fixed 50 ms step, input queue with replay guard.
- `apps/server/src/world/WorldRoom.ts` — 20 Hz loop, spawn at START, release at 03:00, interest-filtered snapshots, `/api/host/world`.
- `apps/web/src/game/` — Babylon scene, prediction/reconciliation + interpolation, input (keyboard + touch), RacerView HUD. Lazy-loaded chunk.
- Test/dev knobs (env): `COUNTDOWN_MS`, `RELEASE_AT_MS`, `TRAFFIC_AGENTS`.

## Code map (M3)
- `packages/shared/src/net/prediction.ts` — `Predictor` (prediction, reconciliation, redundant inputs) and `Interpolator`; used by the browser AND the bots.
- Server input rules (`WorldSim.step`): every input applied exactly once in seq order; hold ≤ 3 ticks for jitter, then extrapolate, > 1 s AI-brake; catch-up ≤ 2 inputs/tick; input budget (+1/tick, cap 10) blocks speed hacks.
- Anti-ramming: `RAMMING` in WorldSim (≥ 3 dominant hits ≥ 5 m/s on the same squad in 10 s → 5 s ghost-out, penalty + audit `driving.ghost_out`, victim free reset). Stuck: reset offered at 3 s, auto at 6 s.
- Interest (`WorldRoom.broadcastWorld`): near ≤ 300 m every tick, mid ≤ 1200 m every 4th, far only on the `map` channel (players 1 Hz, host 5 Hz); 10% hysteresis. Car tuples use compact `cid`; names come from the map channel.
- `tools/loadtest` — `Bot` (real protocol) + CLI: `npm run loadtest -- --url http://localhost:2567 --bots 30 --seconds 60 --host-key <key> --start` (raise `JOIN_RATE_LIMIT` on the server first).

## Code map (M4)
- `packages/shared/src/squad.ts` — public schedule (`CHALLENGE_SCHEDULE`), rubric (`SQUAD_RUBRIC`, documented in `docs/SCORING.md`), buffs (`applyBuffs`, used by server AND client prediction), power-ups, waypoints, `SquadView` types.
- `apps/server/src/squad/content.ts` — SERVER-ONLY original question/puzzle generators (seeded per squad). Never import from web.
- `apps/server/src/squad/SquadService.ts` — challenges, bluffing, Captain actions, idempotent submissions, `scoring_events`, effects on the real car via `WorldSim.addBuff/refillNitro/patch`. `viewFor(team, role, player)` is the ONLY path challenge data takes to a client.
- HTTP: `/api/squad/*` (Bearer session; role checks in the service). WS: `{t:'squad', view}` pushed per connection.
- `ALLOW_TIME_WARP=true` enables `POST /api/host/warp` (rehearsal/tests only; audit-logged). Never on event day.
- `apps/web/src/pages/RoleConsole.tsx` — Engineer/Deceiver/Captain consoles; Racer gets clue + waypoint arrow in `RacerView`.

## Code map (M5)
- `tools/mapbuild/extract.py` — pyosmium: OSM PBF (download.openstreetmap.fr `tamil_nadu`; Overpass/Geofabrik were unreachable from the cloud env) → roads motorway–tertiary + signals + named reference features in the Chennai bbox. Raw data is gitignored.
- `tools/mapbuild/src/build.ts` — graph (split at junctions, DP-simplify 3 m, largest SCC respecting one-ways), signals from OSM, start verification against exact OSM elements (ids in `START_OSM`, destination `n6572344272` "Hexaware Technologies"), uniform scale calibration, courses (landmark vias + one named junction refinement) to the 30-min reference target, 10 equal-time checkpoints, 6-slot staggered spawn grids.
- `packages/shared/src/map/` — `WorldMap` types/decoder, `testMap()`, and `@redline/shared/map/chennai` (separate entry; ~0.9 MB ODbL-derived JSON; lazy chunk on the web).
- `packages/shared/src/sim/road.ts` — per-edge width/lanes/one-way, node stop-line radius + signal axis, spatial index (`nearestEdge`, `edgesNear`), oriented-box building collision, `ProceduralBuildings` (per 200 m cell, same on server and client). `sim/reference.ts` — reference driver used for calibration and tests.
- Server: `MAP` env (`chennai` default, `test` for unit tests — test helper defaults to test), start-location selection (`/api/start-locations`, `/api/team/start-location`, capacity 6, auto-assign at START), DB sync of `start_locations` (+ `verified_at`) and `world_metadata`, checkpoint detection → `vehicle_checkpoints`.
- Web: cell-streamed scene (400 m cells), cached full-map minimap with course + checkpoints, checkpoint guidance HUD, StartPicker, `/credits`, OSM attribution in racer HUD and host map.

## Code map (M6)
- Stations: `WorldMap.stations` (mapbuild places them at real OSM `amenity=fuel` locations near each course's two service-window bands; generic names; one disclosed "game facility" where OSM has none). `stationExclusions()` keeps procedural buildings off pads.
- `apps/server/src/pit/PitService.ts` — FIFO queue per station, 4 bays, 60 s max dwell (auto refuel + release), 6 steps (enter detected by sim; Captain plan/confirm, Engineer diagnose, Deceiver verify via `/api/squad/pit/*`), credits, `pit_stops`/`fuel_transactions`, window scoring. Server-only content in `pit/content.ts`.
- `WorldSim`: `hold/release` (pit + roadside recovery; inputs still acked, `NetCar.hd` tells prediction), station zones non-collidable, fuel 0 → 8 s recovery (+15%, 50 credits).
- `apps/server/src/director/` — `Director` applies each beat from `createRng(seed, "beat:<id>")` over bounded options (`packages/shared/src/director.ts`), audit-logs the decision, expires timed effects; `closures.ts` only accepts a closure if every course keeps a route from every node. World state goes to ALL clients as one `{t:'world', state}` (monotonic `rev`).
- Perf benchmarks live in `*.perf.test.ts` and run isolated (`npm run test:perf`).

## Code map (M7)
- Driving points: `WorldRoom.flushCheckpoints` → 15 reach + 10 clean per checkpoint; `CheckpointPass.escorted` passes score 0.
- `WorldSim.startAuto` — server-driven movement along a real-road path (`escort` / `convoy`); `NetCar.au` + `hd` tell clients; non-collidable.
- `apps/server/src/gate/` — `GateService` (50:00–55:00 tasks, escort request + auto at 51:30, parking, arrivals, assisted entry + convoy at 55:00, reveal at 58:00), `content.ts` (server-only debug/badge tasks), `championship.ts` (standings from `scoring_events` rows + tie-breaks), `letters.ts` (pdf-lib; `OFFER_LETTER_DISCLAIMER`).
- `packages/shared/src/map/gate.ts` — `gateLayout()` (lot with 30 bays, convoy path on the real final approach), shared by server and client.
- Routes: `/api/squad/gate/{escort,debug,auth,code}`, `/api/standings`, `/api/offer-letter` (Bearer → PDF), `/api/host/offer-letters`. WS: `{t:'convoy', timeline}`, `{t:'championship', standings}` (one serialized payload to all).
- Web: `game/Finale.tsx` (every role + projector: real positions from the map channel, cinematic camera, fireworks/confetti, podium, letter download), `pages/Projector.tsx` (`/projector`), gate card in `RoleConsole`, gate HUD in `RacerView`.
- SECURITY: clients get a derived `worldSeed` (visuals/signals/traffic). `EVENT_SEED` (answers, Director, bluff order) never leaves the server — regression test in `m7.test.ts`.

## Code map (M8)
- Recovery: `WorldRoom.snapshotNow()` every 10 s + every phase change → `recovery_snapshots` (newest 50); `restoreFrom()` at boot (app.ts) → clock `restorePausedAt` (RECOVERING → PAUSED). Every service has `snapshot()/restore()`; SquadService regenerates content without DB writes and reloads scores from `scoring_events`. Traffic is re-seeded (not restored).
- Racer (re)bind resets the car's input stream (`WorldSim.resetInputStream`) — reconnects/reloads can drive immediately.
- Boot warm-up: `WorldSim.prewarm()` (corridor building cells, road index) + `WorldSim.warmJit()` on a throwaway sim.
- Tests: `restart.test.ts`, `storm.test.ts`, `security.test.ts` (main suite); `load.perf.test.ts`, `fairness.perf.test.ts`, `tick.perf.test.ts` (isolated perf suite). Load CLI: `--roles` adds 3 role clients per squad + host/projector observers.
- Ops: `docs/RUNBOOK.md`, `apps/server/Dockerfile`, `apps/server/fly.toml.example` (not built in this environment).

## Code map (Visual rebuild)
- `tools/assets/src/{sources,fetch,build}.ts` — licensed sources (licence, authors, modifications), sha256-pinned fetch, gltf-transform/meshoptimizer/sharp optimisation (car hero/LOD1/LOD2/LOD3, Khronos logos removed, WebP textures, HDR→sky). Output committed in `apps/web/public/assets`; inventory `docs/ASSETS.md`. NEVER add an asset without reading its licence; trademarks must be removed.
- `apps/web/src/game/render/` — `vehicles.ts` (GLB car templates, HeroCar, instanced CarFleet), `world.ts` (per-cell roads/markings/kerbs/footpaths/medians/zebras, street furniture, textured buildings, signals; everything clipped against other carriageways), `materials.ts` (PBR + sky/IBL), `traffic.ts`, `fx.ts`, `geo.ts`, `autoQuality.ts`.
- `apps/web/src/game/scene.ts` — orchestrator, same public API as before (RacerView/Finale unchanged in contract); presets, shadows following the car, streaming, camera.
- `apps/web/src/game/hud/` — racing HUD components + `hud.css` (shared by RacerView and TestDrive). Keep existing `data-testid`s (e2e depends on them).
- `apps/web/src/game/TestDrive.tsx` — `/test-drive` offline OMR checkpoint (shared physics + traffic AI), autopilot, `?bench=`.
- Engineer console: `CodingStepper` in `pages/RoleConsole.tsx`; Lobby gives it the screen during coding rounds.
- Status/limits/measurements: `docs/VISUALS.md`.

## Code map (Realistic engine — vertical slice)
- `apps/web/src/game/perf/probe.ts` — PerfProbe: frame-interval distribution (median, 1% low, p95, max, stalls), JS/RT/active-mesh time, draw calls, tris, unique GPU texture memory (compressed-aware), effects, long tasks, heap, download, FPS timeline. Used by `/test-drive?bench=` and `/slice?accept=`.
- `apps/web/src/game/slice/` — `corridor.ts` (≈805 m of OMR from the OSM graph, edge ids pinned), `build.ts` (bounded static world merged per material in 400 m chunks; modular buildings on the SHARED collision lots), `bake.ts` (sun/sky/AO/soft shadows into vertex colours; unlit static materials = emissive white × texture × vertex colour), `SliceScene.ts` (no shadow map, no post, cars only lit, KTX2, warm-up, dynamic resolution), `SliceDrive.tsx` (shared physics + shared traffic AI (`mix: { car, bus }`; server default mix unchanged), autopilot, acceptance gate UI/JSON).
- Ablation switches for audits: `GameScene(..., ablate)` / `/test-drive?ablate=noShadows,noPost,...` (measurement only).
- KTX2: `tools/assets` writes `.ktx2` next to every world texture; transcoder self-hosted in `public/assets/ktx2` (Apache-2.0); `render/assets.ts` `tiledCompressed()` with real WebP fallback.
- Vegetation: `tools/assets/src/vegetation.ts` (licensed CC0 trees/palms/shrubs/hedge/grass + vehicles e.g. bus → GLB LODs, KTX2-in-GLB) and `slice/vegetation.ts` (thin-instanced templates, baked foliage light, impostor LOD2, grid LOD updates). `G.wall` normal = front-face normal (left of a→b) — keep it that way or walls bake dark.
- Docs: `docs/ENVIRONMENT.md` (vegetation inventory, verdict), `docs/PERF_AUDIT.md` (measured), `docs/ACCEPTANCE.md` (device protocol + gate), `docs/ASSET_ACQUISITION.md` (manifest + missing-asset checklist), `docs/reference/omr/` (licensed reference photos, not shipped).
