# Progress log

Update this at the end of every session: what runs, what's tested, what's next, open risks.

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
