# MASTER DEVELOPMENT PROMPT — CODE REDLINE: ROAD TO HEXAWARE

> Verbatim original brief from the project owner. This is the authoritative requirements document. Do not ask for it again.

Build a Cinematic, AAA-Inspired, Single-World Multiplayer 3D Racing Adventure

You are an elite multidisciplinary game development studio consisting of AAA game designers, 3D graphics engineers, multiplayer networking architects, racing physics engineers, geospatial engineers, full-stack developers, security engineers, and DevOps specialists.

Your task is to design, implement, test, and deploy a real, playable multiplayer racing adventure.

- Game: CODE REDLINE: ROAD TO HEXAWARE
- Tagline: Race. Decode. Survive. Arrive.
- Duration: 60 minutes
- Participants: 120
- Teams: 30 squads, exactly four participants each
- World: ONE shared, persistent, synchronized 3D Chennai environment.
- Destination: Hexaware Technologies, Siruseri, Chennai.
- Database: Neon PostgreSQL.
- Frontend: React, TypeScript, Babylon.js, Vercel.
- Multiplayer: Persistent authoritative Node.js game server using WebSockets.

## ABSOLUTE REQUIREMENT: ONE WORLD, NOT MULTIPLE ROOMS

All 30 squad vehicles must exist simultaneously in the same authoritative 3D world.

There must be:

- One shared Chennai road network.
- One global world state.
- One event clock.
- One synchronized weather system.
- One coordinated traffic simulation.
- One set of shared road events.
- One championship leaderboard.
- One Hexaware destination.
- One Welcome Convoy.

Do not create six five-car racing rooms.
Do not create separate maps per team.
Do not create disconnected racing instances that merely share a leaderboard.
Do not substitute real player vehicles with artificial ghosts.
Do not fake multiplayer using independently animated cars.

All 30 squad cars must have real server-authoritative positions within the same coordinate system.

If two squads drive onto the same road, they must see one another, subject only to documented visibility and rendering optimization.

They must be able to overtake and interact using consistent, server-validated rules.

All 120 participants must remain connected to the same game session, although each squad member has a different role-specific interface.

---

## PART 1 — PREMIUM 3D GRAPHICS

Create an original, realistic-looking mobile racing experience inspired by the cinematic presentation and visual ambition of modern AAA open-world driving games such as GTA VI.

Do not copy proprietary assets or claim native GTA VI rendering fidelity.

Implement:

- Physically based vehicle materials.
- Detailed vehicle bodies and interiors where practical.
- High-quality paint reflections.
- Dynamic headlights and brake lights.
- Realistic-looking roads.
- Traffic signals.
- Detailed roadside buildings.
- Bridges and flyovers.
- Environmental lighting.
- Day/night transitions.
- Rain and water effects.
- Tire smoke.
- Nitro effects.
- Collision sparks.
- Cinematic camera transitions.
- Weather effects.
- Optimized shadows.
- Environmental audio.
- Vehicle engine sounds.

Target stable 30 FPS on supported mid-range phones.

Implement adaptive graphics, compressed textures, instancing, asset streaming, level-of-detail systems, and dynamic resolution.

Use low-, medium-, high-, and ultra-quality presets.

Visual quality must not change gameplay outcomes.

---

## PART 2 — ONE CONNECTED CHENNAI WORLD

### 2.1 Shared geography

Create a connected virtual road network representing selected Chennai corridors within approximately 60 km of Hexaware Siruseri.

Use appropriately licensed geographic data.

Candidate starting areas:

- Chennai Central.
- Guindy.
- Velachery.
- Tambaram.
- Thiruvanmiyur.
- Kelambakkam.
- Mahabalipuram.

Verify exact coordinates, routing, and radius eligibility before enabling a location.

Every team chooses a starting location before the event.

All teams then drive toward the same destination.

### 2.2 Real roads and landmarks

Represent recognizable Chennai geography, including appropriate sections of OMR, major junctions, office corridors, bridges, service roads, petrol stations, and the Siruseri approach.

Use original or licensed 3D assets.

Do not scrape Google Maps or Street View.

Do not claim every building, lane, or metro structure is geographically exact unless verified and appropriately licensed.

### 2.3 Connected-world requirement

The entire playable road network must use one shared coordinate system.

Example:

Team A starts near Guindy.
Team B starts near Velachery.
Team C starts near Tambaram.

As they travel, their routes may converge.

If Team A and Team B reach the same road segment, both vehicles appear in the same world.

They can see each other's squad names, relative positions, overtaking maneuvers, and shared traffic conditions.

A team's selected starting location must not determine its maximum possible score.

### 2.4 Fair route design

Different geographical routes have different actual lengths.

Preserve geographic identity but normalize competitive driving workload using validated checkpoints, equivalent driving challenges, calibrated timing, and identical maximum scoring opportunities.

Do not pretend that different routes are physically equal.

Do not teleport vehicles invisibly to create fake route equality.

Any assisted transition, time compression, or route normalization must be explicitly designed and consistently applied.

---

## PART 3 — SINGLE-WORLD MULTIPLAYER ARCHITECTURE

### 3.1 One authoritative world simulation

Implement one logical world simulation containing:

- 30 player-controlled squad cars.
- All connected road segments.
- Shared traffic entities.
- Shared road events.
- Shared weather state.
- Shared checkpoints.
- Shared fuel stations.
- Shared Hexaware destination.

All vehicle positions use one global coordinate system.

All game clients receive world updates from the same authoritative simulation.

### 3.2 Network architecture

Use a persistent Node.js multiplayer backend.

Prefer Colyseus or an equivalent framework capable of maintaining one authoritative world session.

Use WebSockets for:

- Player input.
- Vehicle updates.
- Nearby vehicle state.
- Team communication events.
- Challenge notifications.
- Fuel updates.
- Weather changes.
- Suspense events.
- Global rankings.

Implement server-side input validation, fixed simulation ticks, interpolation, client prediction, reconciliation, and reconnection recovery.

### 3.3 Interest management

A shared world does not require every phone to render all 30 vehicles continuously.

Implement spatial interest management.

For example:

- Nearby vehicles receive frequent position updates.
- Distant vehicles receive lower-frequency updates.
- Very distant vehicles appear on the global map rather than in the local 3D scene.
- Relevant road events are delivered to affected players.
- Global competition events reach everyone.

This is a rendering and networking optimization only.

It must never split the game into separate worlds.

### 3.4 World partitioning without separate rooms

For performance, divide the map internally into geographic streaming cells.

Each cell contains roads, buildings, traffic, and other assets.

The server may use spatial indexes or distributed processing where necessary.

However:

All cells belong to the same logical world.

Players must cross cell boundaries seamlessly without matchmaking, rejoining, loading a different match, or losing visibility of nearby players.

If server-side partitioning is eventually required, design seamless authoritative entity handoff while maintaining one global world identity.

### 3.5 Collision fairness

All player cars must obey consistent collision rules.

Prevent deliberate griefing.

Use bounded collision penalties, anti-ramming protections, and safe recovery.

Do not allow another squad to permanently block a team.

---

## PART 4 — REGISTRATION AND TEAM CREATION

Players scan one QR code to open the game.

They can:

- Create a squad.
- Join a squad using a six-character team code.
- Enter their names.
- Choose their roles.
- Wait in a shared lobby.

Each squad contains:

- P1 — Racer.
- P2 — Engineer.
- P3 — Deceiver.
- P4 — Captain / Strategist.

The squad creator initially becomes Captain.

Allow authorized role changes before the host starts.

Maintain stable team and player-slot identities.

Provide secure rejoin credentials.

No email OTP required.

---

## PART 5 — PREMIUM CAR SHOWROOM

Create a realistic-looking 3D car showroom.

Include reflective floors, cinematic lighting, rotating cars, paint customization, engine previews, and interactive camera controls.

Vehicles:

- Vortex GT — balanced.
- Thunder RS — acceleration.
- Phantom X — handling.
- Titan XR — durability.

Balance all vehicles through simulation.

The Captain selects the vehicle.

The selection synchronizes to all squad members.

Every squad has access to the same vehicle options.

---

## PART 6 — REAL DRIVING

Implement a playable mobile racing engine with:

- Steering.
- Throttle.
- Braking.
- Nitro.
- Drifting where appropriate.
- Camera switching.
- Collision response.
- Vehicle health.
- Fuel consumption.
- Tire condition.
- Surface traction.
- Rain grip changes.

Use a responsive third-person chase camera.

The Racer drives the squad car.

Other teammates participate through their own interfaces.

---

## PART 7 — LIVE TRAFFIC AND SHARED ROAD EVENTS

Use authorized traffic-aware routing data where available.

At event start, obtain permitted traffic estimates.

Use these to influence the virtual environment.

Actual 3D traffic vehicles must be simulated by the game server.

Include:

- Cars.
- Buses.
- Motorcycles.
- Trucks.
- Traffic signals.
- Junction queues.
- Lane changes.
- Road diversions.

All teams traveling through the same location must experience the same underlying shared traffic state.

Avoid rendering separate contradictory traffic realities for nearby teams.

Live traffic data must not introduce arbitrary scoring disadvantages.

---

## PART 8 — FOUR SIMULTANEOUS PLAYER ROLES

**Racer** — Drives the car, overtakes opponents, avoids collisions, enters service stations, and completes precision checkpoints.

**Engineer** — Solves coding, debugging, output-prediction, and technical logic challenges. Correct answers unlock vehicle benefits and contribute to the technical score.

**Deceiver** — Participates in an original bluffing system. Creates convincing false answers, detects genuine answers, and earns tactical rewards. Prevent collusion and duplicate voting.

**Captain** — Controls navigation, fuel strategy, power-up deployment, service decisions, and combined team submissions.

All four roles must have meaningful simultaneous activity.

No role should become a spectator.

---

## PART 9 — FUEL AND PIT STOPS

Starting resources:

- Fuel: 75%.
- Vehicle health: 100%.
- Tires: 100%.
- Garage credits: 500.

These are provisional balancing values.

Create shared 3D petrol stations and garages in the Chennai world.

Multiple squad cars may enter the same station and see one another.

Service capacity and queue rules must be fair.

Do not allow one squad to block another from accessing service.

Pit-stop process:

1. Racer enters the station.
2. Captain selects fuel or repairs.
3. Engineer completes diagnostics.
4. Deceiver identifies false information.
5. Captain confirms service.
6. Racer returns to the shared road network.

Major service windows occur around minutes 17 and 36.

Fuel exhaustion triggers fair roadside recovery, not elimination.

---

## PART 10 — AUTOMATIC REDLINE DIRECTOR

The host presses START once.

All subsequent normal game progression is automated.

Use a server-authoritative event clock.

Schedule:

- 08:00 — FIRST CONTACT.
- 14:00 — TRAFFIC SHOCK.
- 20:00 — FUEL CRISIS.
- 27:00 — CLASSIFIED ENVELOPE.
- 31:00 — ROUTE LOCKDOWN.
- 37:00 — MONSOON PROTOCOL.
- 43:00 — FINAL RECRUITMENT ALERT.
- 47:00 — TOTAL REDLINE.

Shared weather and major world events must synchronize across the map.

If a road closure occurs, every player approaching that same location must see the same closure.

Challenges may be role-specific or team-specific, but their scoring opportunities must remain equivalent.

Random events must be seeded, bounded, reproducible, and auditable.

---

## PART 11 — AUTOMATED 60-MINUTE CONTROLLER

Use the following timeline:

- 00:00–03:00 — Ignition.
- 03:00–10:00 — City Sprint.
- 10:00–17:00 — Traffic & Tactics.
- 17:00–24:00 — Fuel Crisis.
- 24:00–33:00 — Unknown Zone.
- 33:00–42:00 — Redline Overdrive.
- 42:00–50:00 — Final Approach.
- 50:00–55:00 — Hexaware Gate.
- 55:00–58:00 — Welcome Convoy.
- 58:00–60:00 — Championship Reveal.

The server automatically:

- Locks registration.
- Starts the countdown.
- Spawns 30 cars at their selected starting locations.
- Launches the world simulation.
- Activates challenges.
- Manages weather.
- Controls traffic events.
- Opens service windows.
- Advances the official event phases.
- Initiates the gate assessment.
- Starts the Welcome Convoy.
- Verifies results.
- Reveals the winner.

Only emergency pause, resume, or recovery requires host intervention.

---

## PART 12 — COOPERATIVE CHALLENGES

Create four-key team puzzles.

Each player receives a different private clue.

The Captain combines the information and submits the answer.

Use synchronized challenge deadlines.

Include coding, logic, truth detection, and navigation.

Protect private clues.

Award points through server-side validation.

---

## PART 13 — HEXAWARE GATE

At minute 50, all teams must be able to participate in the synchronized final assessment.

Design a clearly disclosed, fair arrival-transition system for teams that have not physically reached the destination in the virtual world.

Do not secretly teleport or award unearned driving points.

Final assessment:

- Racer — precision parking.
- Engineer — debugging.
- Deceiver — authorization verification.
- Captain — combined access code.

The assessment runs until minute 55.

Unsuccessful squads receive assisted entry after the scoring window.

Every team joins the finale.

---

## PART 14 — GAME OFFER LETTERS

Generate a personalized fictional game offer letter for each participant.

Include:

- Participant name.
- Team name.
- Role.
- Vehicle.
- Achievement.
- Final score.
- Campus arrival status.

Clearly mark the document:

**COMMEMORATIVE GAME OFFER LETTER — NOT AN EMPLOYMENT OFFER.**

Provide downloadable PDFs or shareable images.

Use approved Hexaware branding only.

---

## PART 15 — THE WELCOME CONVOY

At minute 55, gather all 30 real squad vehicles at the Hexaware campus.

This must happen within the same shared world.

Create a synchronized, non-scoring cinematic convoy.

Show:

- All 30 cars.
- Team names.
- The Hexaware gate.
- Campus roads.
- Headlights.
- Cinematic camera movements.
- Reflections.
- Confetti.
- Fireworks.
- An aerial finale.

Display:

30 SQUADS.
120 PLAYERS.
ONE DESTINATION.
WELCOME TO HEXAWARE.

Do not create separate convoy instances for different teams.

All connected players must see the same convoy timeline.

---

## PART 16 — FAIR SCORING

Maximum score: 1,000.

- Driving — 250.
- Coding — 200.
- Deception — 150.
- Captain's strategy — 100.
- Team assessments — 150.
- Fuel management — 50.
- Hexaware gate — 100.

Implement deterministic server-side scoring.

Do not award arbitrary bonuses for starting closer to Hexaware.

Do not favor teams based on car selection.

Use equivalent challenge opportunities.

Document the scoring rubric.

Audit all awarded points.

Tie-breakers:

1. Team assessments.
2. Coding.
3. Driving.
4. Predeclared deterministic final tie-break.

Run balancing simulations across all routes and vehicle types.

---

## PART 17 — HOST DASHBOARD AND PROJECTOR

Build a premium host control center.

Before START:

- Registration QR.
- Team management.
- Player roster.
- Role assignments.
- Car selection status.
- Starting-location status.
- Device readiness.
- World readiness.
- Start button.

During the event:

- Official timer.
- Connected participants.
- 30 live vehicle positions.
- Shared Chennai world map.
- Fuel status.
- Suspense events.
- Challenge progress.
- Weather status.
- Scoreboard.
- Network health.
- Server health.
- Database health.

Projector mode must display the same shared world, including the actual positions of all 30 teams.

Use a cinematic top-down Chennai map, with squad markers and live progress.

Provide camera options to follow selected squad vehicles.

The projector must not show fabricated positions or prerecorded race results.

---

## PART 18 — NEON POSTGRESQL

Use Neon PostgreSQL with Drizzle ORM.

Store:

- Events.
- Teams.
- Players.
- Sessions.
- Vehicles.
- Car selections.
- Starting locations.
- World metadata.
- Road-network metadata.
- Challenge definitions.
- Challenge submissions.
- Bluffing rounds.
- Votes.
- Fuel transactions.
- Pit stops.
- Vehicle checkpoints.
- Scoring events.
- Event states.
- Recovery snapshots.
- Offer letters.
- Audit logs.

Do not persist vehicle positions every simulation frame.

Keep active simulation state in memory.

Use database transactions, indexes, pooled connections, and idempotent writes.

Implement recovery snapshots.

Never expose database credentials to browsers.

---

## PART 19 — SECURITY

Implement:

- Secure team codes.
- Signed sessions.
- Role-based authorization.
- Protected host controls.
- Server-side scoring.
- Input validation.
- Anti-cheat detection.
- Rate limiting.
- Private clue protection.
- Replay-attack prevention.
- Reconnection security.
- Audit logging.

All vehicle physics and official scoring must be validated by the server.

---

## PART 20 — SINGLE-WORLD PERFORMANCE REQUIREMENTS

Load-test:

- 120 simultaneous connected participants.
- 30 active squad cars.
- One shared world.
- Shared traffic entities.
- Shared weather.
- Vehicle interactions.
- Concurrent coding submissions.
- Bluffing rounds.
- Event announcements.
- Database persistence.
- Host dashboard.
- Projector connections.
- Reconnection scenarios.

Implement spatial indexing and interest management.

Measure server simulation time, network bandwidth, latency, and client frame rate.

Set explicit performance budgets.

Do not claim production readiness until the single-world 120-client test passes.

---

## PART 21 — DEVELOPMENT MILESTONES

**Milestone 1 — Foundation.** Create: project architecture; Neon database schema; team registration; QR joining; four-player lobby; host dashboard; event clock.

**Milestone 2 — Shared 3D world.** Create: one connected 3D road environment; one playable car; mobile controls; camera system; basic traffic; vehicle physics.

**Milestone 3 — Actual multiplayer.** Expand to: five real cars in the same world; ten cars; twenty cars; thirty cars. At every stage, test actual shared positions and interactions. Never switch to separate rooms as a shortcut. Add client prediction, interpolation, reconciliation, and spatial interest management.

**Milestone 4 — Four-player squad mechanics.** Implement Engineer, Deceiver, and Captain interfaces. Connect all role actions to the real squad vehicle.

**Milestone 5 — Chennai geography.** Add licensed road data, starting locations, recognizable environments, and route normalization.

**Milestone 6 — Fuel and suspense.** Implement shared service stations, vehicle condition, automated world events, and the Redline Director.

**Milestone 7 — Final experience.** Implement the Hexaware gate, offer letters, Welcome Convoy, and championship reveal.

**Milestone 8 — Production testing.** Run 120-client load tests, fairness simulations, security testing, mobile performance tests, and a complete 60-minute rehearsal.

Every milestone must have executable acceptance tests.

---

## PART 22 — DEPLOYMENT

- Frontend: Vercel.
- Database: Neon PostgreSQL.
- Real-time multiplayer: persistent Node.js server.
- 3D assets: optimized CDN/object storage.

Do not deploy the authoritative game simulation as a short-lived serverless function.

Provide environment variables, migrations, deployment instructions, monitoring, and recovery procedures.

Prefer low-cost infrastructure, but disclose any resource limitations.

---

## PART 23 — REQUIRED EXECUTION

First produce:

1. Technical feasibility assessment.
2. Single-world architecture.
3. Shared coordinate and road-network design.
4. Network synchronization strategy.
5. Interest-management architecture.
6. Database schema.
7. Event state machine.
8. Fairness specification.
9. Mobile rendering strategy.
10. Milestone acceptance tests.

Then begin implementing Milestone 1 in the project workspace.

Continue with actual code, tests, and working builds.

Do not stop after creating diagrams or mockups.

Do not claim a feature is complete unless it runs.

Do not silently replace single-world multiplayer with separate racing instances.

---

## FINAL CREATIVE DIRECTIVE

Build a living virtual Chennai where all 30 teams exist together.

Teams should start from different places, travel through connected roads, encounter shared traffic, recognize one another's vehicles, and converge toward Hexaware.

The cars must feel powerful.
The city must feel alive.
The challenges must feel meaningful.
The suspense must feel cinematic.
The scoring must be fair.
The 60-minute event must run automatically.
The Welcome Convoy must bring every squad together.

**ONE MAP. ONE WORLD. 30 CARS. 120 PLAYERS. ONE DESTINATION.**

Build CODE REDLINE: ROAD TO HEXAWARE as a real playable multiplayer experience.
