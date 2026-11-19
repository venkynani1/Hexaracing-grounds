import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { events, eventStates, players, type DbHandle } from '@redline/db';
import {
  BALANCE,
  beatsBetween,

  type ClockState,
  type EventStatus,
  forwardSpeed,
  sanitizeInput,
  type HostOverview,
  type InputMessage,
  type NetCar,
  type NetCarLite,
  type NetTraffic,
  type PhaseId,
  type Role,
  type Roster,
  type ServerMessage,
  type WorldStatus,
  TRAFFIC_TYPES,
} from '@redline/shared';
import { performance } from 'node:perf_hooks';
import { SIM_DT_MS, WorldSim, type SimCar } from './WorldSim';
import { EventClock, type ClockPersisted } from '../clock/EventClock';
import { conflict } from '../http/errors';
import { audit } from '../services/audit';
import type { PlayerRow, RegistrationService, TeamRow } from '../services/registration';

export interface WorldRoomOptions {
  eventId: string;
  eventName: string;
  clock: EventClock;
  db: DbHandle;
  now?: () => number;
  sim: WorldSim;
  releaseAtMs?: number;
}

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

  private constructor(opts: WorldRoomOptions) {
    this.eventId = opts.eventId;
    this.eventName = opts.eventName;
    this.clock = opts.clock;
    this.dbh = opts.db;
    this.now = opts.now ?? Date.now;
    this.sim = opts.sim;
    this.releaseAtMs = opts.releaseAtMs ?? BALANCE.releaseAtMs;
    this.bootedAt = this.now();
    const t = this.now();
    this.lastStatus = this.clock.status(t);
    this.lastPhase = this.clock.snapshot(t).phase;
    this.lastElapsed = this.clock.started ? this.clock.elapsedMs(t) : -1;
  }

  attachRegistration(r: RegistrationService) {
    this.registration = r;
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
    this.sim.spawn(teams.map((t) => ({ teamId: t.id, name: t.name, vehicle: null })));
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
    this.loopCount++;
    this.broadcastWorld(steps > 0);
  }

  private recordStep(ms: number, wall: number) {
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
    return { id: c.teamId, n: c.name, x: r2(s.x), z: r2(s.z), h: r4(s.heading), vx: r2(s.vx), vz: r2(s.vz), f: r2(s.fuel), hp: r2(s.health), tr: r2(s.tires), ni: r2(s.nitro), br: c.braking };
  }

  private liteCar(c: SimCar): NetCarLite {
    return [c.teamId, c.name, r2(c.state.x), r2(c.state.z), r4(c.state.heading), r2(forwardSpeed(c.state)), c.braking ? 1 : 0];
  }

  /**
   * Interest management (M2 baseline; M3 adds tiers + hysteresis): racers get their own car + squad cars
   * within the mid radius + traffic within the near radius every tick; role clients get their squad car at 5 Hz;
   * hosts get every car at 2 Hz. Every car stays in the world regardless of who can see it.
   */
  private broadcastWorld(stepped: boolean) {
    if (!this.sim.cars.size) return;
    const racerTick = stepped || this.loopCount % 4 === 0;
    const roleTick = this.loopCount % 4 === 0;
    const hostTick = this.loopCount % 10 === 0;
    if (!racerTick && !roleTick && !hostTick) return;
    const serverTime = this.now();
    const cars = [...this.sim.cars.values()];
    let traffic: { id: number; type: keyof typeof TRAFFIC_TYPES; x: number; z: number; heading: number }[] | null = null;
    const nearR2 = BALANCE.nearRadius ** 2;
    const midR2 = BALANCE.midRadius ** 2;
    let hostMsg: string | null = null;
    for (const [ws, ctx] of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ctx.kind === 'host') {
        if (!hostTick) continue;
        hostMsg ??= JSON.stringify({ t: 'cars', tick: this.sim.tick, cars: cars.map((c) => this.liteCar(c)) } satisfies ServerMessage);
        ws.send(hostMsg);
        continue;
      }
      if (ctx.kind !== 'player') continue;
      const mine = this.sim.cars.get(ctx.teamId);
      if (!mine) continue;
      if (ctx.role === 'RACER') {
        if (!racerTick) continue;
        traffic ??= this.sim.traffic.poses();
        const { x, z } = mine.state;
        const near: NetTraffic[] = [];
        for (const p of traffic) if ((p.x - x) ** 2 + (p.z - z) ** 2 <= nearR2) near.push([p.id, TRAFFIC_TYPES[p.type].code, r2(p.x), r2(p.z), r4(p.heading)]);
        const others: NetCarLite[] = [];
        for (const c of cars) if (c !== mine && (c.state.x - x) ** 2 + (c.state.z - z) ** 2 <= midR2) others.push(this.liteCar(c));
        const snap: ServerMessage = {
          t: 'snap',
          tick: this.sim.tick,
          simMs: this.sim.simMs,
          serverTime,
          rain: this.sim.rain,
          released: this.sim.released,
          ack: mine.ackSeq,
          me: this.netCar(mine),
          cars: others,
          traffic: near,
        };
        ws.send(JSON.stringify(snap));
      } else if (roleTick) {
        ws.send(JSON.stringify({ t: 'car', tick: this.sim.tick, car: this.netCar(mine), released: this.sim.released } satisfies ServerMessage));
      }
    }
  }

  /** Route a racer's input to its squad car. Only the current RACER of that squad may drive. */
  handleInput(ws: WebSocket, msg: InputMessage): boolean {
    const ctx = this.clients.get(ws);
    if (!ctx || ctx.kind !== 'player' || ctx.role !== 'RACER') return false;
    return this.sim.pushInput(ctx.teamId, msg.seq, sanitizeInput({ steer: msg.st, throttle: msg.th, brake: msg.br, nitro: msg.ni === true, handbrake: msg.hb === true }));
  }

  worldStatus(): WorldStatus {
    return {
      tick: this.sim.tick,
      simMs: this.sim.simMs,
      released: this.sim.released,
      rain: this.sim.rain,
      ...this.tickStats(),
      trafficCount: this.sim.traffic.agents.length,
      cars: [...this.sim.cars.values()].map((c) => ({
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
        await audit(this.dbh.db, this.eventId, 'director', null, 'beat.fire', { beat: beat.id, atMs: beat.atMs, elapsedMs: elapsed });
      }
      this.lastElapsed = Math.max(this.lastElapsed, elapsed);
    }
    if (changed) {
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
    this.clock.start(t);
    await this.spawnCars();
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

