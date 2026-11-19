import { randomInt } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { events, players, sessions, teams, type Db, type Executor } from '@redline/db';
import {
  BALANCE,
  ROLES,
  ROLE_DEFAULT_SLOT,
  generateJoinCode,
  isRole,
  normalizeJoinCode,
  type Role,
  type RoleAssignment,
  type SessionResponse,
  type SquadPreview,
} from '@redline/shared';
import { randomSecret, sha256, type SessionClaims, type TokenSigner } from '../auth/tokens';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../http/errors';
import { audit } from './audit';

export interface TeamRow {
  id: string;
  name: string;
  joinCode: string;
}
export interface PlayerRow {
  id: string;
  teamId: string;
  slot: number;
  role: Role;
  displayName: string;
}

/** Trim, collapse whitespace, strip control chars; enforce length. */
export function cleanName(input: unknown, max: number, field: string): string {
  if (typeof input !== 'string') throw badRequest('INVALID_NAME', `${field} is required`);
  const s = input.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length < 1 || s.length > max) throw badRequest('INVALID_NAME', `${field} must be 1–${max} characters`);
  return s;
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
}

export class RegistrationService {
  constructor(
    private readonly db: Db,
    private readonly signer: TokenSigner,
    private readonly eventId: string,
    /** Returns true while registration is open (before START). */
    private readonly registrationOpen: () => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /* ------------ sessions ------------ */

  private async issueSession(tx: Executor, player: { id: string; teamId: string }, userAgent?: string) {
    const expiresAt = this.now() + BALANCE.sessionTtlMs;
    const sid = randomSecret(12);
    const token = this.signer.sign({ k: 'session', sid, pid: player.id, tid: player.teamId, eid: this.eventId, exp: expiresAt });
    await tx.insert(sessions).values({
      eventId: this.eventId,
      playerId: player.id,
      tokenHash: sha256(token),
      expiresAt: new Date(expiresAt),
      userAgent: userAgent?.slice(0, 200) ?? null,
    });
    return token;
  }

  private rejoinToken(playerId: string, secret: string) {
    return this.signer.sign({ k: 'rejoin', pid: playerId, eid: this.eventId, sec: secret });
  }

  /** Validate a session token: signature, expiry, event, and that the session row exists and is not revoked. */
  async authenticate(token: unknown): Promise<SessionClaims & { player: PlayerRow }> {
    const claims = this.signer.verify(token, 'session', this.now());
    if (!claims || claims.eid !== this.eventId) throw unauthorized('Invalid or expired session');
    const [row] = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, sha256(token as string)), isNull(sessions.revokedAt)))
      .limit(1);
    if (!row) throw unauthorized('Session revoked or unknown');
    const [p] = await this.db.select().from(players).where(eq(players.id, claims.pid)).limit(1);
    if (!p) throw unauthorized('Player not found');
    return { ...claims, player: p };
  }

  /* ------------ squads ------------ */

  async createSquad(input: { squadName: unknown; displayName: unknown }, meta: { userAgent?: string; ipHash?: string } = {}): Promise<SessionResponse> {
    const squadName = cleanName(input.squadName, BALANCE.squadNameMax, 'Squad name');
    const displayName = cleanName(input.displayName, BALANCE.displayNameMax, 'Your name');
    this.assertOpen();
    for (let attempt = 0; attempt < 5; attempt++) {
      const joinCode = generateJoinCode((n) => randomInt(n));
      try {
        return await this.db.transaction(async (tx) => {
          // Serialise squad creation per event so the capacity check is exact under concurrency.
          await tx.select({ id: events.id }).from(events).where(eq(events.id, this.eventId)).for('update');
          this.assertOpen();
          const [{ count }] = (await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(teams)
            .where(eq(teams.eventId, this.eventId))) as [{ count: number }];
          if (count >= BALANCE.maxSquads) throw conflict('EVENT_FULL', `All ${BALANCE.maxSquads} squads are registered`);
          const [taken] = await tx
            .select({ id: teams.id })
            .from(teams)
            .where(and(eq(teams.eventId, this.eventId), sql`lower(${teams.name}) = lower(${squadName})`))
            .limit(1);
          if (taken) throw conflict('SQUAD_NAME_TAKEN', 'That squad name is already taken');
          const [team] = await tx.insert(teams).values({ eventId: this.eventId, name: squadName, joinCode }).returning();
          const secret = randomSecret();
          const [player] = await tx
            .insert(players)
            .values({ teamId: team!.id, slot: ROLE_DEFAULT_SLOT.CAPTAIN, role: 'CAPTAIN', displayName, rejoinSecretHash: sha256(secret) })
            .returning();
          await audit(tx, this.eventId, 'player', player!.id, 'squad.create', { teamId: team!.id, squadName, joinCode }, meta.ipHash);
          return {
            sessionToken: await this.issueSession(tx, player!, meta.userAgent),
            rejoinToken: this.rejoinToken(player!.id, secret),
            playerId: player!.id,
            teamId: team!.id,
            joinCode,
            role: 'CAPTAIN' as Role,
            slot: player!.slot,
          };
        });
      } catch (e) {
        // Join-code collision (unique index) → retry with a fresh code. Name race → surface as taken.
        if (isUniqueViolation(e)) {
          const msg = String((e as Error).message ?? '') + String((e as { cause?: Error }).cause?.message ?? '');
          if (msg.includes('teams_event_name_uq')) throw conflict('SQUAD_NAME_TAKEN', 'That squad name is already taken');
          continue;
        }
        throw e;
      }
    }
    throw conflict('CODE_GENERATION_FAILED', 'Could not allocate a squad code, try again');
  }

  async previewSquad(code: unknown): Promise<SquadPreview> {
    const joinCode = normalizeJoinCode(code);
    if (!joinCode) throw notFound('UNKNOWN_CODE', 'No squad with that code');
    const team = await this.findTeamByCode(this.db, joinCode);
    if (!team) throw notFound('UNKNOWN_CODE', 'No squad with that code');
    const ps = await this.db.select({ role: players.role }).from(players).where(eq(players.teamId, team.id));
    const used = new Set(ps.map((p) => p.role));
    return { joinCode, name: team.name, freeRoles: ROLES.filter((r) => !used.has(r)), full: ps.length >= BALANCE.squadSize };
  }

  async joinSquad(
    input: { code: unknown; displayName: unknown; role: unknown },
    meta: { userAgent?: string; ipHash?: string } = {},
  ): Promise<SessionResponse> {
    const joinCode = normalizeJoinCode(input.code);
    if (!joinCode) throw notFound('UNKNOWN_CODE', 'No squad with that code');
    const displayName = cleanName(input.displayName, BALANCE.displayNameMax, 'Your name');
    if (!isRole(input.role)) throw badRequest('INVALID_ROLE', 'Choose a role');
    const role = input.role;
    this.assertOpen();
    try {
      return await this.db.transaction(async (tx) => {
        const team = await this.findTeamByCode(tx, joinCode, true);
        if (!team) throw notFound('UNKNOWN_CODE', 'No squad with that code');
        this.assertOpen();
        const existing = await tx.select().from(players).where(eq(players.teamId, team.id));
        if (existing.length >= BALANCE.squadSize) throw conflict('SQUAD_FULL', 'This squad already has four players');
        if (existing.some((p) => p.role === role)) throw conflict('ROLE_TAKEN', 'That role is already taken in this squad');
        const usedSlots = new Set(existing.map((p) => p.slot));
        const preferred = ROLE_DEFAULT_SLOT[role];
        const slot = usedSlots.has(preferred) ? [1, 2, 3, 4].find((s) => !usedSlots.has(s))! : preferred;
        const secret = randomSecret();
        const [player] = await tx
          .insert(players)
          .values({ teamId: team.id, slot, role, displayName, rejoinSecretHash: sha256(secret) })
          .returning();
        await audit(tx, this.eventId, 'player', player!.id, 'squad.join', { teamId: team.id, role, slot }, meta.ipHash);
        return {
          sessionToken: await this.issueSession(tx, player!, meta.userAgent),
          rejoinToken: this.rejoinToken(player!.id, secret),
          playerId: player!.id,
          teamId: team.id,
          joinCode,
          role,
          slot,
        };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('ROLE_TAKEN', 'That role or slot was just taken, pick another');
      throw e;
    }
  }

  /**
   * Captain-authorised role reassignment, before START only. `assignments` may cover any subset of the
   * squad; the resulting mapping must have unique roles and still contain a Captain.
   */
  async assignRoles(actorPlayerId: string, assignments: unknown): Promise<void> {
    if (!Array.isArray(assignments) || assignments.length === 0 || assignments.length > BALANCE.squadSize) {
      throw badRequest('INVALID_ASSIGNMENTS', 'Provide 1–4 role assignments');
    }
    const parsed: RoleAssignment[] = assignments.map((a) => {
      if (!a || typeof a.playerId !== 'string' || !isRole(a.role)) throw badRequest('INVALID_ASSIGNMENTS', 'Bad assignment');
      return { playerId: a.playerId, role: a.role };
    });
    if (!this.registrationOpen()) throw conflict('EVENT_STARTED', 'Roles are locked once the host presses START');
    await this.db.transaction(async (tx) => {
      const [actor] = await tx.select().from(players).where(eq(players.id, actorPlayerId)).limit(1);
      if (!actor) throw unauthorized();
      // Lock the team row: serialises role changes and joins for this squad.
      await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, actor.teamId)).for('update');
      if (!this.registrationOpen()) throw conflict('EVENT_STARTED', 'Roles are locked once the host presses START');
      const squad = await tx.select().from(players).where(eq(players.teamId, actor.teamId));
      const me = squad.find((p) => p.id === actorPlayerId)!;
      if (me.role !== 'CAPTAIN') throw forbidden('NOT_CAPTAIN', 'Only the Captain can change roles');
      const next = new Map(squad.map((p) => [p.id, p.role as Role]));
      for (const a of parsed) {
        if (!next.has(a.playerId)) throw forbidden('NOT_IN_SQUAD', 'Player is not in your squad');
        next.set(a.playerId, a.role);
      }
      const roles = [...next.values()];
      if (new Set(roles).size !== roles.length) throw conflict('DUPLICATE_ROLE', 'Each role can only be held by one player');
      if (!roles.includes('CAPTAIN')) throw conflict('NO_CAPTAIN', 'The squad must keep a Captain');
      const changed = squad.filter((p) => next.get(p.id) !== p.role);
      for (const p of changed) await tx.update(players).set({ role: next.get(p.id)! }).where(eq(players.id, p.id));
      await audit(tx, this.eventId, 'player', actorPlayerId, 'squad.roles', {
        teamId: actor.teamId,
        changes: changed.map((p) => ({ playerId: p.id, from: p.role, to: next.get(p.id) })),
      });
    });
  }

  /** Exchange a rejoin credential for a fresh session bound to the same player slot. */
  async rejoin(token: unknown, meta: { userAgent?: string; ipHash?: string } = {}): Promise<SessionResponse> {
    const claims = this.signer.verify(token, 'rejoin');
    if (!claims || claims.eid !== this.eventId) throw unauthorized('Invalid rejoin credential');
    const [p] = await this.db.select().from(players).where(eq(players.id, claims.pid)).limit(1);
    if (!p || p.rejoinSecretHash !== sha256(claims.sec)) throw unauthorized('Invalid rejoin credential');
    const [team] = await this.db.select().from(teams).where(eq(teams.id, p.teamId)).limit(1);
    const sessionToken = await this.db.transaction(async (tx) => {
      await audit(tx, this.eventId, 'player', p.id, 'session.rejoin', null, meta.ipHash);
      return this.issueSession(tx, p, meta.userAgent);
    });
    return {
      sessionToken,
      rejoinToken: token as string,
      playerId: p.id,
      teamId: p.teamId,
      joinCode: team!.joinCode,
      role: p.role,
      slot: p.slot,
    };
  }

  /* ------------ reads ------------ */

  async listTeams(): Promise<(TeamRow & { players: PlayerRow[] })[]> {
    const ts = await this.db
      .select({ id: teams.id, name: teams.name, joinCode: teams.joinCode })
      .from(teams)
      .where(eq(teams.eventId, this.eventId))
      .orderBy(asc(teams.createdAt));
    const ps = ts.length
      ? await this.db
          .select({ id: players.id, teamId: players.teamId, slot: players.slot, role: players.role, displayName: players.displayName })
          .from(players)
          .innerJoin(teams, eq(players.teamId, teams.id))
          .where(eq(teams.eventId, this.eventId))
      : [];
    return ts.map((t) => ({ ...t, players: ps.filter((p) => p.teamId === t.id).sort((a, b) => a.slot - b.slot) }));
  }

  async getTeam(teamId: string): Promise<(TeamRow & { players: PlayerRow[] }) | null> {
    const [t] = await this.db
      .select({ id: teams.id, name: teams.name, joinCode: teams.joinCode })
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.eventId, this.eventId)))
      .limit(1);
    if (!t) return null;
    const ps = await this.db
      .select({ id: players.id, teamId: players.teamId, slot: players.slot, role: players.role, displayName: players.displayName })
      .from(players)
      .where(eq(players.teamId, teamId))
      .orderBy(asc(players.slot));
    return { ...t, players: ps };
  }

  private async findTeamByCode(db: Executor, joinCode: string, forUpdate = false) {
    const q = db
      .select({ id: teams.id, name: teams.name, joinCode: teams.joinCode })
      .from(teams)
      .where(and(eq(teams.eventId, this.eventId), eq(teams.joinCode, joinCode)))
      .limit(1);
    const [t] = forUpdate ? await q.for('update') : await q;
    return t ?? null;
  }

  private assertOpen() {
    if (!this.registrationOpen()) throw conflict('REGISTRATION_CLOSED', 'Registration is closed — the event has started');
  }
}
