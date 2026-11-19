import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { events, eventStates, players, type DbHandle } from '@redline/db';
import {
  BALANCE,
  beatsBetween,

  type ClockState,
  type EventStatus,
  type HostOverview,
  type PhaseId,
  type Roster,
  type ServerMessage,
} from '@redline/shared';
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
}

export type ClientCtx =
  | { kind: 'pending'; connectedAt: number }
  | { kind: 'player'; playerId: string; teamId: string }
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

  private constructor(opts: WorldRoomOptions) {
    this.eventId = opts.eventId;
    this.eventName = opts.eventName;
    this.clock = opts.clock;
    this.dbh = opts.db;
    this.now = opts.now ?? Date.now;
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

  bindPlayer(ws: WebSocket, playerId: string, teamId: string) {
    this.clients.set(ws, { kind: 'player', playerId, teamId });
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
      health: { db: this.dbHealthy, tickHz: 0, uptimeS: Math.round((this.now() - this.bootedAt) / 1000) },
    };
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.overviewTimer) clearTimeout(this.overviewTimer);
    this.timer = null;
    for (const ws of this.clients.keys()) ws.terminate();
    this.clients.clear();
    WorldRoom.live.delete(this.eventId);
  }
}

/** Rebuild the clock from the persisted event row. A started, unfinished event comes back PAUSED (DESIGN §2 recovery). */
export function clockFromEventRow(
  row: { status: EventStatus; startedAt: Date | null; pausedMs: number; pausedAt: Date | null },
  now: number,
): { clock: EventClock; autoPaused: boolean } {
  const persisted: ClockPersisted = {
    startedAt: row.startedAt ? row.startedAt.getTime() : null,
    pausedMs: row.pausedMs,
    pausedAt: row.pausedAt ? row.pausedAt.getTime() : null,
    preStartStatus: row.status === 'DRAFT' ? 'DRAFT' : row.startedAt || row.status === 'REGISTRATION_LOCKED' ? 'REGISTRATION_LOCKED' : 'REGISTRATION_OPEN',
  };
  const clock = new EventClock(persisted);
  const s = clock.status(now);
  if (s === 'COUNTDOWN' || s === 'LIVE') {
    // We cannot know how long the server was down while "running"; freeze at the last persisted moment is
    // not available here, so pause now and let the host resume. Full snapshot recovery arrives in M8.
    clock.pause(now);
    return { clock, autoPaused: true };
  }
  return { clock, autoPaused: false };
}

