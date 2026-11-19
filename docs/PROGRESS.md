# Progress log

Update this at the end of every session: what runs, what's tested, what's next, open risks.

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
