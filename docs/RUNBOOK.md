# CODE REDLINE — Runbook (deploy, monitor, recover, rehearse)

> One world = one server process. Never run two instances of the game server for the same event, never put it
> behind a serverless function, never auto-scale it horizontally.

## 1. Architecture on event day
| Piece | Where | Notes |
|---|---|---|
| Web client (`apps/web`) | **Vercel** (static build) | Public env only: `VITE_SERVER_URL`, `VITE_WS_URL`. `apps/web/vercel.json` rewrites SPA routes. |
| Game server (`apps/server`) | **Long-running host**: Fly.io / Railway / Render / a VM | One always-on instance with **dedicated CPU** (≥ 2 vCPU). `apps/server/Dockerfile`, `apps/server/fly.toml.example`. |
| Database | **Neon PostgreSQL** (pooled URL) | Server is the only DB client. Warm the compute before the event (free tier auto-suspends). |
| Map data | Bundled (`packages/shared/src/map/chennai.map.json`, ODbL) | Re-generate with `npm run map:extract && npm run map:places && npm run map:build` (needs the OSM PBF). Area names/signs: `packages/shared/src/map/chennai.places.json` (ignored if its `mapVersion` ≠ the graph's). |

## 2. Configuration
Server secrets (platform secret store — never commit, never in the image):
`DATABASE_URL` (Neon **pooler** URL, `sslmode=require`), `SESSION_SECRET` (≥ 32 random chars), `HOST_ADMIN_KEY` (≥ 12 chars),
`EVENT_SEED` (keep private: it seeds answers and Director decisions).
Server settings: `PORT`, `PUBLIC_WEB_ORIGIN` (the Vercel URL; comma-separate if several), `TRUST_PROXY=true` behind a proxy,
`EVENT_NAME`, `MAP=chennai`, `JOIN_RATE_LIMIT` (venue NAT puts many phones behind one IP — raise to ~300).
**Never set on event day:** `ALLOW_TIME_WARP`, `COUNTDOWN_MS`, `RELEASE_AT_MS`, `TRAFFIC_AGENTS` (test knobs).

## 3. Deploy
1. Database: create a Neon project/branch; `DATABASE_URL=… npm run db:migrate` (the server also migrates on boot).
2. Server (Fly example): `cp apps/server/fly.toml.example fly.toml`, `fly launch --no-deploy`, `fly secrets set DATABASE_URL=… SESSION_SECRET=… HOST_ADMIN_KEY=… EVENT_SEED=…`, `fly deploy`. Check `https://<server>/api/health` → `{ ok: true, db: true }`. Boot log shows `prewarmed … corridor cells` and `JIT warm-up`.
3. Web: Vercel project **`code-redline`** (team "Venkatesh's projects"), Git-connected to
   `venkynani1/Hexaracing-grounds`, Root Directory `apps/web`, framework Vite, build `vite build`, output `dist`,
   Node 22, "include source files outside the root directory" ON (the npm workspace `@redline/shared` lives in
   `packages/`). Production URL: https://code-redline.vercel.app. Settings are also pinned in `apps/web/vercel.json`.
   Env (public, build-time — set only once the server is deployed): `VITE_SERVER_URL=https://<server>`,
   `VITE_WS_URL=wss://<server>`. **Never** put `DATABASE_URL` / `SESSION_SECRET` / `HOST_ADMIN_KEY` in the Vercel
   project: every `VITE_*` value is compiled into the browser bundle; secrets belong to the game server only.
   Without `VITE_SERVER_URL` the home page shows a "server not connected" notice; `/benchmark`, `/test-drive`,
   `/slice` and `/credits` are fully offline and work without any server.
4. Smoke: open `/host` (host key), `/projector`, and join a test squad from a phone.

> Status: the Dockerfile and Fly config are provided but were **not built/deployed from this environment** (no
> container runtime here). Treat the first deploy as part of the rehearsal.

## 4. Monitoring during the event
- **Host dashboard** (`/host`): clock/phase, squads, connected players, DB health, tick Hz and p99, Director beat log, weather, closures.
- **Projector** (`/projector`): real positions of every squad, live standings (derived from `scoring_events`), announcements.
- `GET /api/health` (platform health check) and `GET /api/host/world` (host key): `tickHz` (expect 20), `tickP99Ms` (last 400 ticks), `tickP99AllMs` (since boot), `clients`, `bytesOut`, cars.
- Budgets: tick p99 < 10 ms, per-phone downstream < 40 KB/s, 0 unexplained disconnects.
- Audit trail: `audit_logs` (registration, roles, START/PAUSE/RESUME, beats + decisions, ghost-outs, resets, recoveries).

## 5. Incidents
| Symptom | Action |
|---|---|
| Phones disconnected (Wi-Fi blip) | Nothing: clients auto-reconnect with their rejoin token to the same slot; the car AI-brakes after 1 s. |
| Something wrong mid-event (venue issue) | Host → **Emergency pause**. The clock, challenges and Director freeze exactly. **Resume** when ready. |
| Server process crashed / redeployed | It restarts, loads the newest `recovery_snapshots` row (every 10 s and on every phase change), and comes back **PAUSED** at that moment (`event_states`: RECOVERING → PAUSED). Phones rejoin automatically. Host checks `/host`, then **Resume**. Lost: ≤ 10 s of driving; traffic is re-seeded. Scores are never lost (written on award). |
| DB unreachable | Host dashboard shows DB DOWN. The world keeps running in memory; writes fail and are logged. Pause if it persists > 1 min; fix Neon; resume. |
| A squad is stuck | Racer gets "Safe reset" after 3 s (auto at 6 s). Empty tank → automatic roadside recovery. |

## 6. Rehearsal checklist (manual — record results in `docs/PROGRESS.md`)
- [ ] 120 real phones (mix of mid-range Android + iPhone) on the **venue Wi-Fi**, full 60 minutes, host presses START once.
- [ ] Racer phones: ≥ 30 FPS on Medium (FPS counter in HUD), thermals after 45 min, touch controls usable.
- [ ] Wi-Fi: per-phone downstream (host world `bytesOut` / clients / time) and AP capacity; captive portals off.
- [ ] Pull the server mid-event once (redeploy) → recovers PAUSED; resume; nobody lost their slot.
- [ ] Projector on the venue screen, readable from the back of the room; OSM attribution visible.
- [ ] Offer letters downloaded on 5 different phones; disclaimer present; names render (non-Latin names show "?" — known limitation).
- [ ] Confirm approved Hexaware branding (none is used yet; letters and the gate use plain text only).

## 7. Load testing
- In-repo: `npm run test:perf` (fast-forward 120 clients through the whole event, fairness simulation, tick benchmarks).
- Real time against a running server: start it with `JOIN_RATE_LIMIT=10000 COUNTDOWN_MS=2000 RELEASE_AT_MS=0`, then
  `npm run loadtest -- --url http://<server> --bots 30 --roles --seconds 900 --host-key <key> --origin <web origin> --start`
  (30 racers + 90 role clients + host + projector). Run the bots from a different machine than the server for clean numbers.


## Fly.io test deployment (embedded DB — phone testing only)

Prepared and verified in the build environment (image built from this repo, booted in production mode with
`ALLOW_EMBEDDED_DB=true` + `PGLITE_DIR` on a mounted volume; 5 bot squads in one world, 20 Hz, tick p99 3.3 ms).
DEPLOYED 2026-11-21: https://code-redline-server.fly.dev (Fly app `code-redline-server`, personal org, region `sin` —
`bom` is not offered for new apps; volume `redline_data` 1 GB). Image: built from the repo with dependencies installed on
the host (the sandbox's network breaks `npm ci` inside `docker build`), pushed with `fly deploy --image <local> --local-only`;
on a normal machine plain `fly deploy` builds `apps/server/Dockerfile`. To redeploy from any machine with
[flyctl](https://fly.io/docs/flyctl/install/) and `fly auth login`, at the repo root (`fly.toml` is committed):

```
fly apps create code-redline-server
fly volumes create redline_data --region sin --size 1
fly secrets set SESSION_SECRET=$(openssl rand -hex 32) HOST_ADMIN_KEY=$(openssl rand -hex 12)
fly deploy --ha=false
curl https://code-redline-server.fly.dev/api/health    # {"ok":true,"db":true,...}
```
Keep the HOST_ADMIN_KEY you generated (host dashboard login): `fly secrets` never shows it again.

Then point the web app at it (Vercel project `code-redline`, Production env) and redeploy:
`VITE_SERVER_URL=https://code-redline-server.fly.dev`, `VITE_WS_URL=wss://code-redline-server.fly.dev`.

- `ALLOW_EMBEDDED_DB=true` is a test-only opt-in (the server refuses to start in production without
  `DATABASE_URL` otherwise). Data survives restarts on the `redline_data` volume, not a volume loss.
- For the event: `fly secrets set DATABASE_URL=<Neon pooled URL>`, remove `ALLOW_EMBEDDED_DB`, size `performance-2x`.
- Never more than one machine (`--ha=false`, no `fly scale count 2`): ONE WORLD lives in one process.

## GitHub Codespaces host (zero-cost; replaces Fly.io) — prepared, not yet load-tested
`.devcontainer/` installs the server and starts ONE process on port 2567 (`start-server.sh`, log `/tmp/redline-server.log`).
1. GitHub → Settings → Codespaces → Secrets: `DATABASE_URL` (Neon pooled), `SESSION_SECRET` (≥ 32 chars),
   `HOST_ADMIN_KEY` (≥ 12 chars); repository access: `venkynani1/Hexaracing-grounds`. Idle timeout: 240 min.
2. Create: https://codespaces.new/venkynani1/Hexaracing-grounds/tree/ccr-7f7a66bb-6yv4fm (region Southeast Asia, 2-core).
3. Ports tab → 2567 → Port visibility → Public. URL: `https://<codespace>-2567.app.github.dev`.
4. Vercel `VITE_SERVER_URL` / `VITE_WS_URL` → that URL (`wss://` for WS) → redeploy.
Limits: free 120 core-hours/month (≈ 60 h on 2-core); stops after the idle timeout without user activity — keep the
codespace tab open during the event; not an SLA host. Must pass the 120-client bot test before the event.

## Isolated full-event load test (`tools/loadtest/src/eventtest.ts`)
```
npm run eventtest -w @redline/loadtest -- --live-url <live server URL> --squads 30 --race-minutes 20
```
- Spawns its own server (127.0.0.1:2701) with a fresh embedded Postgres under `tools/loadtest/reports/<run>/pglite`,
  event `loadtest-<run>`, random host key/session secret, time warp enabled; `DATABASE_URL*` removed from its env.
- Aborts before any load unless: target ≠ live URL, test event name ≠ live, different world, fresh test event.
- 30 squads × 4 roles (real registration, sessions, WS); racers drive their courses at 20 Hz; host START;
  reconnection storm; server restart (recovery + persistence); accelerated finish; leaderboard vs SQL; live
  event read-only before/after. Report: `report.md` / `report.json` / `events.jsonl` in the run folder (gitignored).
- `--no-live-check` = harness self-test only (live check reported NOT RUN → overall FAIL).
