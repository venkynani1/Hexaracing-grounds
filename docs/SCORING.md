# Scoring rubric (max 1,000)

Every point is a row in `scoring_events` (category, points, reason, source type + id, server tick, server timestamp).
Totals are **derived** from those rows and capped per category (`packages/shared/src/scoring.ts`); they are never edited.
`unique(source_type, source_id, team_id)` makes every award idempotent. Every squad gets the **same list of opportunities**
at the **same synchronised times** (`CHALLENGE_SCHEDULE` in `packages/shared/src/squad.ts`). Start location, car,
device and graphics preset cannot change any of these.

| Category | Cap | Opportunities (status) |
|---|---|---|
| Driving | 250 | 10 checkpoints per course (equal fractions of reference time) × 25: **15** for reaching it under own power + **10** if no ramming ghost-out penalty since the previous checkpoint. Checkpoints passed during the disclosed escort score **0**. **Implemented (M7).** |
| Coding | 200 | Coding Round 1 (03:00–10:00) and 2 (33:00–42:00): 4 questions each. 25 first try, 10 second try, max 2 attempts. **Implemented (M4).** |
| Deception | 150 | Bluff Round 1 (10:30–16:00) and 2 (25:00–31:00): +25 for voting the real answer; +10 per player fooled by your squad's bluff (max 50). Max 75 per round. **Implemented (M4).** |
| Captain's strategy | 100 | Navigation Intel (24:00–31:00): 50 first try, 20 second try. **Implemented (M4).** Pit stops: +25 per service window if the confirmed service plan covers the Engineer-diagnosed system AND the Deceiver flagged the false report. **Implemented (M6).** |
| Team assessments | 150 | Four-Key Puzzle 1 (10:00–17:00) and 2 (42:00–50:00): 75 / 40 / 20 by attempt, max 3 attempts; only the Captain submits, using four private clues held by four different roles. **Implemented (M4).** |
| Fuel management | 50 | First completed pit stop in each service window (17:00–24:00, 36:00–41:00): 25 with a correct Engineer diagnosis, 10 otherwise. **Implemented (M6).** Roadside recovery and unscored stops cost credits only, never points. |
| Hexaware gate | 100 | 50:00–55:00, open to every squad wherever its car is: Racer precision parking in the squad's bay (up to 25, by distance and alignment), Engineer debugging (25), Deceiver authorization check — find the forged badge by its check digit (25), Captain combined 4-digit access code (25 / 15 / 5 by attempt; digits revealed as teammates complete their parts). **Implemented (M7).** |

## Rules
- Answers are checked on the server only; clients never receive answer keys. Four-key clues are stored AES-GCM-encrypted and each
  player only ever receives **their own** clue (asserted over full WebSocket logs in `apps/server/test/squad.test.ts`).
- Each squad gets its own seeded **variant** of every question/puzzle (different numbers/words, identical difficulty),
  so copying another squad's answer does not work. Variants are reproducible from `EVENT_SEED`.
- Bluffing: one entry per squad; an entry equal to the real answer or to another squad's entry is rejected; Deceivers
  cannot vote for their own squad's bluff; one vote per player (also enforced by a DB unique constraint). Settlement is
  deterministic at round close.
- Submissions carry a client idempotency key; replaying a request returns the original result and never re-scores.
- Rewards that affect driving (engine-tune buff for Engineer answers; power-ups from four-key and bluff detection)
  change acceleration/grip/nitro/health only — never the top-speed ceiling — and are available equally to all squads.

## Escort, assisted entry and arrival status
- From 50:00 the Racer or Captain may request the **escort**: the car is driven, visibly and labelled, along its own remaining
  course roads (time-compressed to ~60 s). Squads still on the road at 51:30 are escorted automatically. Skipped checkpoints score 0.
- At 55:00 any squad not at the gate gets **assisted entry** into the Welcome Convoy (non-scoring). Arrival status on the offer
  letter: *under own power* / *via disclosed escort* / *assisted entry*.

## Tie-breaks (predeclared)
Total → Team assessments → Coding → Driving → earliest final gate submission (server timestamp of the access-code scoring row) → `hash32(seed:tiebreak:teamId)` ascending. Standings are computed from `scoring_events` rows in Postgres (`apps/server/src/gate/championship.ts`).

## Level 4 — Trade & Collaborate (rival system)
Automatic at 33:00 (no host action). Squads are ranked by current score (ties: `tieBreakHash`) and adjacent ranks are
paired; with an odd count the last squad takes a solo route. All points go to **CAPTAIN_STRATEGY** (cap 100), each with
an idempotent `sourceId`.

| Action | Window | Points |
|---|---|---|
| Duel — first correct Captain of the pair | 33:00–37:00, 2 attempts | 30 |
| Duel — second correct Captain | same | 10 |
| Duel — solo squad correct | same | 20 |
| Trade completed (both Captains agreed) | 33:00–42:00, one per pair | 10 each |
| Depot exchange (solo path, once per squad) | 33:00–42:00 | 5 |

Trade bounds: credits 10–150, fuel 5–25 % (never below 10 % after giving), nitro 1; offers expire after 90 s; both
balances re-checked at acceptance and applied in one step; one `fuel_transactions` ledger row per squad.

## Championship weighting (40 / 25 / 15 / 10 / 10)
Raw points per category are recorded and capped exactly as above (every row stays in `scoring_events`). The
championship **total** is weighted (`SCORING_WEIGHTS` in `packages/shared/src/scoring.ts`, configurable):

| Group | Weight | Categories (raw cap) |
|---|---|---|
| Cooperative mission completion | 400 | TEAM_ASSESSMENTS (150) + FUEL_MANAGEMENT (50) |
| Puzzle accuracy and efficiency | 250 | CODING (200) + DECEPTION (150) |
| Driving and navigation | 150 | DRIVING (250) |
| Rival strategy | 100 | CAPTAIN_STRATEGY (100) |
| Final gate assessment | 100 | HEXAWARE_GATE (100) |

`total = round(Σ weight × capped group points / group max)`, 0–1000. Tie-breaks unchanged (raw category points).

## Levels 3–4 — Deceiver intel ops and alliances (24:00–42:00)
| Action | Who | Effect / limits | Points |
|---|---|---|---|
| Signal jam | Deceiver | Rival's navigation display scrambled for 20 s (car keeps driving). Targets ±3 ranks, never an ally; 3 per squad; 3-min cooldown; target protected 4 min after a jam | +5 DECEPTION |
| Shield | Deceiver | Blocks incoming jams for 2 min; 6-min cooldown | +5 DECEPTION per blocked jam |
| Alliance | Both Captains | One per squad; allies cannot jam each other | none |

## Racer safe-hold
While a four-key or navigation puzzle is open and unsolved, the Racer may park the car in a protected hold (≤ 90 s,
once per puzzle). It is released automatically when the puzzle is solved or closes, or by the Racer.
