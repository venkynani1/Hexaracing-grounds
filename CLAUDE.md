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
docs/             SPEC, DESIGN, MILESTONES, PROGRESS, RUNBOOK
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
npm test             # vitest: shared, db (PGlite), server (HTTP inject + real WS)
npm run test:e2e     # Playwright (boots its own server :2599 + vite :5199)
npm run typecheck    # tsc for every workspace
npm run build        # vite build of apps/web
npm run db:generate -- --name <change>   # drizzle-kit generate (packages/db/migrations)
npm run db:migrate   # apply migrations + seed catalogue to DATABASE_URL (server also migrates on boot)
npm run map:extract  # PBF → tools/mapbuild/data/raw/chennai-extract.json (needs pyosmium + the PBF; see M5 notes)
npm run map:build    # extract → packages/shared/src/map/chennai.map.json (graph, verified starts, calibrated courses)
npm run loadtest -- --url http://localhost:2567 --bots 30 --seconds 60 --host-key <key> --start
```

## Environment variables
See `.env.example`. Server: `DATABASE_URL`, `SESSION_SECRET`, `HOST_ADMIN_KEY`, `PORT`, `PUBLIC_WEB_ORIGIN`, `EVENT_SEED`. Web: `VITE_SERVER_URL`, `VITE_WS_URL`.

## Current status
M1–M5 implemented and tested locally (M2's manual phone-FPS check still open) — see docs/PROGRESS.md. Next: M6 (fuel & pit stops, Redline Director world events, weather).

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
