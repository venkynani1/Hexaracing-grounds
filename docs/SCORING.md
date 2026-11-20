# Scoring rubric (max 1,000)

Every point is a row in `scoring_events` (category, points, reason, source type + id, server tick, server timestamp).
Totals are **derived** from those rows and capped per category (`packages/shared/src/scoring.ts`); they are never edited.
`unique(source_type, source_id, team_id)` makes every award idempotent. Every squad gets the **same list of opportunities**
at the **same synchronised times** (`CHALLENGE_SCHEDULE` in `packages/shared/src/squad.ts`). Start location, car,
device and graphics preset cannot change any of these.

| Category | Cap | Opportunities (status) |
|---|---|---|
| Driving | 250 | 10 route checkpoints × 25 (M5/M7 — not implemented yet). Ramming ghost-outs are recorded as penalties for the clean-driving component. |
| Coding | 200 | Coding Round 1 (03:00–10:00) and 2 (33:00–42:00): 4 questions each. 25 first try, 10 second try, max 2 attempts. **Implemented (M4).** |
| Deception | 150 | Bluff Round 1 (10:30–16:00) and 2 (25:00–31:00): +25 for voting the real answer; +10 per player fooled by your squad's bluff (max 50). Max 75 per round. **Implemented (M4).** |
| Captain's strategy | 100 | Navigation Intel (24:00–31:00): 50 first try, 20 second try. **Implemented (M4).** Pit stops: +25 per service window if the confirmed service plan covers the Engineer-diagnosed system AND the Deceiver flagged the false report. **Implemented (M6).** |
| Team assessments | 150 | Four-Key Puzzle 1 (10:00–17:00) and 2 (42:00–50:00): 75 / 40 / 20 by attempt, max 3 attempts; only the Captain submits, using four private clues held by four different roles. **Implemented (M4).** |
| Fuel management | 50 | First completed pit stop in each service window (17:00–24:00, 36:00–41:00): 25 with a correct Engineer diagnosis, 10 otherwise. **Implemented (M6).** Roadside recovery and unscored stops cost credits only, never points. |
| Hexaware gate | 100 | Gate assessment 50:00–55:00 (M7). |

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

## Tie-breaks (predeclared)
Total → Team assessments → Coding → Driving → earliest final gate submission → `hash32(seed:tiebreak:teamId)` ascending.
