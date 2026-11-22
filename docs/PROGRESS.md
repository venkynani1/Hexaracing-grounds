# Progress log

Update this at the end of every session: what runs, what's tested, what's next, open risks.

## 2026-11-22 — First on-device gate run (Realme RMX5110, Mali-G615, 4 GB, Chrome 156)

- `/benchmark` scene B (road + vegetation), medium, 3 min autopilot: median 60.2 FPS, 1% low 30.7, p95 21.8 ms,
  thermal 100 %, res drift ×1.00 — all PASS. FAIL on stalls: 3 gaps > 250 ms, max 5963.5 ms. Long tasks max only
  204 ms (total 430 ms), so the 6 s gap was not main-thread work; most likely the page was hidden/paused by the OS
  (screen-off, notification, app switch). The probe could not tell — it had no visibility tracking.
- Probe now records every gap > 250 ms (`stalls[]`: time, length, long-task overlap, page hidden) and counts OS
  interruptions separately (`interruptions`, `interruptedMs`, excluded from FPS stats). Gate: "Stalls (page visible)"
  must be 0 AND new row "Uninterrupted run" must be clean — an interrupted run can never PASS; it asks for a re-run.
  Verified in Chromium: a hidden 1.5 s pause → interruption; a visible 0.7 s block → stall.
- Run 2, same phone, new probe — scene C (full: traffic, scenery, vegetation, fx), HIGH quality, 3 min autopilot:
  median 60.2 FPS, 1% low 29.0, p95 21.2 ms, p99 34.5 ms, max frame (visible) 140 ms, **0 stalls with the page
  visible**, thermal 100 %, res drift ×1.00, 153 draw calls, 167 k tris, 32 MB textures, heap 133 MB, ready 8.8 s.
  Gate FAIL only on "Uninterrupted run": 1 OS pause of 10.6 s at 13 s (page hidden, no long task) — confirms run 1's
  6 s "stall" was the same kind of event. Verdict: performance criteria met on this device; one clean uninterrupted
  run is still required for a formal PASS. Rain and a lower-end phone not yet measured.

## 2026-11-22 — Master spec, stage 3: projector sequence + 120-player rerun with Levels 3–4

- Server public ticker (`WorldRoom.ticker`, `{t:'ticker'}` to host/projector clients only): level changes,
  duel round/winners, trades, jams/blocks, alliances. Backlog sent on host welcome.
- Championship standings carry `members` (display names). Projector: lobby (squads joined), countdown,
  live stage banner with level dots + ticker. Finale reveal steps every 4 s (final transmission → ranks > 10 →
  4–10 → 3rd → 2nd → champions with members → full board), replay button on the projector.
- `tools/loadtest/src/eventtest.ts` drives Levels 3–4 under load (safe-holds, shields, jams, alliances, duels from
  the Captain's own options, atomic trades, depot) and checks the DB ledger.
- Isolated 120-player run (30×4, 7.4 min wall, warped timeline, PGlite, no live server): every check PASS —
  0 unplanned disconnects, one world every sample, tick p99 worst 9.7 ms, loop delay p99 19.4 ms, RSS 630 MB,
  RTT p99 10 ms, racer snapshots p50 50 / p99 96 ms, reconnection storm p95 537 ms, restart recovery 2.0 s
  downtime with identical standings, leaderboard = independent SQL; L3: 30/30 safe-holds, 13 jams / 6 blocked /
  10 shields, 2 alliances; L4: 54 Captain answers, 14 duel rows, 15/15 trades, 30 ledger rows (exactly once).
  "Live event untouched" = NOT RUN by design (`--no-live-check`; live codespace unreachable).
- Tests: unit 118/118, e2e 9/9, typecheck clean.
- Deployed with owner approval: codespace server updated to 92e0885 (port 2567 public; health/db/CORS/WS verified);
  Vercel production redeployed from 92e0885 (dpl_FAaabhFMwzqvVWQy7PjL3V2h9GeU), home connects, no page errors.
- Still open: Chennai area recognisability/signage, release plan + readiness report, on-device FPS gate,
  real-phone rehearsal.

## 2026-11-22 — Master spec, stage 2: Deceiver ops, alliances, Racer safe-hold, weighted scoring

- `apps/server/src/rival/IntelService.ts`: signal jam (navigation display scrambled 20 s, car keeps driving),
  shield, alliances (both Captains); cooldowns, per-squad cap, target protection, ±3-rank target window, allies
  immune; snapshot/restore; audit. Routes `/api/squad/intel/*`. IntelCard (Deceiver + Captain) and jam scramble
  of the Racer minimap/guidance.
- Racer safe-hold (`/api/squad/safe-hold`): only during an open, unsolved four-key/navigation puzzle; ≤ 90 s,
  once per puzzle; auto-released on solve/close; uses the sim's held state (`reason: 'safe'`).
- Championship total weighted 40/25/15/10/10 (`SCORING_WEIGHTS`); raw category points + caps unchanged.
  Tie-break and totals tests rebuilt so they still exercise real ties under weighting.
- Tests: 118/118 + perf 4/4 + e2e 9/9; typecheck clean.
- Still open: projector stage sequence (map intro, rival/jam announcements, grouped reveal), Chennai area
  recognisability, 120-player isolated rerun covering Levels 3–4 actions, release plan + readiness report.

## 2026-11-22 — Master spec, stage 1: five levels + Level 4 rival system

- Audit: one-click Director, phases, global beats, role challenges, pit/fuel, gate, convoy, championship, recovery,
  projector and 120-player tests already existed. Missing: five named levels, rival duels/matchmaking, inter-squad
  trades, Deceiver disruption, alliances, Driver safe-hold during puzzles.
- Added: `packages/shared/src/levels.ts` (LEVELS over existing phase IDs, `stageAt`, RIVAL rules + view types);
  `apps/server/src/rival/` (RivalService: automatic matchmaking, Captain-only duels from a server-only 8-pattern bank,
  atomic Captain-approved trades, depot fallback, snapshot/restore, audit); routes `/api/squad/rival/*`;
  Captain RivalCard; level labels in racer HUD, lobby/host clock panel and projector.
- Tests: `rival.test.ts` (matchmaking, Captain-only, first-correct, idempotency, bounds, atomic trade + ledger, depot,
  window close, snapshot restore). Full suite 115/115, e2e 9/9, typecheck clean.
- Not done yet: Deceiver disruption + alliances, Driver safe-hold, scoring re-weighting to the 40/25/15/10/10 model,
  richer projector stage sequence, 120-player isolated rerun including Level 4.

## 2026-11-21 — Backend moved to GitHub Codespaces (zero cost); Fly.io left unchanged

- Server: codespace `psychic-space-chainsaw` (owner's account), public port 2567 →
  https://psychic-space-chainsaw-v6v79jxpwxg7hwgg9-2567.app.github.dev, Neon `DATABASE_URL` via Codespaces secrets.
- Vercel `VITE_SERVER_URL` / `VITE_WS_URL` point at it (deployment from 0eb67da).
- Verified: health db:true; site connects over wss, host login works; 122 read-only host-observer WebSockets for
  120 s, 0 disconnects; 31/31 health checks over 16 min, same world (no restart); HTTPS health round-trip 1.0–2.3 s
  from the build environment (incl. TLS setup; not a Chennai WebSocket latency).
- NOT yet tested: full event traffic through Codespaces port forwarding (30 bot squads + START ≈ 1.6 MB/s) — needs an
  isolated second server/event so the live event isn't touched; phone latency from Chennai; codespace idle stop.
- Fly.io app `code-redline-server` untouched (trial-stopped); delete only after the owner confirms.

## 2026-11-21 — Production backend on Neon PostgreSQL

- Fly `code-redline-server` now uses Neon (secret `DATABASE_URL`, pooled, TLS); `ALLOW_EMBEDDED_DB`/`PGLITE_DIR` removed.
  By the owner's choice the database is the Neon branch named `validation` (project little-wind-58361092, ap-southeast-1),
  which also holds one earlier validation event (2 bot squads, separate event — not part of the live event).
- Verified on Neon from Fly: db:verify 24 tables / 194 columns / 64 constraints / 48 indexes; 4-role squads + START;
  connection drop survived; restart restored the event (LIVE → PAUSED). Production event: clean, REGISTRATION_OPEN.
- Rollback: volume `redline_data` + snapshot `vs_gkq5yoo0MRRYT1BMnGPo3` (embedded test DB, 0 squads).
- Open: Vercel serves 402 "deployment temporarily paused" (account/billing); Fly trial 5-min stop unless a card is added.

## 2026-11-21 — Game server deployed on Fly.io (test mode, embedded DB)

- Server: `ALLOW_EMBEDDED_DB=true` opt-in lets a production build run on PGlite (`PGLITE_DIR` on a volume) for
  test deployments; without it production still refuses to start without `DATABASE_URL` (`config.test.ts`).
- `fly.toml` (repo root): app `code-redline-server`, region bom, 1 always-on machine, volume `redline_data`,
  origin `https://code-redline.vercel.app`. Image verified locally in production mode; 5-bot one-world smoke OK.
- DEPLOYED: https://code-redline-server.fly.dev (region sin, 1 machine, health check passing). Vercel env
  `VITE_SERVER_URL` / `VITE_WS_URL` point at it. WSS allowed from code-redline.vercel.app, 403 for other origins.
- Still owner-dependent: Neon `DATABASE_URL` + performance-2x before the event; real-phone multiplayer test.

## 2026-11-21 — Vercel deployment + Android benchmark route

### What runs
- https://code-redline.vercel.app (Vercel project `code-redline`, production, from branch `ccr-7f7a66bb-6yv4fm`).
- `/benchmark` — offline launcher: car+road / +vegetation / full dry / full rain × Low/Medium/High × auto 15-min,
  quick 3-min, manual 15-min, free drive; live FPS + frame time (avg/worst of 120 frames); PASS/FAIL report with
  Copy / Download JSON (includes the run config). Real slice renderer + real assets.
- Home shows a "live multiplayer server not connected" notice in production builds without `VITE_SERVER_URL`.

### Tested
- Local production build (vite preview) and the live Vercel URL, Android-emulated Chrome (Pixel 7 landscape,
  touch, SwiftShader): all 36 GLB/KTX2/HDR/wasm requests 200, no console errors, touch GAS drives, minimap
  draws, renders again after reload, `/test-drive` offline works, 3-min benchmark produced its report + JSON.
- e2e 9/9 (new benchmark launcher → run test), typecheck clean.

### Not done — needs the owner
- Game server (Fly.io/Railway/Render/VM) + Neon not deployed → live multiplayer NOT available on Vercel.
- Real Android phone runs of `/benchmark` (the 30 FPS gate).

## 2026-11-21 — Performance & realism blocker (slice)

### What runs
- `/slice` measurement switches: `?bench=A|B|C`, `?rain=0|1` (pins weather), `?off=veg,traffic,scenery,fx,wetrefl,env,hero`.
- PerfProbe now reports physics/traffic ms, GPU ms (timer query where exposed), active meshes, particles.
- Black foliage fixed at the root: vegetation glTFs load without sRGB buffers (double sRGB decode on unlit
  StandardMaterials), leaf atlases alpha-bled before KTX2, impostor atlas cleared to foliage colour.
- Evidence-based optimisations: tighter vegetation LODs, hero car 83.8k → 62.6k tris (Medium uses 20.7k LOD),
  rain particles 2.6k → 1k ahead of the camera; wet-road reflection no longer mutates the shared env texture.
- Box-like CC0 bus removed from slice traffic (`?bus=1` for comparison); detailed licensed bus requested.

### Tested
- Before/after ablation matrix (docs/PERF_AUDIT.md §5, raw rows in docs/perf/): full dry 4.5 → 6.7 FPS,
  rain 3.8 → 6.1 FPS on SwiftShader at High/scale 1. 15-min dry and rain runs: no crash, flat heap.
- typecheck, 110 unit + 4 perf + 8 e2e pass.

### Not done — needs the owner
- Device gate (A/B/C × dry/rain on the reference Android phone) — **FAIL here (software GPU), NOT RUN on a device**.
- Licensed detailed Indian bus (CGTrader/Sketchfab need an account), autos, motorcycles (docs/ASSET_ACQUISITION.md).

## 2026-11-20 — Milestone 8: Production testing (automated parts)

### What runs
- **Restart recovery**: whole-world snapshots (cars incl. buffs/arrivals/escort/convoy, challenges + attempts + idempotency, bluffs, credits, pit stops/queues, Director world state + beat log, gate tasks, convoy timeline, standings, clock) every 10 s and on every phase change; on boot the newest snapshot is restored and the event comes back **PAUSED** at the snapshot's elapsed time (downtime not counted); host resumes; phones rejoin.
- **Bug fixed**: a Racer whose page reloaded/reconnected could never drive again (the server remembered the old input sequence numbers and rejected the new predictor's as replays). Binding a Racer connection now starts a fresh input stream; replay protection still holds within a stream.
- **Boot warm-up**: course-corridor building cells pre-generated (512 cells, ~0.3 s) and the hot sim path JIT-warmed on a throwaway simulation (~0.2 s) — removes cold-start tick spikes.
- Squad-view pushes after checkpoint passes are now scoped to the affected squads (was all 120 players).
- **Ops**: `docs/RUNBOOK.md` (deploy to Vercel + long-running host + Neon, configuration, monitoring, incident playbook, rehearsal checklist, load-test procedure), server `Dockerfile`, `fly.toml.example`.

### Tested (all passing locally)
- `npm test`: 110 tests + isolated perf suite (4).
- **Load, fast-forward** (`load.perf.test.ts`): 30 racers driving toward their real checkpoints + 90 role clients + host + projector, whole 60-min timeline on Chennai with 400 traffic agents, concurrent submissions from all 30 squads at coding / four-key / bluff entries+votes / gate tasks, convoy, reveal, 120 letters. Tick p50 2.8 ms, **p99 5.85 ms** (worst 400-tick window 14 ms — GC from the 122 in-process bots), downstream avg **8.7 KB/s** (racers 16.6), **0 disconnects**.
- **Load, real time 15 min** (CLI; bots in a separate process on the same 4-vCPU box): 122 clients, 1 room, 20 Hz, tick **p99 6.75 ms** over 17,973 ticks, downstream avg **5.8 KB/s** (racers 10.8, host/projector 12.3), **0 disconnects**, 19.9 snaps/s, prediction correction p95 9 mm, no server errors.
- **Reconnection storm** (`storm.test.ts`): 120 connected, 40 dropped at once (10 whole squads), all rejoin the same player/slot in ~0.4 s.
- **Restart** (`restart.test.ts`): crash after 5 s past a snapshot; reboot on the same DB restores PAUSED at the snapshot (elapsed, sim tick and car positions exact; pre-crash diff ≤ one 10 s interval), scores, attempts (idempotent replay returns original result), bluff entry, waypoint, buffs; host resumes; Racer rejoins and drives.
- **Fairness** (`fairness.perf.test.ts`): 1000 seeds × 7 routes × 4 cars = 28,000 combinations; max score reachable in all 28,000; mean driving score spread across routes 0.00 % (reference driver) and **2.41 %** (typical player at 75 % pace); all four cars within ±2 % on every route. *Model, not a full game replay*: shared vehicle model reference times (dry + wet), one 60 s pit stop, each seed's real Route Lockdown closure (true graph detour, applied only if the squad reaches it inside 31–37 min), Traffic Shock road (bounded delay), Monsoon window.
- **Security** (`security.test.ts`): every `/api/host/*` route (discovered from source) rejects missing/wrong keys and player sessions; forged/tampered/cross-secret/expired sessions rejected on HTTP and WS; replayed and out-of-order input seq never enter the queue; non-racers can't drive; registration 429, squad-action 429, WS flood closes the socket (4008); no clue/answer leakage over full logs of two squads; gate tasks role-filtered.
- `npm run test:e2e`: 7 tests (unchanged scenarios, still passing).

### Not done — needs the owner
- **Full 60-minute rehearsal with real phones on venue Wi-Fi** (M8 manual item) and the **phone FPS check** (M2): needs devices, the venue and a deployed server — follow `docs/RUNBOOK.md` §6 and log results here.
- **First deployment**: Dockerfile / Fly config were not built or deployed from this environment (no container runtime); hosting choice and budget still open.
- **CI**: the GitHub Actions workflow has never been observed running (no GitHub API access from this session).
- **Approved Hexaware branding**: none supplied; letters and the gate use plain text only.

### Known limitations / open risks
- Load numbers are from one 4-vCPU container with bots co-located; real phones on venue Wi-Fi will differ (latency, loss, AP capacity).
- Traffic agents are re-seeded after a restart (positions not restored).
- Non-Latin names render as "?" in PDF letters; finale/vehicle visuals are simple; no audio; car selection (showroom) not built.

## 2026-11-20 — Milestone 7: Final experience

### What runs
- **Driving score** from checkpoints: 15 for reaching each of the 10 under own power + 10 if no ramming penalty since the last one; passes during the escort score 0. Totals now cover all seven categories (max 1,000).
- **Hexaware Gate (50:00–55:00)**, open to every squad wherever its car is: Racer precision parking in the squad's bay at the gate lot, Engineer debugging (which line has the bug), Deceiver authorization (forged badge by check digit), Captain combined access code (digits revealed as each teammate completes their part). Server-only seeded content.
- **Disclosed escort**: Racer/Captain request it from 50:00 (auto at 51:30): the car is driven along its own remaining course roads, labelled "ESCORT", time-compressed to ~60 s; skipped checkpoints score 0.
- **Welcome Convoy (55:00)**: assisted entry for squads not at the gate; all real squad cars placed into convoy slots on the real final approach (leaders first) and driven by the server after a 3 s formation hold. One serialized `convoy` timeline to every client. Every phone, the host and `/projector` show the same 3D convoy (real positions via the map channel at 5 Hz), cinematic camera, fireworks + confetti, a "WELCOME TO HEXAWARE" arch over the road and the four required lines.
- **Championship (58:00)**: standings computed from `scoring_events` rows in Postgres with the predeclared tie-breaks; broadcast to all; podium on every phone; `/api/standings` live leaderboard; projector page.
- **Offer letters**: one `offer_letters` row per player at the reveal; PDF on demand (pdf-lib) with participant, team, role, vehicle, achievement, final score, campus arrival status, and the exact stamp `COMMEMORATIVE GAME OFFER LETTER — NOT AN EMPLOYMENT OFFER` (top and bottom). No logos (no approved branding supplied).
- **Security fix (found while building the projector)**: clients had been sent the EVENT_SEED since M2, which seeds the answer variants and Director decisions. Clients now receive a one-way derived `worldSeed`; regression test added.

### Tested
- `npm test`: 103 tests + 2 isolated benchmarks. New `m7.test.ts`: two squads — one drives every checkpoint (250 driving points), one drives 3 then escorts (exactly 3 × 25 driving, 0 for the 7 escorted); gate open to both; role checks; parking/debug/auth/code all scored; window closes at 55:00; auto-escort at 51:30; 30 squads → 30 real cars in convoy slots on the path (≥ 9 m apart), identical timeline to racer/role client/host, cars move after the hold, no contacts; championship ordering across every tie-break case (incl. category caps and hash fallback) from DB rows and via `/api/standings`; 58:00 reveal → one letter per player, every PDF contains all fields and the exact disclaimer; event seed never reaches a client.
- `npm run test:e2e`: 7 tests. New M7: gate cards for all roles at 50:00, Racer requests escort (disclosure banner), at 55:00 all four phones show the finale, at 58:00 podium on all four and the Captain downloads a real PDF.

### Known limitations / open risks
- Offer-letter PDFs use a standard PDF font: non-Latin characters in names (e.g. Tamil script) are replaced with "?". Embedding a Unicode font (licensed) is a follow-up.
- Escort speed is strongly time-compressed for far-away squads (up to 600 m/s) — disclosed, but visually abrupt; tune the auto-escort time or target duration after a playtest.
- Finale visuals are simple (box cars, particle fireworks); no audio yet.
- Car choice is still fixed to Vortex GT (showroom not built; letters show the actual car).
- Gate/convoy/championship state lives in memory (DB has every score and letter); restart recovery is M8.

### Next (M8)
- 120-client load test (30 racers + 90 role clients + host + projector), reconnection storm, server restart from recovery snapshots, 1000-run fairness simulation, security pass, full 60-minute rehearsal on real phones.

## 2026-11-20 — Milestone 6: Fuel & suspense

### What runs
- **Shared service stations**: 8 stations on the course corridors — 7 at real OSM fuel-station locations (15–45 m from the mapped station), 1 clearly labelled game facility on the East Coast Road where OSM has none within 600 m. Generic names (no fuel brands). Forecourt, canopy and 4 bays rendered; shown on the minimap.
- **Pit stops (6 steps, four roles)**: Racer pulls in and stops (server-detected) → FIFO queue → bay (pit crew rolls the car in, disclosed) → Captain selects fuel/repair/tyres with garage credits → Engineer reads four sensor readings and names the out-of-spec system → Deceiver flags the false one of three mechanic reports about the real car → Captain confirms → service time → car released at the station exit. Max dwell 60 s: unconfirmed stops get an affordable refuel and are released. Cars in a station are non-collidable. Persisted in `pit_stops` / `fuel_transactions`; scored per service window (FUEL_MANAGEMENT 25/10, CAPTAIN_STRATEGY 25).
- **Fuel economy**: burn raised so the 75% start needs ~1 stop on a 30-min course (provisional).
- **Roadside recovery**: empty tank → 8 s disclosed stop, +15% fuel, 50 credits (free if broke). Never elimination.
- **Redline Director** effects (seeded per beat, bounded, audit-logged with the decision): First Contact (announcement), Traffic Shock (a named course road's traffic crawls 3 min), Fuel Crisis (fuel ×1.5 for 5 min), Classified Envelope (same seeded power-up for every Captain), Route Lockdown (6-min closure with physical barriers; only accepted if every course keeps a route), Monsoon Protocol (shared rain, grip −20%, 37:00–45:00), Final Recruitment Alert, Total Redline (nitro refill for all).
- **Global world channel**: `{t:'world', state}` with a monotonic revision to every player and host in the same broadcast; barriers feed server collision, client prediction and rendering; rain particles; Director banner; host Director panel with the beat log.

### Tested
- `npm test`: 97 tests + 2 isolated timing benchmarks. New `m6.test.ts`: full 6-step pit flow with four real role connections (role-filtered views, wrong-role 403s, Engineer solves by reading specs, Deceiver by comparing with the real car, credits charged, car serviced and released at the exit, FUEL 25 + CAPTAIN 25 scored, DB rows); 6 squads → 4 bays in arrival order + 2 queued FIFO, max-dwell release at 60 s, all served, no contacts in the station; fuel exhaustion → recovery → driving again; Director fast-forward 0→60:00 twice with the same seed (identical beat log; every beat once, in order; closure active then expired; rain 37–45) and a different seed (different decisions); closures valid for 300 seeds + a gate-cutting closure rejected; Monsoon Protocol reaches racer, role client and host with the same revision and payload.
- `npm run test:e2e`: 6 tests. New M6: warp to 37:00 → all four phones and the host show Monsoon Protocol / Rain.
- Benchmarks moved to `tick.perf.test.ts` (isolated: under parallel test load the Chennai p99 occasionally exceeded 10 ms, isolated it's ~5 ms).

### Known limitations / open risks
- Pit flow, fuel burn and prices are provisional; needs a playtest (does every squad realistically stop once?).
- The pit stop UI isn't covered by a browser test (server flow is); a car can't be driven into a station in headless e2e without a teleport hook.
- Rain visuals are fog/sky + particles; no wet-road reflections yet.
- Closure barriers are boxes; traffic avoids closed edges at junctions but agents already on a closed edge drive to the barrier and queue (disclosed: they're "stuck at the barricade").
- Director state lives in memory (rev-numbered); restart recovery is M8.

### Next (M7)
- Hexaware Gate assessment 50:00–55:00 (Racer precision parking, Engineer debugging, Deceiver authorization check, Captain combined access code), disclosed escort transition (0 driving points for skipped checkpoints), Welcome Convoy of all 30 real cars, driving score from checkpoints, championship with tie-breaks, offer-letter PDFs.

## 2026-11-20 — Milestone 5: Chennai geography

### What runs
- **OSM pipeline** (`tools/mapbuild`): Tamil Nadu PBF (download.openstreetmap.fr, snapshot 2026-11-17, md5-verified) → pyosmium extract (8,102 major-road ways, 441 signals, reference features) → TS builder → `packages/shared/src/map/chennai.map.json` (903 KB; 22,462 nodes, 25,220 edges). Licensed ODbL 1.0 with attribution (`CHENNAI_DATA_LICENSE.md`). Overpass and Geofabrik were refused from this cloud environment (remote side / egress), so the reproducible PBF route is used.
- **Destination**: OSM node `n6572344272` "Hexaware Technologies" (office=it, SIPCOT IT Park Siruseri); the gate is the nearest drivable public-road node (campus roads aren't in the graph) — disclosed in the map data.
- **Verified start locations** (all 7): Chennai Central (station node), Guindy, Velachery, Thiruvanmiyur (place=suburb), Tambaram (place=city), Kelambakkam, Mahabalipuram (place=town) — each matched to an exact OSM element, within 60 km, snapped to the road graph, routed to Hexaware, with a 6-slot staggered spawn grid. Stored in `start_locations` with lat/lon, world x/z, `enabled`, `verified_at`.
- **Scale**: uniform **0.849** chosen by calibration (DESIGN §3 updated — the old 1:8 guess gave a 3-minute drive).
- **Route normalisation**: target 30 min reference-car time. Longest natural route (Chennai Central) sets the scale; shorter routes are extended through disclosed landmarks / named junctions. Result: 29.4–30.8 min for all 7 courses. 10 checkpoints per course at equal fractions of reference time, detected in order on the server, persisted idempotently to `vehicle_checkpoints`.
- **Shared road model generalised**: per-edge lanes/width/one-way, junction stop lines, signal groups for skewed junctions, spatial index, oriented-box collisions, procedural roadside buildings per cell (identical on server and client), traffic on course corridors (400 agents, weighted toward major roads).
- **Client**: cell-streamed 3D Chennai (roads, junctions, lane markings, signals, buildings), full-map minimap with course + checkpoints, checkpoint guidance pill, Captain's start-location picker with capacity and disclosed course, OSM attribution in the racer HUD and host map, `/credits` page.

### Tested
- `npm test`: 93 tests. New `chennai.test.ts`: OSM-derived graph + attribution; every start reaches Hexaware and back (one-way rules); every course is a contiguous legal drive; starts verified (OSM ids, < 60 km, spawn on road, slots apart); DB `verified_at` + coordinates; disabled/full/post-START selections rejected; auto-assignment; cars spawn on their grid; **reference times re-simulated with the shared vehicle model all within ±10%** (29.4–30.8 min); equal-time checkpoints; in-order checkpoint detection + persistence; Chennai tick p99 **4.3 ms** with 30 cars + 400 traffic (budget 10 ms).
- `npm run test:e2e`: 5 tests (on the Chennai map). New M5: Captain picks Kelambakkam, all phones show the course; racer HUD shows checkpoint guidance and "© OpenStreetMap contributors (ODbL)"; `/credits` shows ODbL + 85% scale; host map shows attribution.

### Known limitations / open risks
- Reference time is an idealised driver (no traffic/signals). Real squads will be slower; the 30-min target assumes ~1.3–1.5× → ~40–45 min. Needs a playtest to tune `BALANCE.courseTargetS`.
- Some course vias are generic junction labels ("junction of East Coast Road"); fine for disclosure, could be nicer landmark names.
- Graph includes tertiary roads: 0.9 MB map + 1.1 MB Babylon chunk for racers (~1.4 MB gz). Fine vs the 15 MB budget but worth trimming.
- Bridges/flyovers are flat (OSM `bridge` tag is captured but not yet rendered as elevation).
- Ground is a flat plane; no water/coastline rendering yet.
- `vehicle_checkpoints` are recorded but not yet scored (Driving points come with M7).

### Next (M6)
- Shared service stations + 6-step pit flow with four roles, FIFO queues, fuel exhaustion recovery, Redline Director beats with seeded bounded road closures (always leaving a valid route), shared weather (Monsoon Protocol rain).

## 2026-11-19 — Milestone 4: Four-player squad mechanics

### What runs
- **Synchronised challenge schedule** driven by the Director clock (same windows for every squad): Coding 1 (03:00), Four-Key 1 (10:00), Bluff 1 (10:30), Navigation (24:00), Bluff 2 (25:00), Coding 2 (33:00), Four-Key 2 (42:00).
- **Engineer**: 4 original coding/debug questions per round (JS + Python output prediction, debugging MC), per-squad seeded variants. Correct → `CODING` scoring event and a 45 s **engine-tune buff on the real server car** (client prediction applies the same buff via shared `applyBuffs`).
- **Deceiver**: bluff rounds with verified true answers; write → vote → results; one entry per squad, no truth/duplicate entries, no own-squad vote, one vote per player (app + DB constraints); deterministic settlement; detection grants a nitro power-up.
- **Captain**: waypoint selection (arrow + distance on the Racer's HUD, marker on the minimap), power-ups (nitro refill, pit-crew patch, grip boost) applied to the real car, navigation intel challenge, combined four-key submission.
- **Racer**: own private four-key clue in the HUD, waypoint arrow, buff chips — while driving.
- **Privacy & integrity**: per-role views built server-side (the only path), clues AES-GCM-encrypted at rest, answer keys never sent, idempotency keys on submissions, per-player action rate limit, totals derived from `scoring_events`.
- `docs/SCORING.md` documents the rubric. New table `challenge_variants` (migration 0002).
- Rehearsal-only `ALLOW_TIME_WARP` host endpoint (off by default) used by the browser test to jump to 10:00.

### Tested
- `npm test`: 84 tests. New: `squad.test.ts` (Engineer scoring + idempotency + buff makes the squad car out-accelerate an unbuffed one on the server; four-key clue per role + encrypted storage + Captain-only submit; bluff rules and exact deterministic points; Captain waypoint, power-ups on the real car, inventory, navigation; clue privacy over the full WS logs of 12 players in 3 squads; warp disabled by default), `content.test.ts` (every coding template's answer verified by **executing** the JS/Python snippet across 40 seeds; four-key clues decode to the answer across 300 seeds; navigation answer is the nearest waypoint), shared rubric/buff tests.
- `npm run test:e2e`: 4 tests. New M4: four browser contexts — Engineer answers a coding question at 09:30; at 10:45 all four phones show different private clues (Racer in the HUD), the Deceiver writes a bluff while the Captain types the code decoded from the four phones' clues → "Correct! +75" on all consoles; Captain's waypoint appears on the Racer's HUD.

### Known limitations / open risks
- Challenge state lives in memory (DB has every submission/vote/score). Server restart mid-event regenerates identical variants from the seed but loses attempt counters — snapshot recovery is M8.
- Identical clue text can occur for two squads (small parameter ranges); harmless (answers still per squad) but noted.
- Content volume is small (8 coding templates, 2 four-key templates, 6 bluff prompts) — enough for one event; more variety before rehearsal.
- Voting is for Deceivers only; other roles see prompt/results. Revisit after a playtest if the Deceiver queue feels thin.
- `CAPTAIN_STRATEGY` remaining 50, `FUEL_MANAGEMENT`, `DRIVING`, `HEXAWARE_GATE` arrive in M5–M7.

### Next (M5)
- `tools/mapbuild`: OSM (ODbL) extract → road graph in the existing network format; verified start locations (with `verified_at`); connectivity test to Hexaware; route calibration ±10%; OSM attribution in-game and in credits. Needs network access to an OSM extract source.

## 2026-11-19 — Milestone 3: Actual multiplayer (5 → 10 → 20 → 30 in one world)

### What runs
- **Headless bots** (`tools/loadtest`): register through the public HTTP API, connect over the real WebSocket, run the same shared `Predictor` as the browser. CLI for real-time load runs with bandwidth/tick/correction report.
- **Exactly-once input processing** on the server: inputs applied once each in seq order, jitter hold (≤ 150 ms), catch-up ≤ 2/tick, extrapolation then AI brake on connection loss; input budget blocks speed hacks; clients send the last 3 inputs redundantly so a lost packet doesn't lose a step.
- **Interest management**: near (≤ 300 m, 20 Hz), mid (≤ 1200 m, 5 Hz), far (global map channel only, 1 Hz for players / 5 Hz for host), 10% hysteresis; compact numeric car ids. Every squad is always on the map channel.
- **Collisions & fairness**: symmetric equal-and-opposite impulses (recorded per contact), damage capped per hit, anti-ramming ghost-out with penalty + audit log and a free reset for the victim, stuck detection with offered (3 s) and automatic (6 s) safe reset to the nearest lane.
- **Client**: squad name labels above other cars, translucent ghosted cars + disclosure banner, safe-reset button, minimap (all squads from the map channel, near cars live), host dashboard live map of all squad cars (real server positions only).

### Tested
- `npm test`: 62 tests. New M3 suite (`apps/server/test/multiplayer.test.ts`):
  - N = 5, 10, 20, 30 bots in one room: same room id, same tick numbers, every near car present in every snapshot at server-truth positions (±0.5 m), cars actually moving.
  - Overtake: both clients see each other every tick and agree on the order every tick; order flips A → B.
  - Collisions: equal and opposite Δv, capped and equal damage; ramming → ghost-out, penalty, free reset, no contact while ghosted, expiry after 5 s; head-on mutual contact → no penalty; stuck → reset offered at 3 s, auto at 6 s, back on the road.
  - Latency: 150 ms one-way + 0–30 ms jitter, 2% loss both ways, 120 s, 100 traffic agents → correction p50 0.004 m, p95 0.010 m (max 19.7 m = one snap after an unpredicted traffic hit).
  - Interest tiers: near 40/40 ticks, mid 10/40, far 0 in snapshots but present in every map message (player and host); hysteresis at 320/340/310/290 m.
  - Static check: exactly one `WorldRoom.create` call site, one `new WorldSim`.
- `npm run test:e2e`: 3 tests; the M2 smoke now also checks the minimap and the host live map.
- **Real-time run** (localhost, 29 bots + a Playwright browser racer, 45 s): 1 room, 0 disconnects, downstream avg 31.5 KB/s (max 35.1) per racer with all cars bunched near the start, 19.4 snaps/s, server 20 Hz with tick p99 1.74 ms (30 cars + 100 traffic + snapshot building). Correction p95 0.013 m (localhost latency only).

### Known limitations / open risks
- Bandwidth is near the 40 KB/s budget when all 30 cars are bunched (start grid / convoy). JSON for now; binary/delta encoding (DESIGN §4) is the planned fix before M8.
- Traffic collisions aren't predicted on the client: a hit causes one visible snap (rare, seen as the max correction).
- Ghost-out penalty is recorded (`penalties`, audit log) but not yet converted into a scoring event — that happens with scoring in M7 (clean-driving component of Driving).
- Real-network test (phones on Wi-Fi) is still M8.

### Next (M4)
- Engineer coding/debug challenges with buffs applied to the real car, Deceiver bluffing rounds (one entry per team, no self-vote, one vote per player), Captain navigation/power-ups/four-key combined submission, private clue isolation test, four-context Playwright test.

## 2026-11-19 — Milestone 2: Shared 3D world (single car)

### What runs
- **Shared simulation** (`packages/shared/src/sim`): deterministic arcade vehicle model (throttle/brake/reverse, grip-limited steering, slip + handbrake drift, nitro, fuel burn, tyre wear, bounded damage, limp mode on empty tank, rain grip ×0.8, off-road grip ×0.6); four cars with one shared top speed. Test road network (4×4 grid, 2 lanes each way, keep-left), deterministic signals, procedural original buildings, static collisions.
- **Traffic** (server-only, one shared state): 100 agents (cars, motorcycles, buses, trucks) following lane centrelines, IDM car-following, stopping at red/amber, junction connectors with seeded turn choices, lane changes, yielding to squad cars.
- **Server world**: `WorldSim` inside the single `WorldRoom`, fixed 20 Hz step (only while LIVE), squad cars spawned at START on a spawn grid, released at 03:00 (City Sprint). Racer inputs (seq, replay-guarded, queue cap 4, ≤ 60 msg/s), stale-input AI brake, car–car and car–traffic collisions (symmetric, damage capped). Snapshots: racer 20 Hz (own car + squad cars ≤ 1200 m + traffic ≤ 300 m), role clients 5 Hz squad-car telemetry, host 2 Hz all cars; `GET /api/host/world`; tick p99/Hz in host health.
- **Client** (Babylon.js 8, lazy-loaded): roads, kerbs, lane markings and stop lines (thin instances), buildings (thin instances), live traffic signals, traffic instances, PBR clear-coat own car with brake/headlights, other squad cars interpolated 100 ms behind. Own-car prediction + reconciliation with smoothed corrections. Chase/hood/top cameras, quality presets (visual only), dynamic resolution, FPS counter. Touch pads (◀ ▶ GAS BRAKE NOS DRIFT) + keyboard. Non-racer roles see live squad-car telemetry in the lobby.

### Tested
- `npm test`: 50 tests. New: vehicle model (determinism, accel/top speed, braking/reverse, steering sign, rain grip, fuel/limp, nitro/tyres, bounded damage, equal top speed), geometry (keep-left lanes, buildings block cars, signal axes never both green), traffic (lane following through junctions, red-light stop then go, stop for blocked lanes, lane-change overtake, seed reproducibility), world sim (tick p99 benchmark ≈ 0.6 ms, replay rejection, release gate + AI brake, symmetric car collision), room integration over real WS (racer input moves the server car, ack in snapshots, captain cannot drive, telemetry, host world endpoint auth).
- `npm run test:e2e`: 3 tests. New M2 smoke on Pixel 7 emulation: the racer's phone switches to the 3D view after START, the canvas renders, FPS > 0, and holding the GAS pad moves the car **on the server** (checked through `/api/host/world`).

### Known limitations / open risks
- **Phone FPS not measured.** Only headless software rendering here (~20 FPS). Needs a real mid-range Android check on Medium.
- **Art is placeholder**: box cars, box buildings, no textures, no shadows, no rain particles, no audio yet. Visual fidelity (PBR env lighting, LODs, KTX2, particles, sound) is still to do; it's tracked against SPEC Part 1 and not claimed.
- 3D chunk is 1.1 MB gzipped (Babylon root import). Switch to deep imports to cut it.
- Predicted own car ignores traffic collisions (the server corrects). The input queue can drift if client and server tick rates diverge; M3 measures correction error under latency/loss.
- Vehicle choice isn't wired yet (everyone drives Vortex GT); the showroom and Captain's car selection still need a milestone slot.
- Squad cars spawn on one shared test grid; per-location start grids arrive with Chennai geography (M5).

### Next (M3)
- 5 → 10 → 20 → 30 headless racer bots in one room; per-N tests of shared positions (±0.5 m); overtakes; collision symmetry + anti-ramming ghost-out; latency/loss prediction error test; interest tiers with hysteresis; static singleton check.

## 2026-11-19 — Milestone 1: Foundation

### What runs
- **Monorepo** (npm workspaces): `packages/shared`, `packages/db`, `apps/server`, `apps/web`. `npm run dev` boots server + web.
- **DB**: Drizzle schema for all 23 tables in DESIGN §6, migrations `0000_init` + `0001_deferrable_role_unique`. Server migrates and seeds the vehicle catalogue + 7 candidate start locations on boot. Start locations are seeded **disabled with no coordinates** until verified in M5.
- **Server** (Fastify + `ws`): create squad (creator = Captain, slot 4), preview/join by 6-char code, Captain role reassignment before START, rejoin credential → new session on the same slot, HMAC-signed sessions with hashes stored in `sessions` (revocable), host endpoints behind `x-host-key`, per-IP rate limit on registration endpoints, audit log for every registration/host/beat action.
- **One world**: `WorldRoom.create` refuses a second room for the same event. All players and host attach to it over `/ws` (hello → welcome; live roster + clock + host overview pushes; origin check; per-connection message limit).
- **Event clock + Director**: START → REGISTRATION_LOCKED → COUNTDOWN (10 s) → LIVE → phases per timeline → FINISHED; pause/resume exact; every transition persisted to `event_states`; the 8 Director beats fire exactly once and are audit-logged (no world effects yet — M6).
- **Web**: mobile-first Create/Join (with role picker showing free roles), Lobby (live roster with presence, squad QR, Captain role editor, official clock), Host control center (registration QR, squads table, readiness/blockers, START / force start / pause / resume, health stats).

### Tested (all passing locally)
- `npm test`: 28 tests — timeline table, beats-once, join-code alphabet, RNG reproducibility, scoring caps/tie-breaks, migrations on PGlite, squad create/join/full/duplicate/unknown, 30×4 = 120 registrations + 31st rejected, concurrent creation never exceeds capacity, role swap rules incl. after START, rejoin + tampered tokens, host auth, 429 rate limit, clock transitions persisted + pause exactness (fake timers), single WorldRoom, real-WS roster updates and host overview.
- `npm run test:e2e`: Playwright (Pixel 7 emulation) — captain creates, 3 contexts join via `/join/CODE`, all four see full roster with presence, host sees squad and START enabled, START reaches every lobby; registration closed afterwards.
- Not yet verified: GitHub Actions run of `.github/workflows/ci.yml`; migrations against a real Neon database.

### Known limitations / open risks
- Server restart mid-event: event reloads **paused** from the `events` row, but downtime counts as elapsed (no snapshot recovery yet — M8).
- Rejoin token is long-lived and not rotated; anyone holding it can take the slot (acceptable for a 1-hour event; revisit in M8 security pass).
- Rate limiting is in-memory per process (fine: single authoritative process). Venue NAT may put many phones behind one IP — limit is 60/min/IP, tune before the event.
- Server runs TS via `tsx` in production too (no build step); fine for now, consider bundling for the deploy.

### Next (M2)
- Shared deterministic vehicle model in `packages/shared` + unit tests; 20 Hz fixed world tick inside `WorldRoom`; test road network; Babylon.js racer view with chase camera and touch controls; basic traffic agents.

### Open questions for the owner
- Hosting for the persistent game server (Fly.io / Railway / Render / VM) and budget for event day.
- Approved Hexaware branding assets for the offer letters and gate.
- Licensed live-traffic API, or use scripted density only.
- Exact event date and venue Wi-Fi capacity.

## Session: visual rebuild (critical directive)
- Built: licensed-asset pipeline (`tools/assets`, docs/ASSETS.md), GLB car (hero + 3 LODs, logos removed), PBR roads/markings/kerbs/footpaths/medians/zebras, textured buildings, LED street lights, palms, signals, fuel stations, coloured traffic models, HDR IBL + following sun shadows + ACES + haze, rain/wet roads, tyre smoke, nitro, new chase camera, redesigned racer HUD, one-question Engineer console, GPU-based default preset, `/test-drive` offline checkpoint with on-device benchmark.
- Tested: 110 unit/integration + 4 perf + 7 e2e pass; typecheck; build.
- Measured (SwiftShader software GPU only): low 30 FPS / 87 draws / 45k tris; medium 11 FPS / 209 / 268k; high 10 FPS / 250 / 284k. See docs/VISUALS.md.
- NOT done: real mid-range Android measurement (no device here — run `/test-drive?bench=60` on the phone), auto-rickshaws (needs a shared-sim traffic type), real landmark buildings, night lighting, puddles/splashes. Full list in docs/VISUALS.md.

## Session: realistic visual engine (audit → vertical slice → gates)
- Phase 1 audit (measured, SwiftShader + CPU×4 proxy + ablations): pixel shading, the 105k-tri hero car, the
  shadow map and JS/draw-call cost were the measured causes; physics is negligible. docs/PERF_AUDIT.md.
- Phase 2/4: baked lighting + unlit merged static world, no shadow map/post, hero 83.8k / low uses 20.7k LOD,
  traffic LOD1 < 28 m, KTX2 (ETC2 on Android) with self-hosted transcoder, shader warm-up, chunked bounded slice.
  Same harness, high preset: median FPS 3.9 → 9.9, JS/frame 9.1 → 4.0 ms (CPU×4: 37.6 → 14.8 ms),
  draws 297 → 192, texture memory 93.6 → 17.9 MB, first ready frame 11.5 → 1.4 s.
- Phase 3: `/slice` — ≈805 m of real OMR (Taramani junction, petrol station location, gantry, median, kerbs,
  footpaths, rain trees, bus shelter, signals, 6 licensed traffic cars), playable, shared physics + traffic AI.
- Phase 5: on-device gate implemented (`/slice?accept=15`), **not run — no Android device in this environment.**
- Phase 6: see results in docs/ACCEPTANCE.md (real-time 60-min rehearsal, 120 participants + 2 observers).
- Not done: device gate; buses/trucks/autos/bikes as licensed models (acquisition checklist); applying the slice
  architecture to the full Chennai world (blocked on the device gate by directive).

## Session: environment rebuild (vegetation)
- Primitive trees/palms/shrubs replaced by licensed CC0 models (3TD Tropical pack, Nobiax palms/bushes/hedges/
  grass), converted with `tools/assets/src/vegetation.ts` (assimp → GLB, LOD0/LOD1, KTX2-in-GLB) + runtime
  impostor LOD2, thin-instanced, baked foliage light. Leafy-grass turf verges; walled + planted frontages.
- 60-min real-time rehearsal (120 participants + 2 observers): 0 unplanned disconnects, one world in every
  sample, tick p99 ≤ 5.0 ms (≤ 6.8 ms in any 400-tick window), RTT p95 ≤ 22 ms, all phases through FINISHED,
  40-client reconnection storm recovered in 425 ms, 30 squads in the final standings.
- Tests: 110 + 4 perf + 8 e2e (incl. new `/slice` smoke) pass.
- Verdict: FAIL / NOT YET ACCEPTED — see docs/ENVIRONMENT.md (device gate not run; vegetation doubles GPU
  cost in the software-GPU proxy; remaining visual defects listed).
