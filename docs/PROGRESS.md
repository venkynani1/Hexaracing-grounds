# Progress log

Update this at the end of every session: what runs, what's tested, what's next, open risks.

## 2026-11-19 — Project setup
- Added `CLAUDE.md` (project guide auto-loaded by Claude Code), `docs/SPEC.md` (verbatim brief), `docs/DESIGN.md` (feasibility, architecture, coordinates, netcode, interest management, schema, state machine, fairness, rendering), `docs/MILESTONES.md` (acceptance tests).
- Added npm-workspaces skeleton and `.env.example`. **No game code yet.**

### Next
- Start M1: `packages/shared` (enums, timeline, scoring rubric, join-code generator), `packages/db` (Drizzle schema from DESIGN §6 + PGlite tests), `apps/server` (HTTP register/join, signed sessions, single WorldRoom shell, event clock), `apps/web` (join/lobby/host pages, QR).

### Open questions for the owner
- Hosting for the persistent game server (Fly.io / Railway / Render / VM) and budget for event day.
- Approved Hexaware branding assets for the offer letters and gate.
- Licensed live-traffic API, or use scripted density only.
- Exact event date and venue Wi-Fi capacity.
