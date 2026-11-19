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
npm run dev          # web + server concurrently
npm test             # all unit/integration tests
npm run db:generate  # drizzle-kit generate
npm run db:migrate   # apply migrations to DATABASE_URL
```

## Environment variables
See `.env.example`. Server: `DATABASE_URL`, `SESSION_SECRET`, `HOST_ADMIN_KEY`, `PORT`, `PUBLIC_WEB_ORIGIN`, `EVENT_SEED`. Web: `VITE_SERVER_URL`, `VITE_WS_URL`.

## Current status
Milestone 1 not started — repo contains spec, design, milestones and an empty workspace skeleton. Start with M1 in docs/MILESTONES.md.
