# Progress log

Update this at the end of every session: what runs, what's tested, what's next, open risks.

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
