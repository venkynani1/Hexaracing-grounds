# CODE REDLINE — Event-readiness report (2026-11-22)

Verdict: **NOT YET GO — software complete and tested; four owner actions remain** (see "Blocking before the event").
Every PASS below has a test or a recorded measurement; nothing is claimed from inspection alone.

## Built and verified
| Area | Evidence | Status |
|---|---|---|
| One world, 120 players, 30 squads × 4 roles | Isolated 120-client run (30×4, warped timeline): 0 unplanned disconnects, one shared world every sample | PASS |
| Server performance | tick p99 worst 9.7 ms (budget 10), loop delay p99 19 ms, RSS 630 MB, RTT p99 10 ms, racer snapshots p50 50 / p99 96 ms | PASS |
| Recovery | restart mid-event: 2.0 s downtime, standings identical, resumes LIVE; reconnection storm (40 drop+rejoin) p95 537 ms | PASS |
| Scoring integrity | leaderboard = independent SQL over `scoring_events` for all 30 squads; trades ledgered exactly once | PASS |
| Five levels, all four roles, Director, pit, gate, convoy, reveal, letters | 122 unit/integration tests; 9 browser tests (4 real browser contexts per squad) | PASS |
| Levels 3–4 under load | 30/30 safe-holds, 13 jams / 6 blocked / 10 shields, 2 alliances, 54 Captain duel answers, 15/15 trades | PASS |
| Chennai recognisability | 182 real OSM area names, 203 roadside signs (place boards + Hexaware distance signs per checkpoint), racer location line | PASS (tests) |
| Realistic roadside along the full route | licensed CC0 vegetation streamed per cell (medium+), ≈ 6–11 % FPS cost measured in software rendering | PASS (desktop measure) |
| Phone performance (realistic slice) | Realme RMX5110 / Mali-G615 / 4 GB: full scene HIGH 60.2 median FPS, 1 % low 29, p95 21 ms, 0 visible stalls, no thermal drop | PASS on criteria; formal gate needs one uninterrupted run |
| CI | GitHub Actions: typecheck + unit + build + e2e on every push; green on c0c2e69; flake fixed in 53a3836 | PASS |
| Security | event seed never leaves the server (test); production now REFUSES to start without a private `EVENT_SEED` | PASS |
| Live deployment | web (Vercel) + server (Codespace) both on the stage-3 build; health, DB, CORS, WebSocket verified | PASS (not the newest commit — see below) |

## Blocking before the event (owner)
1. **Real-phone rehearsal** — 10–20 people, venue Wi-Fi, 15–20 min, one START. Simulated players cannot show Wi-Fi/AP
   limits, captive portals or real touch behaviour. Checklist: `docs/RUNBOOK.md` §6.
2. **Low-end phone** — run `/test-drive?auto=1&bench=180&q=medium` (real game scene with signs + vegetation) and
   `/benchmark` on the cheapest phone expected. If it fails at medium, players on that phone use Low.
3. **Fresh event + private seed** on event day (`docs/EVENT_DAY.md`). The current live event was created with the
   public default seed — usable for testing only.
4. **Deploy the newest build** (signs, vegetation, seed guard, join limit) to the codespace + Vercel — needs approval.

## Risks (accepted or open)
| Risk | Mitigation | Owner |
|---|---|---|
| Codespace is one machine, stops when idle, no SLA | 240-min idle timeout, tab open on the host laptop, recovery snapshots every 10 s, restart = `start-server.sh` → PAUSED → Resume | Host |
| Venue NAT: all phones share one IP | `JOIN_RATE_LIMIT` now 600/min in `start-server.sh` (was 60 — would have refused squads) | fixed |
| Hexaware branding | none used (plain text only) until approved files are supplied | Owner / Hexaware |
| Non-Latin names on offer letters | render as "?" (font limitation) | known |
| Vegetation template load hitch (~250 ms once) | happens at race start while cars are parked until 03:00 | accepted |
| Neon autosuspend / DB blip | pool reconnects; world runs in memory; host pauses if DB DOWN > 1 min | Host |

## Not built (by decision)
- Approved Hexaware logo/branding (needs approved source files).
- Tamil-script signage (no verified transliteration source; English OSM names used).
