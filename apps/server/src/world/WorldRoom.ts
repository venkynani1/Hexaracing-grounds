import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { events, eventStates, players, recoverySnapshots, vehicleCheckpoints, type DbHandle } from '@redline/db';
import { desc, inArray } from 'drizzle-orm';
import {
  BALANCE,
  beatsBetween,

  type ClockState,
  type EventStatus,
  forwardSpeed,
  sanitizeInput,
  type HostOverview,
  type InputMessage,
  type MapCar,
  type NetCar,
  type NetCarLite,
  type NetTraffic,
  type PhaseId,
  type Role,
  type Roster,
  type ServerMessage,
  type WorldStatus,
  type WorldState,
  TRAFFIC_TYPES,
  SQUAD_RUBRIC,
  CAR_FLAG_BRAKING,
  CAR_FLAG_GHOST,
} from '@redline/shared';
import { performance } from 'node:perf_hooks';
import { SIM_DT_MS, WorldSim, type SimCar } from './WorldSim';
import { EventClock, type ClockPersisted } from '../clock/EventClock';
import { conflict } from '../http/errors';
import { audit } from '../services/audit';
import type { PlayerRow, RegistrationService, TeamRow } from '../services/registration';
import type { SquadService } from '../squad/SquadService';
import type { Director } from '../director/Director';
import type { PitService } from '../pit/PitService';
import type { GateService } from '../gate/GateService';
import type { RivalService } from '../rival/RivalService';
import type { IntelService } from '../rival/IntelService';

export interface WorldRoomOptions {
  eventId: string;
  eventName: string;
  clock: EventClock;
  db: DbHandle;
  now?: () => number;
  sim: WorldSim;
  releaseAtMs?: number;
}

export type Tier = 'near' | 'mid' | 'far';
export const INTEREST = { hysteresis: 0.1, midEvery: 4 } as const;

export type ClientCtx =
  | { kind: 'pending'; connectedAt: number }
  | { kind: 'player'; playerId: string; teamId: string; role: Role }
  | { kind: 'host' };

/**
 * THE world. Exactly one instance exists per event (enforced below). Every connection — racer, role
 * clients, host, projector — attaches here. M2+ adds the vehicle/traffic simulation to this same object.
 */
export class WorldRoom {
  private static readonly live = new Map<string, WorldRoom>();

  /** Number of live rooms in this process (static check: must be ≤ 1 per event). */
  static liveRoomsFor(eventId: string): number {
    return WorldRoom.live.has(eventId) ? 1 : 0;
  }

  static create(opts: WorldRoomOptions): WorldRoom {
    if (WorldRoom.live.has(opts.eventId)) throw new Error(`WorldRoom already exists for event ${opts.eventId}: one world only`);
    const room = new WorldRoom(opts);
    WorldRoom.live.set(opts.eventId, room);
    return room;
  }

  readonly roomId = randomUUID();
  readonly eventId: string;
  readonly eventName: string;
  readonly clock: EventClock;
  readonly clients = new Map<WebSocket, ClientCtx>();
  private readonly connectedPlayers = new Map<string, number>();
  private readonly dbh: DbHandle;
  private readonly now: () => number;
  private registration!: RegistrationService;
  private lastStatus: EventStatus;
  private lastPhase: PhaseId | null;
  private lastElapsed: number;
  private directorTick = 0;
  private timer: NodeJS.Timeout | null = null;
  private overviewTimer: NodeJS.Timeout | null = null;
  private lastClockBroadcast = 0;
  private readonly bootedAt: number;
  private dbHealthy = true;
  private disposed = false;
  readonly sim: WorldSim;
  private readonly releaseAtMs: number;
  private worldTimer: NodeJS.Timeout | null = null;
  private lastWorldLoop = 0;
  private acc = 0;
  private loopCount = 0;
  private readonly tickDurations: number[] = [];
  private readonly stepTimes: number[] = [];
  /** Per-subscriber tier memory for hysteresis. */
  private readonly tiers = new WeakMap<WebSocket, Map<number, Tier>>();
  /** Total payload bytes sent on the world channel (bandwidth telemetry). */
  bytesOut = 0;

  private constructor(opts: WorldRoomOptions) {
    this.eventId = opts.eventId;
    this.eventName = opts.eventName;
    this.clock = opts.clock;
    this.dbh = opts.db;
    this.now = opts.now ?? Date.now;
    this.sim = opts.sim;
    this.releaseAtMs = opts.releaseAtMs ?? BALANCE.releaseAtMs;
    this.sim.onPenalty = (p) =>
      void audit(this.dbh.db, this.eventId, 'system', p.teamId, 'driving.ghost_out', p).catch(() => {});
    this.bootedAt = this.now();
    const t = this.now();
    this.lastStatus = this.clock.status(t);
    this.lastPhase = this.clock.snapshot(t).phase;
    this.lastElapsed = this.clock.started ? this.clock.elapsedMs(t) : -1;
  }

  attachRegistration(r: RegistrationService) {
    this.registration = r;
  }

  squad: SquadService | null = null;
  director: Director | null = null;
  pit: PitService | null = null;

  attachDirector(d: Director) {
    this.director = d;
  }

  attachPit(p: PitService) {
    this.pit = p;
  }

  intel: IntelService | null = null;
  attachIntel(i: IntelService) {
    this.intel = i;
  }

  rival: RivalService | null = null;
  attachRival(r: RivalService) {
    this.rival = r;
  }

  gate: GateService | null = null;
  attachGate(g: GateService) {
    this.gate = g;
    g.onConvoy = (timeline) => this.broadcastBound(JSON.stringify({ t: 'convoy', timeline } satisfies ServerMessage));
    g.onChampionship = (standings, computedAt) => this.broadcastBound(JSON.stringify({ t: 'championship', standings, computedAt } satisfies ServerMessage));
  }

  /** One serialized message to every bound client (players + hosts): identical payload, identical timestamps. */
  broadcastBound(data: string) {
    for (const [ws, ctx] of this.clients) if (ctx.kind !== 'pending' && ws.readyState === ws.OPEN) this.sendRaw(ws, data);
  }

  /** Late joiners / reconnects get the finale state too. */
  sendFinaleTo(ws: WebSocket) {
    if (this.gate?.timeline) this.sendRaw(ws, JSON.stringify({ t: 'convoy', timeline: this.gate.timeline } satisfies ServerMessage));
    if (this.gate?.standings) this.sendRaw(ws, JSON.stringify({ t: 'championship', standings: this.gate.standings, computedAt: this.gate.standingsAt } satisfies ServerMessage));
  }

  /** ONE global update: the same serialized world state goes to every connected client (players + hosts). */
  broadcastWorldState(state: WorldState) {
    const data = JSON.stringify({ t: 'world', state } satisfies ServerMessage);
    for (const [ws, ctx] of this.clients) if (ctx.kind !== 'pending' && ws.readyState === ws.OPEN) this.sendRaw(ws, data);
  }

  sendWorldStateTo(ws: WebSocket) {
    if (this.director) this.sendRaw(ws, JSON.stringify({ t: 'world', state: this.director.state } satisfies ServerMessage));
  }

  attachSquad(sq: SquadService) {
    this.squad = sq;
    sq.onTeamChanged = (teamId) => this.pushSquad(teamId);
  }

  /** Push each connected player its OWN role-filtered squad view (private clues never cross roles). */
  pushSquad(teamId: string | null) {
    if (!this.squad) return;
    for (const [ws, ctx] of this.clients) {
      if (ctx.kind !== 'player' || (teamId && ctx.teamId !== teamId) || ws.readyState !== ws.OPEN) continue;
      this.sendRaw(ws, JSON.stringify({ t: 'squad', view: this.squad.viewFor(ctx.teamId, ctx.role, ctx.playerId) } satisfies ServerMessage));
    }
  }

  sendSquadTo(ws: WebSocket) {
    const ctx = this.clients.get(ws);
    if (!this.squad || !ctx || ctx.kind !== 'player') return;
    this.sendRaw(ws, JSON.stringify({ t: 'squad', view: this.squad.viewFor(ctx.teamId, ctx.role, ctx.playerId) } satisfies ServerMessage));
  }

  /** Rehearsal/test only: jump the official clock forward (audit-logged; disabled unless configured). */
  async warp(toElapsedMs: number): Promise<ClockState> {
    try {
      this.clock.warpTo(this.now(), toElapsedMs);
    } catch (e) {
      throw conflict('CANNOT_WARP', (e as Error).message);
    }
    const snap = await this.afterControl('host:warp');
    await this.tick();
    return snap;
  }

  registrationOpen = (): boolean => !this.clock.started && this.clock.persisted.preStartStatus === 'REGISTRATION_OPEN';

  clockState(): ClockState {
    return this.clock.snapshot(this.now());
  }

  /* ---------------- Director loop ---------------- */

  startLoop(intervalMs: number) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => console.error('[director]', e)), intervalMs);
    this.timer.unref?.();
    this.lastWorldLoop = this.now();
    this.worldTimer = setInterval(() => {
      try {
        this.worldLoop();
      } catch (e) {
        console.error('[world]', e);
      }
    }, SIM_DT_MS);
    this.worldTimer.unref?.();
  }

  /* ---------------- World simulation loop (fixed 20 Hz) ---------------- */

  /** Spawn every registered squad's car (registration order). Called at START and on boot of a started event. */
  async spawnCars() {
    const teams = await this.registration.listTeams();
    this.sim.spawn(teams.map((t) => ({ teamId: t.id, name: t.name, vehicle: null, start: t.startCode })));
  }

  /* ---------------- recovery snapshots (M8, DESIGN §2) ---------------- */

  private lastSnapshotAt = 0;
  static readonly SNAPSHOT_INTERVAL_MS = 10_000;

  /** Full recoverable state of the ONE world. */
  buildSnapshot() {
    const t = this.now();
    return {
      v: 1,
      takenAt: t,
      elapsedMs: this.clock.elapsedMs(t),
      status: this.clock.status(t),
      lastElapsed: this.lastElapsed,
      directorTick: this.directorTick,
      sim: this.sim.snapshot(),
      squad: this.squad?.snapshot() ?? null,
      pit: this.pit?.snapshot() ?? null,
      director: this.director?.snapshot() ?? null,
      gate: this.gate?.snapshot() ?? null,
      rival: this.rival?.snapshot() ?? null,
      intel: this.intel?.snapshot() ?? null,
    };
  }

  async snapshotNow(cause = 'interval') {
    if (!this.clock.started) return null;
    const snap = this.buildSnapshot();
    this.lastSnapshotAt = this.now();
    await this.dbh.db.insert(recoverySnapshots).values({ eventId: this.eventId, tick: snap.sim.tick, phase: this.clock.snapshot(snap.takenAt).phase, state: { ...snap, cause } });
    // Keep the newest 50.
    const old = await this.dbh.db
      .select({ id: recoverySnapshots.id })
      .from(recoverySnapshots)
      .where(eq(recoverySnapshots.eventId, this.eventId))
      .orderBy(desc(recoverySnapshots.createdAt))
      .offset(50);
    if (old.length) await this.dbh.db.delete(recoverySnapshots).where(inArray(recoverySnapshots.id, old.map((o) => o.id)));
    return snap;
  }

  /**
   * Restore after a crash: the world comes back exactly as in the newest snapshot, PAUSED at its elapsed time
   * (RECOVERING → PAUSED); the host resumes. Clients rejoin to the same slots with their rejoin tokens.
   */
  async restoreFrom(snap: ReturnType<WorldRoom['buildSnapshot']>) {
    const t = this.now();
    this.clock.restorePausedAt(t, snap.elapsedMs);
    this.sim.restore(snap.sim);
    const teamIds = snap.sim.cars.map((c) => c.teamId);
    if (snap.squad && this.squad) await this.squad.restore(snap.squad, teamIds);
    if (snap.pit && this.pit) this.pit.restore(snap.pit);
    if (snap.gate && this.gate) {
      this.gate.activate(teamIds);
      this.gate.restore(snap.gate);
    }
    if (snap.director && this.director) this.director.restore(snap.director);
    if (snap.rival && this.rival) this.rival.restore(snap.rival);
    if (snap.intel && this.intel) this.intel.restore(snap.intel);
    this.lastElapsed = snap.lastElapsed;
    this.directorTick = snap.directorTick;
    const now = this.clock.snapshot(t);
    this.lastStatus = now.status;
    this.lastPhase = now.phase;
    await this.persist({ ...now, status: 'RECOVERING' }, `recovered_from_snapshot:tick=${snap.sim.tick}`);
    await this.persist(now, 'recovered:paused_for_host');
  }

  /** Persist checkpoint passes (idempotent: unique(team, checkpoint)). Live state stays in memory. */
  private async flushCheckpoints() {
    if (!this.sim.checkpointPasses.length) return;
    const passes = this.sim.checkpointPasses.splice(0);
    const elapsedMs = this.clock.elapsedMs(this.now());
    try {
      await this.dbh.db
        .insert(vehicleCheckpoints)
        .values(passes.map((p) => ({ teamId: p.teamId, checkpointId: p.checkpointId, tick: p.tick, elapsedMs, speed: p.speed })))
        .onConflictDoNothing();
      // DRIVING (DESIGN §8): 15 for reaching a checkpoint under own power + 10 if no ramming penalty since the last one.
      // Checkpoints passed during the disclosed escort score 0.
      for (const p of passes) {
        if (p.escorted || !this.squad) continue;
        const R = SQUAD_RUBRIC.driving;
        await this.squad.award(p.teamId, 'DRIVING', R.reach, `checkpoint ${p.index + 1} reached`, 'checkpoint_reach', p.checkpointId);
        if (p.clean) await this.squad.award(p.teamId, 'DRIVING', R.clean, `checkpoint ${p.index + 1}: clean driving`, 'checkpoint_clean', p.checkpointId);
      }
      for (const teamId of new Set(passes.map((p) => p.teamId))) this.pushSquad(teamId);
    } catch (e) {
      console.error('[checkpoints]', e);
    }
  }

  /**
   * One wall-clock loop iteration: run as many fixed 50 ms steps as are due (max 3 to avoid spirals),
   * only while LIVE, then stream snapshots. `forceSteps` lets tests drive the sim deterministically.
   */
  worldLoop(forceSteps?: number) {
    const t = this.now();
    const status = this.clock.status(t);
    this.sim.released = status === 'LIVE' && this.clock.elapsedMs(t) >= this.releaseAtMs;
    let steps = 0;
    if (forceSteps !== undefined) steps = status === 'LIVE' ? forceSteps : 0;
    else if (status === 'LIVE') {
      this.acc += t - this.lastWorldLoop;
      if (this.acc > 3 * SIM_DT_MS) this.acc = 3 * SIM_DT_MS;
      steps = Math.floor(this.acc / SIM_DT_MS);
      this.acc -= steps * SIM_DT_MS;
    } else this.acc = 0;
    this.lastWorldLoop = t;
    for (let i = 0; i < steps; i++) {
      const t0 = performance.now();
      this.sim.step();
      this.recordStep(performance.now() - t0, t);
    }
    if (steps > 0 && this.pit) void this.pit.tick().catch((e) => console.error('[pit]', e));
    if (steps > 0 && this.gate) void this.gate.tickWorld().catch((e) => console.error('[gate]', e));
    this.loopCount++;
    if (this.sim.checkpointPasses.length) void this.flushCheckpoints();
    this.broadcastWorld(steps > 0);
  }

  /** Every step duration since boot (bounded) — for whole-run p99 in load tests and the host metrics. */
  readonly allTickDurations: number[] = [];

  private recordStep(ms: number, wall: number) {
    if (this.allTickDurations.length < 200_000) this.allTickDurations.push(ms);
    this.tickDurations.push(ms);
    if (this.tickDurations.length > 400) this.tickDurations.shift();
    this.stepTimes.push(wall);
    while (this.stepTimes.length && wall - this.stepTimes[0]! > 2000) this.stepTimes.shift();
  }

  tickStats() {
    const sorted = [...this.tickDurations].sort((a, b) => a - b);
    const p99 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]! : 0;
    return { tickP99Ms: Math.round(p99 * 1000) / 1000, tickHz: this.stepTimes.length / 2 };
  }

  private netCar(c: SimCar): NetCar {
    const s = c.state;
    return {
      cid: c.cid,
      id: c.teamId,
      n: c.name,
      vc: c.params.code,
      x: r2(s.x),
      z: r2(s.z),
      h: r4(s.heading),
      vx: r2(s.vx),
      vz: r2(s.vz),
      f: r2(s.fuel),
      hp: r2(s.health),
      tr: r2(s.tires),
      ni: r2(s.nitro),
      br: c.braking,
      g: this.sim.isGhost(c),
      rs: this.sim.canReset(c),
      bf: this.sim.activeBuffs(c.teamId).map((b) => [b.kind, b.remainingMs] as [typeof b.kind, number]),
      cs: c.course,
      cp: c.nextCp,
      hd: !!c.held || !!c.auto,
      au: c.auto?.kind ?? '',
    };
  }

  private liteCar(c: SimCar): NetCarLite {
    const flags = (c.braking ? CAR_FLAG_BRAKING : 0) | (this.sim.isGhost(c) ? CAR_FLAG_GHOST : 0);
    return [c.cid, r2(c.state.x), r2(c.state.z), r4(c.state.heading), r2(forwardSpeed(c.state)), flags];
  }

  private mapCar(c: SimCar): MapCar {
    return [c.cid, c.teamId, c.name, r2(c.state.x), r2(c.state.z), r4(c.state.heading)];
  }

  /**
   * Interest tier of `other` as seen from `viewer`, with 10% hysteresis on both boundaries (DESIGN §5).
   * Near ≤ 300 m → every tick (20 Hz); Mid ≤ 1200 m → every 4th tick (5 Hz); Far → global map channel only (1 Hz).
   */
  private tierFor(viewerWs: WebSocket, viewer: SimCar, other: SimCar): Tier {
    let tiers = this.tiers.get(viewerWs);
    if (!tiers) this.tiers.set(viewerWs, (tiers = new Map()));
    const prev = tiers.get(other.cid) ?? 'far';
    const d = Math.hypot(other.state.x - viewer.state.x, other.state.z - viewer.state.z);
    const H = INTEREST.hysteresis;
    const near = BALANCE.nearRadius;
    const mid = BALANCE.midRadius;
    let next: Tier;
    if (prev === 'near') next = d <= near * (1 + H) ? 'near' : d <= mid * (1 + H) ? 'mid' : 'far';
    else if (prev === 'mid') next = d <= near ? 'near' : d <= mid * (1 + H) ? 'mid' : 'far';
    else next = d <= near ? 'near' : d <= mid ? 'mid' : 'far';
    tiers.set(other.cid, next);
    return next;
  }

  /**
   * Streams the ONE world to every subscriber with role-scoped interest management. Every squad car is
   * always in the world and always on the global map channel; tiers only change update rate.
   */
  private broadcastWorld(stepped: boolean) {
    if (!this.sim.cars.size) return;
    const tick = this.sim.tick;
    const every = (n: number) => (stepped ? tick % n === 0 : this.loopCount % n === 0);
    const racerFrame = stepped || this.loopCount % 4 === 0;
    const midFrame = stepped ? tick % INTEREST.midEvery === 0 : true;
    const roleFrame = every(4);
    const hostMapFrame = every(4);
    // During the Welcome Convoy every phone renders the parade from the map channel → 5 Hz for players too.
    const playerMapFrame = this.gate?.timeline ? every(4) : every(20);
    if (!racerFrame && !roleFrame && !hostMapFrame && !playerMapFrame) return;
    const serverTime = this.now();
    const cars = [...this.sim.cars.values()];
    let traffic: { id: number; type: keyof typeof TRAFFIC_TYPES; x: number; z: number; heading: number }[] | null = null;
    const nearR2 = BALANCE.nearRadius ** 2;
    let mapMsg: string | null = null;
    const map = () =>
      (mapMsg ??= JSON.stringify({ t: 'map', tick, serverTime, cars: cars.map((c) => this.mapCar(c)) } satisfies ServerMessage));
    for (const [ws, ctx] of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ctx.kind === 'host') {
        if (hostMapFrame) this.sendRaw(ws, map());
        continue;
      }
      if (ctx.kind !== 'player') continue;
      if (playerMapFrame) this.sendRaw(ws, map());
      const mine = this.sim.cars.get(ctx.teamId);
      if (!mine) continue;
      if (ctx.role === 'RACER') {
        if (!racerFrame) continue;
        traffic ??= this.sim.traffic.poses();
        const { x, z } = mine.state;
        const near: NetTraffic[] = [];
        for (const p of traffic) if ((p.x - x) ** 2 + (p.z - z) ** 2 <= nearR2) near.push([p.id, TRAFFIC_TYPES[p.type].code, r2(p.x), r2(p.z), r4(p.heading)]);
        const others: NetCarLite[] = [];
        for (const c of cars) {
          if (c === mine) continue;
          const tier = this.tierFor(ws, mine, c);
          if (tier === 'near' || (tier === 'mid' && midFrame)) others.push(this.liteCar(c));
        }
        const snap: ServerMessage = {
          t: 'snap',
          tick,
          simMs: this.sim.simMs,
          serverTime,
          rain: this.sim.rain,
          released: this.sim.released,
          ack: mine.ackSeq,
          me: this.netCar(mine),
          cars: others,
          traffic: near,
        };
        this.sendRaw(ws, JSON.stringify(snap));
      } else if (roleFrame) {
        this.sendRaw(ws, JSON.stringify({ t: 'car', tick, car: this.netCar(mine), released: this.sim.released } satisfies ServerMessage));
      }
    }
  }

  private sendRaw(ws: WebSocket, data: string) {
    this.bytesOut += data.length;
    ws.send(data);
  }

  /** Route a racer's input (plus redundant copies) to its squad car. Only the current RACER may drive. */
  handleInput(ws: WebSocket, msg: InputMessage): boolean {
    const ctx = this.clients.get(ws);
    if (!ctx || ctx.kind !== 'player' || ctx.role !== 'RACER') return false;
    const batch: { seq: number; input: ReturnType<typeof sanitizeInput> }[] = [];
    if (Array.isArray(msg.r)) {
      for (const r of msg.r.slice(0, 8)) {
        if (!Array.isArray(r) || r.length !== 5) continue;
        const [seq, st, th, br, fl] = r;
        batch.push({ seq: Number(seq), input: sanitizeInput({ steer: st, throttle: th, brake: br, nitro: (Number(fl) & 1) === 1, handbrake: (Number(fl) & 2) === 2 }) });
      }
    }
    batch.push({ seq: Number(msg.seq), input: sanitizeInput({ steer: msg.st, throttle: msg.th, brake: msg.br, nitro: msg.ni === true, handbrake: msg.hb === true }) });
    return this.sim.pushInputs(ctx.teamId, batch) > 0;
  }

  handleReset(ws: WebSocket): boolean {
    const ctx = this.clients.get(ws);
    if (!ctx || ctx.kind !== 'player' || ctx.role !== 'RACER') return false;
    const ok = this.sim.resetCar(ctx.teamId, 'player');
    if (ok) void audit(this.dbh.db, this.eventId, 'player', ctx.playerId, 'car.reset', { teamId: ctx.teamId, tick: this.sim.tick });
    return ok;
  }

  worldStatus(): WorldStatus {
    return {
      tick: this.sim.tick,
      simMs: this.sim.simMs,
      released: this.sim.released,
      rain: this.sim.rain,
      ...this.tickStats(),
      tickP99AllMs: (() => {
        const d = [...this.allTickDurations].sort((x, y) => x - y);
        return d.length ? Math.round(d[Math.min(d.length - 1, Math.floor(d.length * 0.99))]! * 1000) / 1000 : 0;
      })(),
      tickSamples: this.allTickDurations.length,
      clients: this.clients.size,
      bytesOut: this.bytesOut,
      trafficCount: this.sim.traffic.agents.length,
      penalties: [...this.sim.penalties],
      cars: [...this.sim.cars.values()].map((c) => ({
        cid: c.cid,
        ghost: this.sim.isGhost(c),
        teamId: c.teamId,
        name: c.name,
        x: r2(c.state.x),
        z: r2(c.state.z),
        heading: r4(c.state.heading),
        speed: r2(forwardSpeed(c.state)),
        fuel: r2(c.state.fuel),
        health: r2(c.state.health),
      })),
    };
  }

  /**
   * One Director step: detect status/phase transitions, fire scheduled beats exactly once,
   * persist transitions, broadcast the clock. Pure function of the clock + previous step.
   */
  async tick(): Promise<void> {
    const t = this.now();
    this.directorTick++;
    const snap = this.clock.snapshot(t);
    const changed = snap.status !== this.lastStatus || snap.phase !== this.lastPhase;
    if (this.clock.started && !this.clock.paused) {
      const elapsed = snap.status === 'COUNTDOWN' ? -1 : snap.elapsedMs;
      for (const beat of beatsBetween(this.lastElapsed, elapsed)) {
        // Seeded, bounded decision applied to the ONE world, then audit-logged.
        const decision = this.director ? this.director.fire(beat.id, beat.atMs) : 'none';
        await audit(this.dbh.db, this.eventId, 'director', null, 'beat.fire', { beat: beat.id, atMs: beat.atMs, elapsedMs: elapsed, decision });
      }
      this.lastElapsed = Math.max(this.lastElapsed, elapsed);
      if (elapsed >= 0) this.director?.update(elapsed);
    }
    if (this.squad) {
      await this.squad.onTick();
      this.squad.releaseFinishedSafeHolds();
    }
    if (this.gate && this.clock.started) await this.gate.onTick();
    if (this.rival && this.clock.started && !this.clock.paused) await this.rival.onTick();
    if (this.intel && this.clock.started && !this.clock.paused) await this.intel.onTick();
    if (this.clock.started && !this.clock.paused && this.now() - this.lastSnapshotAt >= WorldRoom.SNAPSHOT_INTERVAL_MS) await this.snapshotNow('interval');
    if (changed) {
      if (this.clock.started) void this.snapshotNow('transition').catch((e) => console.error('[snapshot]', e));
      const cause =
        snap.status !== this.lastStatus ? `status:${this.lastStatus}->${snap.status}` : `phase:${this.lastPhase}->${snap.phase}`;
      this.lastStatus = snap.status;
      this.lastPhase = snap.phase;
      await this.persist(snap, cause);
      this.broadcastAll({ t: 'clock', clock: snap });
      this.scheduleOverview();
    } else if (t - this.lastClockBroadcast >= 1000) {
      this.broadcastAll({ t: 'clock', clock: snap });
    }
  }

  private async persist(snap: ClockState, cause: string) {
    const p = this.clock.persisted;
    try {
      await this.dbh.db
        .update(events)
        .set({
          status: snap.status,
          startedAt: p.startedAt === null ? null : new Date(p.startedAt),
          pausedMs: p.pausedMs,
          pausedAt: p.pausedAt === null ? null : new Date(p.pausedAt),
        })
        .where(eq(events.id, this.eventId));
      await this.dbh.db.insert(eventStates).values({
        eventId: this.eventId,
        status: snap.status,
        phase: snap.phase,
        directorTick: this.directorTick,
        elapsedMs: snap.elapsedMs,
        transitionedAt: new Date(snap.serverTime),
        cause,
      });
      this.dbHealthy = true;
    } catch (e) {
      this.dbHealthy = false;
      throw e;
    }
  }

  /* ---------------- Host controls ---------------- */

  async start(opts: { force?: boolean } = {}): Promise<ClockState> {
    if (this.clock.started) throw conflict('ALREADY_STARTED', 'The event has already started');
    const ov = await this.overview();
    const blockers = opts.force ? ov.startBlockers.filter((b) => b === 'No squads registered') : ov.startBlockers;
    if (blockers.length) throw conflict('NOT_READY', blockers.join('; '));
    const t = this.now();
    // REGISTRATION_OPEN → REGISTRATION_LOCKED → COUNTDOWN, each transition recorded.
    this.clock.lockRegistration();
    await this.persist(this.clock.snapshot(t), 'host:start:lock_registration');
    await this.registration.autoAssignStarts(this.sim.map.starts.filter((s) => s.verified).map((s) => s.code));
    this.clock.start(t);
    await this.spawnCars();
    await this.squad?.activate([...this.sim.cars.keys()]);
    this.gate?.activate([...this.sim.cars.keys()]);
    const snap = this.clock.snapshot(t);
    await this.persist(snap, 'host:start:countdown');
    await audit(this.dbh.db, this.eventId, 'host', null, 'event.start', { force: !!opts.force, squads: ov.squadCount });
    this.lastStatus = snap.status;
    this.lastPhase = snap.phase;
    this.broadcastAll({ t: 'clock', clock: snap });
    this.scheduleOverview();
    return snap;
  }

  async pause(cause = 'host:pause'): Promise<ClockState> {
    const t = this.now();
    try {
      this.clock.pause(t);
    } catch (e) {
      throw conflict('CANNOT_PAUSE', (e as Error).message);
    }
    return this.afterControl(cause);
  }

  async resume(): Promise<ClockState> {
    const t = this.now();
    try {
      this.clock.resume(t);
    } catch (e) {
      throw conflict('CANNOT_RESUME', (e as Error).message);
    }
    return this.afterControl('host:resume');
  }

  private async afterControl(cause: string) {
    const snap = this.clock.snapshot(this.now());
    this.lastStatus = snap.status;
    this.lastPhase = snap.phase;
    await this.persist(snap, cause);
    await audit(this.dbh.db, this.eventId, cause.startsWith('host') ? 'host' : 'system', null, cause, { elapsedMs: snap.elapsedMs });
    this.broadcastAll({ t: 'clock', clock: snap });
    this.scheduleOverview();
    return snap;
  }

  /* ---------------- Connections ---------------- */

  bindPlayer(ws: WebSocket, playerId: string, teamId: string, role: Role) {
    this.clients.set(ws, { kind: 'player', playerId, teamId, role });
    // A newly bound Racer connection = a new input stream (page reload / rejoin / server restart).
    if (role === 'RACER') this.sim.resetInputStream(teamId);
    const n = (this.connectedPlayers.get(playerId) ?? 0) + 1;
    this.connectedPlayers.set(playerId, n);
    if (n === 1) void this.touchPlayer(playerId, true);
  }

  bindHost(ws: WebSocket) {
    this.clients.set(ws, { kind: 'host' });
  }

  /** Returns the teamId of a player whose last connection just closed (for roster refresh). */
  unbind(ws: WebSocket): string | null {
    const ctx = this.clients.get(ws);
    this.clients.delete(ws);
    if (!ctx || ctx.kind !== 'player') return null;
    const n = (this.connectedPlayers.get(ctx.playerId) ?? 1) - 1;
    if (n <= 0) {
      this.connectedPlayers.delete(ctx.playerId);
      void this.touchPlayer(ctx.playerId, false);
      return ctx.teamId;
    }
    this.connectedPlayers.set(ctx.playerId, n);
    return null;
  }

  isConnected(playerId: string) {
    return this.connectedPlayers.has(playerId);
  }

  private async touchPlayer(playerId: string, connected: boolean) {
    if (this.disposed) return;
    const at = new Date(this.now());
    try {
      await this.dbh.db
        .update(players)
        .set(connected ? { connectedAt: at, lastSeenAt: at } : { lastSeenAt: at })
        .where(eq(players.id, playerId));
    } catch {
      /* best effort; presence is in memory */
    }
  }

  send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  broadcastAll(msg: ServerMessage) {
    if (msg.t === 'clock') this.lastClockBroadcast = this.now();
    const data = JSON.stringify(msg);
    for (const [ws, ctx] of this.clients) if (ctx.kind !== 'pending' && ws.readyState === ws.OPEN) ws.send(data);
  }

  toRoster(team: TeamRow & { players: PlayerRow[] }): Roster {
    return {
      teamId: team.id,
      name: team.name,
      joinCode: team.joinCode,
      startLocation: team.startCode,
      full: team.players.length >= BALANCE.squadSize,
      players: team.players.map((p) => ({
        playerId: p.id,
        slot: p.slot,
        role: p.role,
        displayName: p.displayName,
        connected: this.isConnected(p.id),
      })),
    };
  }

  /** Push the latest roster to every connection of that squad (and refresh host views). */
  async broadcastRoster(teamId: string) {
    const team = await this.registration.getTeam(teamId);
    if (!team) return;
    // Keep connection roles current (Captain may reassign roles before START).
    for (const ctx of this.clients.values()) {
      if (ctx.kind === 'player' && ctx.teamId === teamId) {
        const p = team.players.find((x) => x.id === ctx.playerId);
        if (p) ctx.role = p.role;
      }
    }
    const data = JSON.stringify({ t: 'roster', roster: this.toRoster(team) } satisfies ServerMessage);
    for (const [ws, ctx] of this.clients) {
      if (ctx.kind === 'player' && ctx.teamId === teamId && ws.readyState === ws.OPEN) ws.send(data);
    }
    this.scheduleOverview();
  }

  /** Debounced host overview push. */
  scheduleOverview() {
    if (this.overviewTimer || this.disposed) return;
    this.overviewTimer = setTimeout(async () => {
      this.overviewTimer = null;
      const hosts = [...this.clients].filter(([, c]) => c.kind === 'host');
      if (!hosts.length) return;
      try {
        const data = JSON.stringify({ t: 'overview', overview: await this.overview() } satisfies ServerMessage);
        for (const [ws] of hosts) if (ws.readyState === ws.OPEN) ws.send(data);
      } catch (e) {
        console.error('[overview]', e);
      }
    }, 150);
  }

  async overview(): Promise<HostOverview> {
    const teams = await this.registration.listTeams();
    const squads = teams.map((t) => {
      const r = this.toRoster(t);
      return { ...r, ready: r.full };
    });
    const clock = this.clockState();
    const blockers: string[] = [];
    if (clock.status !== 'REGISTRATION_OPEN') blockers.push(`Event is ${clock.status}`);
    if (squads.length === 0) blockers.push('No squads registered');
    const incomplete = squads.filter((s) => !s.ready).length;
    if (incomplete) blockers.push(`${incomplete} squad(s) do not have four players`);
    const playerCount = squads.reduce((n, s) => n + s.players.length, 0);
    this.dbHealthy = await this.dbh.ping();
    return {
      eventId: this.eventId,
      eventName: this.eventName,
      clock,
      squads,
      squadCount: squads.length,
      playerCount,
      connectedCount: this.connectedPlayers.size,
      maxSquads: BALANCE.maxSquads,
      canStart: blockers.length === 0,
      startBlockers: blockers,
      health: { db: this.dbHealthy, ...this.tickStats(), uptimeS: Math.round((this.now() - this.bootedAt) / 1000) },
    };
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.worldTimer) clearInterval(this.worldTimer);
    this.worldTimer = null;
    if (this.overviewTimer) clearTimeout(this.overviewTimer);
    this.timer = null;
    for (const ws of this.clients.keys()) ws.terminate();
    this.clients.clear();
    WorldRoom.live.delete(this.eventId);
  }
}

/** Rebuild the clock from the persisted event row. A started, unfinished event comes back PAUSED (DESIGN §2 recovery). */
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

export function clockFromEventRow(
  row: { status: EventStatus; startedAt: Date | null; pausedMs: number; pausedAt: Date | null },
  now: number,
  countdownMs: number = BALANCE.countdownMs,
): { clock: EventClock; autoPaused: boolean } {
  const persisted: ClockPersisted = {
    startedAt: row.startedAt ? row.startedAt.getTime() : null,
    pausedMs: row.pausedMs,
    pausedAt: row.pausedAt ? row.pausedAt.getTime() : null,
    preStartStatus: row.status === 'DRAFT' ? 'DRAFT' : row.startedAt || row.status === 'REGISTRATION_LOCKED' ? 'REGISTRATION_LOCKED' : 'REGISTRATION_OPEN',
  };
  const clock = new EventClock(persisted, countdownMs);
  const s = clock.status(now);
  if (s === 'COUNTDOWN' || s === 'LIVE') {
    // We cannot know how long the server was down while "running"; freeze at the last persisted moment is
    // not available here, so pause now and let the host resume. Full snapshot recovery arrives in M8.
    clock.pause(now);
    return { clock, autoPaused: true };
  }
  return { clock, autoPaused: false };
}

