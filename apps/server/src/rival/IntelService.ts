/**
 * Levels 3–4 (24:00–42:00) — Deceiver intel ops and optional alliances. Automatic windows, server-authorized.
 *  - Signal jam: scrambles a rival's NAVIGATION DISPLAY for 20 s (information only: the car keeps driving, nobody is
 *    disconnected, no points are removed). Bounded: attacker cooldown, max jams per squad, target protection window,
 *    targets limited to ±3 ranks (no piling on the leader), never an ally. +5 DECEPTION per landed jam.
 *  - Shield: the target's Deceiver blocks incoming jams for 2 min (cooldown 6 min); a blocked jam gives the defender +5.
 *  - Alliance: both Captains must agree; one per squad; allies cannot jam each other. No points (no farming).
 */
import { inArray } from 'drizzle-orm';
import { teams as teamsTable, type Db } from '@redline/db';
import { INTEL, tieBreakHash, type IntelView, type Role } from '@redline/shared';
import { conflict, forbidden } from '../http/errors';
import { audit } from '../services/audit';
import type { Actor, SquadService } from '../squad/SquadService';

interface TeamIntel {
  jamsUsed: number;
  jamReadyAt: number;
  jammedUntil: number;
  protectedUntil: number;
  shieldUntil: number;
  shieldReadyAt: number;
  ally: string | null;
  proposalsFrom: string[];
  log: string[];
}

export class IntelService {
  private st = new Map<string, TeamIntel>();
  /** public ticker hook (projector/host) */
  onPublic: (kind: 'jam' | 'alliance', text: string) => void = () => {};
  private names = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly eventId: string,
    private readonly seed: string,
    private readonly squad: SquadService,
    private readonly elapsed: () => number,
  ) {}

  private t(id: string): TeamIntel {
    let x = this.st.get(id);
    if (!x) this.st.set(id, (x = { jamsUsed: 0, jamReadyAt: 0, jammedUntil: 0, protectedUntil: 0, shieldUntil: 0, shieldReadyAt: 0, ally: null, proposalsFrom: [], log: [] }));
    return x;
  }
  private open(el = this.elapsed()) {
    return el >= INTEL.opensAt && el < INTEL.closesAt;
  }
  private async loadNames() {
    const ids = this.squad.teamIds().filter((i) => !this.names.has(i));
    if (!ids.length) return;
    const rows = await this.db.select({ id: teamsTable.id, name: teamsTable.name }).from(teamsTable).where(inArray(teamsTable.id, ids));
    for (const r of rows) this.names.set(r.id, r.name);
  }
  private name(id: string) {
    return this.names.get(id) ?? 'Rival squad';
  }
  private note(id: string, msg: string) {
    const x = this.t(id);
    x.log.unshift(msg);
    x.log.length = Math.min(x.log.length, 6);
  }

  /** Squads within ±rankWindow places of `teamId` (score rank, tie hash), excluding itself and its ally. */
  private targetsFor(teamId: string): string[] {
    const ranked = this.squad.teamIds().sort((a, b) => this.squad.scoreOf(b).total - this.squad.scoreOf(a).total || tieBreakHash(this.seed, a).localeCompare(tieBreakHash(this.seed, b)));
    const i = ranked.indexOf(teamId);
    if (i < 0) return [];
    const ally = this.t(teamId).ally;
    return ranked.slice(Math.max(0, i - INTEL.jam.rankWindow), i + INTEL.jam.rankWindow + 1).filter((x) => x !== teamId && x !== ally);
  }

  /** Room tick: make squad names available once the intel window opens; push a refresh when jams expire. */
  private lastJamCheck = 0;
  async onTick() {
    const el = this.elapsed();
    if (el < INTEL.opensAt) return;
    if (this.names.size < this.squad.teamIds().length) await this.loadNames();
    for (const [id, x] of this.st) if (x.jammedUntil > this.lastJamCheck && x.jammedUntil <= el) this.squad.onTeamChanged(id);
    this.lastJamCheck = el;
  }

  async jam(actor: Actor, target: unknown) {
    if (actor.role !== 'DECEIVER') throw forbidden('DECEIVER_ONLY', 'Only the Deceiver runs intel ops');
    const el = this.elapsed();
    if (!this.open(el)) throw conflict('INTEL_CLOSED', 'Intel ops run during Levels 3–4 only');
    await this.loadNames();
    const me = this.t(actor.teamId);
    if (typeof target !== 'string' || !this.targetsFor(actor.teamId).includes(target)) throw conflict('BAD_TARGET', 'That squad is not a valid target (rank window, ally or yourself)');
    if (me.jamsUsed >= INTEL.jam.maxPerSquad) throw conflict('NO_JAMS_LEFT', 'No jams left');
    if (el < me.jamReadyAt) throw conflict('COOLDOWN', 'Jammer cooling down');
    const tgt = this.t(target);
    if (el < tgt.protectedUntil) throw conflict('TARGET_PROTECTED', 'That squad was jammed recently and is protected');
    me.jamsUsed++;
    me.jamReadyAt = el + INTEL.jam.cooldownMs;
    if (el < tgt.shieldUntil) {
      this.note(actor.teamId, `Jam on ${this.name(target)} was BLOCKED by their shield`);
      this.note(target, `Shield blocked a jam from ${this.name(actor.teamId)} (+${INTEL.shield.blockPoints})`);
      await this.squad.award(target, 'DECEPTION', INTEL.shield.blockPoints, 'Intel: jam blocked', 'intel_block', `block:${actor.teamId}:${me.jamsUsed}`);
      this.onPublic('jam', `${this.name(target)}'s shield blocks a jam from ${this.name(actor.teamId)}`);
      await audit(this.db, this.eventId, 'player', actor.playerId, 'intel.jam_blocked', { from: actor.teamId, to: target }).catch(() => undefined);
      this.push(actor.teamId, target);
      return { landed: false, blocked: true };
    }
    tgt.jammedUntil = el + INTEL.jam.durationMs;
    tgt.protectedUntil = el + INTEL.jam.targetProtectionMs;
    this.note(actor.teamId, `Jammed ${this.name(target)}'s navigation (+${INTEL.jam.points})`);
    this.note(target, `Navigation jammed by ${this.name(actor.teamId)} for ${INTEL.jam.durationMs / 1000} s`);
    await this.squad.award(actor.teamId, 'DECEPTION', INTEL.jam.points, 'Intel: jam landed', 'intel_jam', `jam:${actor.teamId}:${me.jamsUsed}`);
    this.onPublic('jam', `${this.name(actor.teamId)} jams ${this.name(target)}'s navigation`);
    await audit(this.db, this.eventId, 'player', actor.playerId, 'intel.jam', { from: actor.teamId, to: target }).catch(() => undefined);
    this.push(actor.teamId, target);
    return { landed: true, blocked: false, jammedForMs: INTEL.jam.durationMs };
  }

  shield(actor: Actor) {
    if (actor.role !== 'DECEIVER') throw forbidden('DECEIVER_ONLY', 'Only the Deceiver runs intel ops');
    const el = this.elapsed();
    if (!this.open(el)) throw conflict('INTEL_CLOSED', 'Intel ops run during Levels 3–4 only');
    const me = this.t(actor.teamId);
    if (el < me.shieldReadyAt) throw conflict('COOLDOWN', 'Shield recharging');
    me.shieldUntil = el + INTEL.shield.durationMs;
    me.shieldReadyAt = el + INTEL.shield.cooldownMs;
    this.note(actor.teamId, 'Counter-intel shield raised (2 min)');
    this.push(actor.teamId);
    return { shieldForMs: INTEL.shield.durationMs };
  }

  async propose(actor: Actor, target: unknown) {
    if (actor.role !== 'CAPTAIN') throw forbidden('CAPTAIN_ONLY', 'Only the Captain forms alliances');
    if (!this.open()) throw conflict('INTEL_CLOSED', 'Alliances form during Levels 3–4 only');
    await this.loadNames();
    if (typeof target !== 'string' || target === actor.teamId || !this.squad.teamIds().includes(target)) throw conflict('BAD_TARGET', 'Unknown squad');
    if (this.t(actor.teamId).ally || this.t(target).ally) throw conflict('ALREADY_ALLIED', 'One alliance per squad');
    const tgt = this.t(target);
    if (!tgt.proposalsFrom.includes(actor.teamId)) tgt.proposalsFrom.push(actor.teamId);
    this.note(target, `${this.name(actor.teamId)} proposes an alliance`);
    this.push(actor.teamId, target);
    return { proposed: true };
  }

  async accept(actor: Actor, from: unknown) {
    if (actor.role !== 'CAPTAIN') throw forbidden('CAPTAIN_ONLY', 'Only the Captain forms alliances');
    if (!this.open()) throw conflict('INTEL_CLOSED', 'Alliances form during Levels 3–4 only');
    const me = this.t(actor.teamId);
    if (typeof from !== 'string' || !me.proposalsFrom.includes(from)) throw conflict('NO_PROPOSAL', 'No such alliance proposal');
    const other = this.t(from);
    if (me.ally || other.ally) throw conflict('ALREADY_ALLIED', 'One alliance per squad');
    me.ally = from;
    other.ally = actor.teamId;
    me.proposalsFrom = [];
    other.proposalsFrom = other.proposalsFrom.filter((x) => x !== actor.teamId);
    this.note(actor.teamId, `Alliance formed with ${this.name(from)}`);
    this.note(from, `Alliance formed with ${this.name(actor.teamId)}`);
    this.onPublic('alliance', `Alliance formed: ${this.name(actor.teamId)} + ${this.name(from)}`);
    await audit(this.db, this.eventId, 'player', actor.playerId, 'intel.alliance', { a: actor.teamId, b: from }).catch(() => undefined);
    this.push(actor.teamId, from);
    return { ally: from };
  }

  viewFor(teamId: string, role: Role): IntelView | null {
    const el = this.elapsed();
    if (el < INTEL.opensAt) return null;
    const me = this.t(teamId);
    const nm = (id: string) => ({ teamId: id, name: this.name(id) });
    return {
      open: this.open(el),
      jammedForMs: Math.max(0, me.jammedUntil - el),
      shieldForMs: Math.max(0, me.shieldUntil - el),
      deceiver: role === 'DECEIVER' ? { targets: this.targetsFor(teamId).map(nm), jamsLeft: INTEL.jam.maxPerSquad - me.jamsUsed, jamReadyInMs: Math.max(0, me.jamReadyAt - el), shieldReadyInMs: Math.max(0, me.shieldReadyAt - el) } : null,
      ally: me.ally ? nm(me.ally) : null,
      alliance: role === 'CAPTAIN' ? { incoming: me.ally ? [] : me.proposalsFrom.map(nm), candidates: me.ally ? [] : this.squad.teamIds().filter((x) => x !== teamId && !this.t(x).ally).map(nm) } : null,
      log: me.log,
    };
  }

  snapshot() {
    return { st: [...this.st], names: [...this.names] };
  }
  restore(s: ReturnType<IntelService['snapshot']>) {
    this.st = new Map(s.st);
    this.names = new Map(s.names);
  }

  private push(...ids: string[]) {
    for (const id of ids) this.squad.onTeamChanged(id);
  }
}
