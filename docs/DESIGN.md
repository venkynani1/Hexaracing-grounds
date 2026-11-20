# CODE REDLINE — Engineering Design

Covers the ten deliverables required by SPEC Part 23. Numbers marked *(budget)* are targets to be validated by tests, not measured results.

---

## 1. Technical feasibility assessment

| Requirement | Verdict | Notes / risk |
|---|---|---|
| One authoritative world, 30 cars, 120 clients | **Feasible** on one Node process | 30 vehicles + ~300 traffic agents at 20 Hz is light (< 2 ms/tick expected). Bandwidth is the real constraint → interest management + quantized binary snapshots. |
| 30 FPS on mid-range phones with Babylon.js | **Feasible with discipline** | Requires aggressive LOD, thin instances, KTX2/Basis textures, baked lighting, ≤ 1 dynamic shadow caster cascade, dynamic resolution. "GTA VI-like" is an aesthetic direction, not a fidelity claim. |
| Recognisable Chennai on a ~60 km radius | **Feasible, scoped** | Use OpenStreetMap (ODbL, attribution required) for road centrelines. Only selected corridors are drivable; buildings are procedural/original, landmarks hand-modelled. Not geographically exact. |
| Live traffic estimates | **Optional** | Only from a licensed API (e.g. TomTom/HERE traffic flow) with terms allowing this use. Applied once at start as density multipliers, capped, and never per-team. Falls back to a scripted density profile. |
| Real-time drive of 15–60 km in 47 minutes | **Requires disclosed time/space scaling** | A real 25 km drive at game speed takes too long and route lengths differ widely. See §8 (Route normalisation). |
| Vercel frontend + persistent WS server | **Feasible** | Web on Vercel; game server on Fly.io / Railway / Render (paid tier recommended for event day — free tiers sleep). |
| Neon PostgreSQL | **Feasible** | Use pooled connection string; server is the only DB client. Free tier compute auto-suspends → warm it before the event. |
| 120-client load test | **Feasible** | Headless Node bots speaking the real protocol (`tools/loadtest`). Run from 2–3 machines for realistic network. |

Top risks: (1) mobile GPU performance and thermal throttling, (2) venue Wi-Fi capacity for 120 phones, (3) asset production time for a convincing city, (4) single-process server is a single point of failure → recovery snapshots + fast restart runbook.

---

## 2. Single-world architecture

```
 Phones (120)            Host laptop        Projector
 React+Babylon           Host dashboard     Projector view
      │ WSS                  │ WSS + HTTPS        │ WSS (spectator)
      └──────────────┬───────┴────────────────────┘
                     ▼
        ┌──────────────────────────────────────────┐
        │  Node.js Game Server (single process)    │
        │  ┌────────────┐   ┌───────────────────┐  │
        │  │ WS Gateway │──▶│  WorldRoom (ONE)  │  │
        │  │ auth, rate │   │  fixed 20 Hz tick │  │
        │  │ limit      │   │  - VehicleSystem  │  │
        │  └────────────┘   │  - TrafficSystem  │  │
        │  ┌────────────┐   │  - Weather        │  │
        │  │ HTTP API   │   │  - RoadEvents     │  │
        │  │ register,  │   │  - SpatialGrid    │  │
        │  │ join, host │   │  - Interest Mgr   │  │
        │  └────────────┘   └───────┬───────────┘  │
        │  ┌──────────────────────┐ │              │
        │  │ Redline Director     │─┘ (scheduled   │
        │  │ (event clock, FSM)   │    world events)│
        │  ├──────────────────────┤                │
        │  │ Squad services:      │                │
        │  │ challenges, bluffing,│                │
        │  │ pit stops, scoring   │                │
        │  └──────────┬───────────┘                │
        └─────────────┼────────────────────────────┘
                      ▼  async write queue (idempotent)
              Neon PostgreSQL (Drizzle)
```

- Exactly **one `WorldRoom` instance per event**, created at server boot from the `events` row. There is no matchmaking. Every connection — Racer, Engineer, Deceiver, Captain, host, projector — attaches to that same room with a role-scoped view.
- The world owns all entities in one `Map<EntityId, Entity>` with one global coordinate system (§3).
- Squad services (challenges, bluffing, pit stops) are pure server modules that mutate squad state and emit scoring events; they never run their own clocks — they read the Director clock.
- Persistence is write-behind: a bounded queue flushes checkpoints, scoring events, submissions and audit logs; every row carries an idempotency key.
- Recovery: snapshot of full world + director state every 10 s (and on every phase change) to `recovery_snapshots`; on restart the server loads the newest snapshot, pauses, and the host resumes.

**Scale-out plan (only if a single process fails budgets):** keep one logical world; split *simulation* by streaming cell across worker threads in the same process (SharedArrayBuffer for entity tables) with authoritative handoff at cell borders. Never split clients into separate rooms.

---

## 3. Shared coordinate and road-network design

**Coordinate system.** Local tangent plane (ENU) anchored at the Hexaware Siruseri campus gate (exact lat/lon to be verified and stored in `world_metadata`). `x` = east metres, `z` = north metres, `y` = up. All server and client positions use this frame. Conversion lat/lon → ENU happens only in `tools/mapbuild`.

**Game-scale factor.** *(Revised in M5, measured.)* World geometry is built from real OSM centrelines and **uniformly scaled by `map.scale`**, chosen by `tools/mapbuild` so the longest natural route (Chennai Central → Hexaware) takes the 30-minute reference-car target. Result: **0.849** (Chennai at 85% scale). The original 1:8 guess would have made the longest drive ≈ 4 km / 3 min — far too short for the 47-minute driving window. The same factor applies everywhere, so relative geography is preserved and convergence is real. The scale is disclosed in-game and on /credits.

**Road graph.** Built offline by `tools/mapbuild` from OSM extracts of selected corridors:
- `nodes`: junctions with id, position, signal flag.
- `edges`: polyline, lane count per direction, speed class, surface, one-way flag, length.
- Derived: lane centrelines, junction connectors, checkpoint gates, service-station spurs.
- Output: `road-graph.bin` (server + client) and per-cell glTF/GLB meshes (client).

**Streaming cells.** Square cells (*budget*: 500 m game-space). Each cell file holds road mesh, props, building instances, and nav data. Cells are client-side loading units and server-side spatial-index buckets — they are not separate worlds.

**Starting locations** (all must be verified on the map before enabling): Chennai Central, Guindy, Velachery, Tambaram, Thiruvanmiyur, Kelambakkam, Mahabalipuram. Each has a spawn grid of ≥ 6 slots on a real road so multiple squads can pick the same area. Max squads per start = 6 to avoid spawn crowding.

**Destination.** Hexaware gate trigger volume + campus loop road used by the Gate assessment and the Welcome Convoy (30 parking/convoy slots).

---

## 4. Network synchronisation strategy

- **Transport:** WebSocket (WSS). Binary messages (MessagePack or hand-packed `ArrayBuffer`) for snapshots/inputs, JSON for low-rate events.
- **Simulation tick:** 20 Hz fixed (`dt = 50 ms`) on the server, deterministic vehicle model in `packages/shared` so client and server run identical code.
- **Inputs:** Racer client sends `{seq, tick, steer, throttle, brake, nitro, handbrake}` at 30 Hz, batched, max 60 msg/s (rate-limited). Server clamps ranges, rejects out-of-order/replayed `seq`, buffers ≤ 3 ticks of jitter.
- **Client prediction & reconciliation (own car):** client simulates locally with the shared model; each snapshot carries `lastProcessedSeq`; client rewinds to the authoritative state and replays unacknowledged inputs. Small errors are smoothed over 100–200 ms; > 5 m error snaps.
- **Interpolation (other cars, traffic):** render 100 ms in the past, interpolating between buffered snapshots; brief extrapolation (≤ 150 ms) on packet loss.
- **Snapshot encoding:** per entity ~16 bytes (id u16, x/z quantised to 2 cm as i32-delta or f32, heading u16, speed u16, flags u8). Delta against last acked snapshot.
- **Non-driving roles** (Engineer, Deceiver, Captain) subscribe to squad events + their squad car's state at 5 Hz + global map at 1 Hz — they don't need full 3D streams.
- **Clock sync:** NTP-style ping exchange at connect and every 10 s; client displays the Director clock from server time offset.
- **Reconnection:** signed rejoin token in localStorage; on reconnect the server re-binds the slot, sends a full keyframe snapshot and squad state; the car keeps coasting/braking under server AI-brake for up to 20 s, then holds position safely.

*(budgets)* Per-phone downstream ≤ 40 KB/s average; server egress ≤ 6 MB/s total; input→own-car response feels immediate (predicted); server tick ≤ 10 ms p99.

---

## 5. Interest-management architecture

Server keeps a uniform spatial hash grid (cell = 250 m game-space) of all dynamic entities. For each subscriber per tick:

| Tier | Distance from viewer | Update rate | Content |
|---|---|---|---|
| Near | ≤ 300 m | 20 Hz | full state (pos, heading, speed, lights, damage FX flags) |
| Mid | 300 – 1200 m | 5 Hz | pos, heading, speed |
| Far | > 1200 m | 1 Hz via global map channel | squad id, pos, progress |
| Global | everyone | on change | Director phase, weather, road closures, leaderboard, announcements |

- Squad cars are **always** included in at least the Far tier for everyone, so nobody ever "disappears from the world" — they move to the minimap.
- Traffic agents are only sent in Near/Mid tiers.
- Road events (closures, diversions) are global state; geometry for them is in the client's road graph, so everyone approaching sees the same closure.
- The projector/host subscribe to Far tier for all 30 cars at 5 Hz plus Near tier around a followed squad.
- Hysteresis (10%) on tier boundaries to avoid flapping.

---

## 6. Database schema (Neon + Drizzle)

All tables have `id` (uuid, default random) and `created_at`. `event_id` FK on everything event-scoped. Idempotency via unique constraints noted.

| Table | Key columns | Notes |
|---|---|---|
| `events` | name, status (enum), seed (bigint), started_at, paused_ms, host_key_hash | One row per event run |
| `teams` | event_id, name, join_code (char6, unique per event), vehicle_id, start_location_id, paint, ready | Code alphabet excludes 0/O/1/I |
| `players` | team_id, slot (1–4), role (enum), display_name, rejoin_secret_hash, connected_at, last_seen_at | unique(team_id, slot), unique(team_id, role) |
| `sessions` | player_id or host, token_hash, expires_at, revoked_at, user_agent | Signed token, hash stored |
| `vehicles` | code (vortex_gt…), name, stats jsonb, balance_version | Seeded catalogue |
| `car_selections` | team_id, vehicle_id, paint, selected_by_player_id, selected_at | History; latest wins |
| `start_locations` | code, name, lat, lon, world_x, world_z, enabled, verified_at, max_squads | |
| `world_metadata` | event_id, anchor_lat, anchor_lon, world_scale, map_version, osm_attribution | |
| `road_segments` | map_version, edge_id, from_node, to_node, length_m, lanes, speed_class, cell_x, cell_z | Metadata only; geometry in asset files |
| `challenges` | code, type (coding/logic/truth/navigation/four_key/gate), phase, payload jsonb (no answers), answer_hash, max_points, category | Answers stored hashed/encrypted |
| `challenge_clues` | challenge_id, team_id, role, clue_ciphertext | Per-role private clues |
| `challenge_submissions` | challenge_id, team_id, player_id, answer, correct, points, submitted_at, idempotency_key | unique(idempotency_key) |
| `bluff_rounds` | event_id, prompt, true_answer_hash, opens_at, closes_at, status | |
| `bluff_entries` | round_id, team_id, player_id, fake_answer | unique(round_id, team_id) |
| `bluff_votes` | round_id, voter_team_id, voter_player_id, choice_id | unique(round_id, voter_player_id); cannot vote own entry |
| `fuel_transactions` | team_id, delta_fuel, reason, credits_delta, at_tick | |
| `pit_stops` | team_id, station_id, stage, started_at, completed_at, outcome jsonb | |
| `vehicle_checkpoints` | team_id, checkpoint_id, tick, elapsed_ms, speed | unique(team_id, checkpoint_id) |
| `scoring_events` | team_id, category (enum of 7), points, reason, source_type, source_id, tick | unique(source_type, source_id, team_id) — idempotent |
| `event_states` | event_id, phase, director_tick, transitioned_at, cause | Phase history |
| `recovery_snapshots` | event_id, tick, phase, state jsonb (compressed), created_at | Keep last 50 |
| `offer_letters` | player_id, achievement, final_score, arrival_status, pdf_url, generated_at | |
| `audit_logs` | event_id, actor_type, actor_id, action, payload jsonb, ip_hash, at | Append-only |

Indexes: `teams(event_id, join_code)`, `players(team_id)`, `scoring_events(team_id, category)`, `challenge_submissions(challenge_id, team_id)`, `audit_logs(event_id, at)`.

---

## 7. Event state machine

**Event status:** `DRAFT → REGISTRATION_OPEN → REGISTRATION_LOCKED → COUNTDOWN → LIVE ⇄ PAUSED → FINISHED → ARCHIVED`. `PAUSED` reachable from `COUNTDOWN` and `LIVE` (host only). `RECOVERING` entered on server restart from snapshot; exits to `PAUSED`.

**Director clock:** `elapsedMs = now − startedAt − totalPausedMs`. All phases and beats are pure functions of `elapsedMs` + `seed`; a tick processes every beat whose time ≤ elapsed exactly once (idempotent, logged).

**Phases (LIVE):**

| Time | Phase | Server actions on entry |
|---|---|---|
| 00:00 | IGNITION | spawn 30 cars at start grids, 3:00 includes 10 s countdown, tutorial challenge |
| 03:00 | CITY_SPRINT | release cars, traffic on, coding round 1 |
| 10:00 | TRAFFIC_TACTICS | four-key puzzle 1, bluff round 1 |
| 17:00 | FUEL_CRISIS | service window 1 opens (17:00–24:00) |
| 24:00 | UNKNOWN_ZONE | navigation challenge, bluff round 2 |
| 33:00 | REDLINE_OVERDRIVE | service window 2 (36:00–41:00), coding round 2 |
| 42:00 | FINAL_APPROACH | four-key puzzle 2 |
| 50:00 | HEXAWARE_GATE | gate assessment open to all squads (see §8) |
| 55:00 | WELCOME_CONVOY | scoring frozen, convoy choreography |
| 58:00 | CHAMPIONSHIP_REVEAL | verify totals, tie-breaks, reveal, offer letters |
| 60:00 | FINISHED | |

**Director beats:** 08:00 FIRST_CONTACT, 14:00 TRAFFIC_SHOCK, 20:00 FUEL_CRISIS, 27:00 CLASSIFIED_ENVELOPE, 31:00 ROUTE_LOCKDOWN, 37:00 MONSOON_PROTOCOL (shared rain, grip ×0.8), 43:00 FINAL_RECRUITMENT_ALERT, 47:00 TOTAL_REDLINE. Each beat's parameters (which road closes, which envelope) come from a seeded RNG over a *bounded, pre-validated* option list, chosen so every route has an open alternative.

---

## 8. Fairness specification

**Route normalisation (disclosed).** Each start location has a validated route to Hexaware. Routes differ in length; instead of hiding that:
- Each route has exactly **N = 10 driving checkpoints**, placed at equal *fractions of route time* on a reference vehicle, so every squad faces the same number of scoring gates.
- Driving score is per-checkpoint (25 pts each = 250): points from on-time arrival vs. that route's calibrated split, clean driving (no ramming), and precision sections. Never from absolute distance or order of arrival alone.
- Calibration: the mapbuild tool simulates the reference car (and all 4 cars) on each route; target route time ≈ 40 min. Routes whose simulated times differ > 10% get a disclosed **time-compression multiplier** on that route's long boring stretches (speed-limit boost zones marked "EXPRESS CORRIDOR" in-game) — applied identically to anyone driving that stretch, including other squads.
- **Gate arrival transition (minute 50):** squads not yet at the gate are offered "Escort to Hexaware" — a visible, labelled convoy-escort drive on the real road at boosted speed (everyone sees the escort lights). Driving checkpoints skipped via escort award 0 driving points. Gate assessment points (100) remain fully available to all squads.

**Vehicle balance.** Four cars share the same performance envelope: equal route time on the reference routes within ±2% (verified by simulation in CI). They differ in feel (acceleration vs. handling vs. durability), not in score ceiling.

**Scoring (max 1000):** Driving 250, Coding 200, Deception 150, Captain strategy 100, Team assessments 150, Fuel management 50, Hexaware gate 100. Each category has a fixed list of opportunities identical for all squads; points are capped per category server-side. Rubric lives in `packages/shared/src/scoring.ts` and is exported to `docs/SCORING.md`.

**Tie-breaks:** team assessments → coding → driving → earliest timestamp of final gate submission → lexicographic hash of (seed, team id) — predeclared.

**Collisions / griefing:** car-vs-car contact is real; damage per contact is capped; a car that causes repeated high-impulse contacts with the same squad within 10 s gets a "ghost-out" (non-collidable, visible, labelled) for 5 s and a clean-driving penalty; the victim gets a free reset. Stuck > 6 s → safe reset to nearest lane centre.

**Service stations:** each station has ≥ 4 bays; queue is FIFO per station; max 60 s dwell; cars in the station zone are non-collidable.

**Live traffic:** applied at start as a global density multiplier per road class (clamped 0.6–1.4); route calibration includes worst-case density; traffic never affects score other than via driving.

**Randomness:** single `EVENT_SEED`; every random draw is logged with beat id. Replaying the seed reproduces all Director decisions.

---

## 9. Mobile rendering strategy (Babylon.js)

- **Engine:** WebGL2 (WebGPU opt-in when available). `adaptToDeviceRatio` off; hardware scaling level driven by dynamic resolution controller targeting 30 FPS (scale 0.5–1.0).
- **Presets:** Low / Medium / High / Ultra — draw distance (300/600/1000/1500 m), shadow (off / 1 cascade 1024 / 2 cascades 2048 / CSM 4096), reflections (static env cube / + SSR off / probe updated 1 Hz / SSR), post (none / FXAA / FXAA+bloom / TAA+bloom+motion blur), particle caps. Presets change visuals only.
- **Vehicles:** PBR materials with clearcoat (paint), single prefiltered env map (KTX2 .env), 3 LODs (≈ 40k / 10k / 1.5k tris), interiors only in LOD0 for own car.
- **City:** cell-streamed GLB with Draco/Meshopt compression, KTX2/Basis textures, thin instances for buildings/props/traffic, merged static meshes per cell, freeze world matrices, baked lightmaps/AO for day; night uses emissive windows + few dynamic lights (headlights as projected textures, not real lights, beyond own car).
- **Weather:** GPU particle rain capped by preset, wet-road via roughness/normal blend + planar-ish fake reflections; day/night via sky shader + hemisphere/directional lights interpolated by Director time.
- **FX:** tire smoke, nitro flame, sparks as pooled GPU particles.
- **Audio:** Babylon audio engine v2; engine sound from RPM-crossfaded loops; ambient city per cell.
- **Budgets *(budget)*:** ≤ 150 draw calls, ≤ 400k tris visible, ≤ 250 MB GPU memory, initial download ≤ 15 MB, cells ≤ 1.5 MB each.
- Projector/host use Ultra on a laptop GPU.

---

## 10. Milestone acceptance tests

See `docs/MILESTONES.md`.
