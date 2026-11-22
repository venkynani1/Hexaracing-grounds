/**
 * Level 4 — Trade & Collaborate. Fully automatic once the host has pressed START:
 *  - 33:00 matchmaking: squads ranked by current score (tie: tieBreakHash), adjacent ranks paired; an odd squad gets a
 *    fair solo route (solo duel + depot). Deterministic and audit-logged.
 *  - 33:00–37:00 duel: both Captains answer the same server-only question; first correct wins. Bounded attempts.
 *  - 33:00–42:00 trades: Captain proposes credits / fuel / nitro to the partner; the partner's Captain must accept.
 *    Acceptance re-checks both balances and applies both sides in one synchronous step (single event loop → atomic),
 *    then writes an idempotent ledger row per squad. Bounded amounts; fuel never drops below the floor.
 *  - Depot: every squad may exchange once with the neutral depot (solo path when no rival trades).
 * Points: CAPTAIN_STRATEGY (category cap applies), sourceIds make every award idempotent.
 */
import { createHash } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { fuelTransactions, teams as teamsTable, type Db } from '@redline/db';
import { RIVAL, tieBreakHash, type Role, type RivalView, type TradeItem, type TradeKind, type TradeOfferView } from '@redline/shared';
import { badRequest, conflict, forbidden } from '../http/errors';
import { audit } from '../services/audit';
import type { Actor, SquadService } from '../squad/SquadService';
import type { WorldSim } from '../world/WorldSim';
import { duelQuestion } from './content';

type DuelResult = 'pending' | 'won' | 'second' | 'solo' | 'lost' | 'failed';
interface DuelState {
  attempts: number;
  result: DuelResult;
  points: number;
}
interface Offer {
  id: string;
  from: string;
  to: string;
  give: TradeItem;
  want: TradeItem;
  status: TradeOfferView['status'];
  createdMs: number;
  note?: string;
}
interface Pair {
  id: string;
  a: string;
  b: string | null;
}

const KINDS: TradeKind[] = ['credits', 'fuel', 'nitro'];

export class RivalService {
  private pairs: Pair[] = [];
  private partner = new Map<string, string | null>();
  private pairOf = new Map<string, string>();
  private names = new Map<string, string>();
  private duels = new Map<string, DuelState>();
  private offers: Offer[] = [];
  private completedPairs = new Set<string>();
  private depotUsed = new Set<string>();
  private keys = new Map<string, unknown>();
  private matched = false;
  /** public ticker hook (projector/host); never answers */
  onPublic: (kind: 'duel' | 'trade' | 'info', text: string) => void = () => {};

  constructor(
    private readonly db: Db,
    private readonly eventId: string,
    private readonly seed: string,
    private readonly sim: WorldSim,
    private readonly squad: SquadService,
    private readonly elapsed: () => number,
  ) {}

  /* ---------------------------------------------------------------- director hook */

  async onTick() {
    const el = this.elapsed();
    if (!this.matched && el >= RIVAL.duelOpensAt && el < RIVAL.tradeClosesAt) await this.match();
    if (!this.matched) return;
    let changed = false;
    for (const o of this.offers)
      if (o.status === 'open' && (el >= RIVAL.tradeClosesAt || el - o.createdMs > RIVAL.limits.offerTtlMs)) {
        o.status = 'expired';
        changed = true;
      }
    if (el >= RIVAL.duelClosesAt)
      for (const d of this.duels.values())
        if (d.result === 'pending') {
          d.result = 'failed';
          changed = true;
        }
    if (changed) this.squad.onTeamChanged(null);
  }

  /** Deterministic matchmaking (score rank, tie hash). Idempotent: runs once per event. */
  async match() {
    if (this.matched) return;
    this.matched = true;
    const ids = this.squad.teamIds();
    if (ids.length) {
      const rows = await this.db.select({ id: teamsTable.id, name: teamsTable.name }).from(teamsTable).where(inArray(teamsTable.id, ids));
      for (const r of rows) this.names.set(r.id, r.name);
    }
    const ranked = [...ids].sort((x, y) => this.squad.scoreOf(y).total - this.squad.scoreOf(x).total || tieBreakHash(this.seed, x).localeCompare(tieBreakHash(this.seed, y)));
    for (let i = 0; i < ranked.length; i += 2) {
      const a = ranked[i]!;
      const b = ranked[i + 1] ?? null;
      const id = createHash('sha256').update(`${this.seed}:${a}:${b ?? 'solo'}`).digest('hex').slice(0, 12);
      this.pairs.push({ id, a, b });
      this.partner.set(a, b);
      this.pairOf.set(a, id);
      if (b) (this.partner.set(b, a), this.pairOf.set(b, id));
    }
    for (const t of ids) this.duels.set(t, { attempts: 0, result: 'pending', points: 0 });
    this.onPublic('duel', `Level 4 rival round: ${this.pairs.filter((p) => p.b).length} duels${this.pairs.some((p) => !p.b) ? ' + 1 solo route' : ''} — Captains, first correct answer wins`);
    await audit(this.db, this.eventId, 'director', null, 'rival.match', { pairs: this.pairs.map((p) => [p.a, p.b]) }).catch(() => undefined);
    this.squad.onTeamChanged(null);
  }

  /* ---------------------------------------------------------------- duel */

  async duelAnswer(actor: Actor, answer: unknown, key: unknown) {
    this.captainOnly(actor);
    const k = `duel:${actor.teamId}:${String(key ?? '')}`;
    if (key && this.keys.has(k)) return this.keys.get(k);
    const el = this.elapsed();
    if (!this.matched || el < RIVAL.duelOpensAt || el >= RIVAL.duelClosesAt) throw conflict('DUEL_CLOSED', 'The duel window is not open');
    const d = this.duels.get(actor.teamId);
    if (!d) throw conflict('NOT_MATCHED', 'Your squad is not in this round');
    if (d.result !== 'pending') throw conflict('DUEL_DONE', 'Your squad already finished this duel');
    if (typeof answer !== 'string' || !answer) throw badRequest('BAD_REQUEST', 'answer required');
    const pairId = this.pairOf.get(actor.teamId)!;
    const q = duelQuestion(this.seed, pairId);
    d.attempts++;
    let res: { correct: boolean; result: DuelResult; points: number };
    if (answer.trim() === q.answer) {
      const p = this.partner.get(actor.teamId);
      const rivalWon = p ? this.duels.get(p)?.result === 'won' : false;
      d.result = !p ? 'solo' : rivalWon ? 'second' : 'won';
      d.points = d.result === 'won' ? RIVAL.points.duelWin : d.result === 'second' ? RIVAL.points.duelSecond : RIVAL.points.duelSolo;
      await this.squad.award(actor.teamId, 'CAPTAIN_STRATEGY', d.points, `Rival duel (${d.result})`, 'rival_duel', `duel:${pairId}:${actor.teamId}`);
      res = { correct: true, result: d.result, points: d.points };
      const p2 = this.partner.get(actor.teamId);
      if (d.result === 'won' && p2) this.onPublic('duel', `${this.names.get(actor.teamId) ?? 'A squad'} wins the duel against ${this.names.get(p2) ?? 'their rival'}`);
    } else {
      if (d.attempts >= RIVAL.duelMaxAttempts) d.result = 'lost';
      res = { correct: false, result: d.result, points: 0 };
    }
    if (key) this.keys.set(k, res);
    this.notifyPair(actor.teamId);
    return res;
  }

  /* ---------------------------------------------------------------- trades */

  async offer(actor: Actor, give: unknown, want: unknown, key: unknown) {
    this.captainOnly(actor);
    const k = `offer:${actor.teamId}:${String(key ?? '')}`;
    if (key && this.keys.has(k)) return this.keys.get(k);
    this.tradeWindow();
    const to = this.partner.get(actor.teamId);
    if (!to) throw conflict('NO_PARTNER', 'Your squad has no trade partner this round — use the depot');
    const pairId = this.pairOf.get(actor.teamId)!;
    if (this.completedPairs.has(pairId)) throw conflict('TRADE_DONE', 'Your pair already completed its trade');
    const g = this.item(give);
    const w = this.item(want);
    if (g.kind === w.kind) throw badRequest('BAD_REQUEST', 'Give and want must be different resources');
    if (!this.canGive(actor.teamId, g)) throw conflict('NOT_ENOUGH', `Not enough ${g.kind} to offer that`);
    if (this.offers.filter((o) => o.from === actor.teamId && o.status === 'open').length >= RIVAL.limits.openOffers) throw conflict('TOO_MANY_OFFERS', 'Too many open offers');
    const o: Offer = { id: createHash('sha256').update(`${pairId}:${actor.teamId}:${this.offers.length}:${String(key ?? Math.random())}`).digest('hex').slice(0, 12), from: actor.teamId, to, give: g, want: w, status: 'open', createdMs: this.elapsed() };
    this.offers.push(o);
    const res = { offerId: o.id };
    if (key) this.keys.set(k, res);
    this.notifyPair(actor.teamId);
    return res;
  }

  async respond(actor: Actor, offerId: unknown, accept: unknown) {
    this.captainOnly(actor);
    const o = this.offers.find((x) => x.id === offerId);
    if (!o || o.to !== actor.teamId) throw forbidden('NOT_YOUR_OFFER', 'That offer is not addressed to your squad');
    if (o.status !== 'open') return { status: o.status };
    this.tradeWindow();
    if (accept !== true) {
      o.status = 'declined';
      this.notifyPair(actor.teamId);
      return { status: o.status };
    }
    const pairId = this.pairOf.get(actor.teamId)!;
    // atomic section: no await between the checks and the application
    if (this.completedPairs.has(pairId) || !this.canGive(o.from, o.give) || !this.canGive(o.to, o.want)) {
      o.status = 'failed';
      o.note = 'A squad no longer had enough resources';
      this.notifyPair(actor.teamId);
      return { status: o.status, note: o.note };
    }
    this.apply(o.from, o.give, -1);
    this.apply(o.to, o.give, +1);
    this.apply(o.to, o.want, -1);
    this.apply(o.from, o.want, +1);
    o.status = 'accepted';
    this.completedPairs.add(pairId);
    for (const x of this.offers) if (x.status === 'open' && this.pairOf.get(x.from) === pairId) x.status = 'expired';
    await this.ledger(o.from, o.give, o.want, `trade:${o.id}:${o.from}`);
    await this.ledger(o.to, o.want, o.give, `trade:${o.id}:${o.to}`);
    for (const t of [o.from, o.to]) await this.squad.award(t, 'CAPTAIN_STRATEGY', RIVAL.points.trade, 'Rival trade completed', 'rival_trade', `trade:${pairId}:${t}`);
    this.onPublic('trade', `Trade sealed: ${this.names.get(o.from) ?? 'a squad'} ⇄ ${this.names.get(o.to) ?? 'a squad'}`);
    await audit(this.db, this.eventId, 'player', actor.playerId, 'rival.trade', { offer: o.id, from: o.from, to: o.to, give: o.give, want: o.want }).catch(() => undefined);
    this.notifyPair(actor.teamId);
    return { status: o.status };
  }

  /** Neutral depot: once per squad during the trade window (solo progression path). */
  async depot(actor: Actor, option: unknown) {
    this.captainOnly(actor);
    this.tradeWindow();
    if (this.depotUsed.has(actor.teamId)) return { status: 'already-used' };
    const opt = option === 'fuel' ? 'fuel' : option === 'nitro' ? 'nitro' : null;
    if (!opt) throw badRequest('BAD_REQUEST', 'option must be fuel or nitro');
    const cost = RIVAL.depot[opt].credits;
    if (this.squad.credits(actor.teamId) < cost) throw conflict('NOT_ENOUGH', 'Not enough credits for the depot');
    const gain: TradeItem = opt === 'fuel' ? { kind: 'fuel', amount: RIVAL.depot.fuel.fuel } : { kind: 'nitro', amount: RIVAL.depot.nitro.nitro };
    this.depotUsed.add(actor.teamId);
    this.apply(actor.teamId, { kind: 'credits', amount: cost }, -1);
    this.apply(actor.teamId, gain, +1);
    await this.ledger(actor.teamId, { kind: 'credits', amount: cost }, gain, `depot:${actor.teamId}`);
    await this.squad.award(actor.teamId, 'CAPTAIN_STRATEGY', RIVAL.points.depot, 'Depot logistics', 'rival_depot', `depot:${actor.teamId}`);
    this.squad.onTeamChanged(actor.teamId);
    return { status: 'ok', gained: gain };
  }

  /* ---------------------------------------------------------------- view (role-scoped) */

  viewFor(teamId: string, role: Role): RivalView | null {
    if (!this.matched || !this.duels.has(teamId)) return null;
    const el = this.elapsed();
    const window: RivalView['window'] = el < RIVAL.duelOpensAt ? 'upcoming' : el < RIVAL.duelClosesAt ? 'duel' : el < RIVAL.tradeClosesAt ? 'trade' : 'closed';
    const p = this.partner.get(teamId) ?? null;
    const d = this.duels.get(teamId)!;
    const q = duelQuestion(this.seed, this.pairOf.get(teamId)!);
    const cap = role === 'CAPTAIN';
    const pd = p ? this.duels.get(p) : null;
    return {
      window,
      duelOpensAt: RIVAL.duelOpensAt,
      duelClosesAt: RIVAL.duelClosesAt,
      tradeClosesAt: RIVAL.tradeClosesAt,
      partner: p ? { teamId: p, name: this.names.get(p) ?? 'Rival squad' } : null,
      duel: {
        // the answer never leaves the server; only the Captain sees the question + options
        prompt: cap ? q.prompt : 'Your Captain is in a rival duel — help with the maths!',
        options: cap ? q.options : null,
        attempts: d.attempts,
        maxAttempts: RIVAL.duelMaxAttempts,
        result: d.result,
        points: d.points,
        partnerSolved: !!pd && (pd.result === 'won' || pd.result === 'second'),
      },
      trade: {
        offers: this.offers
          .filter((o) => o.from === teamId || o.to === teamId)
          .map((o) => ({ id: o.id, from: o.from === teamId ? 'us' : 'them', give: o.give, want: o.want, status: o.status, note: o.note, expiresInMs: Math.max(0, RIVAL.limits.offerTtlMs - (el - o.createdMs)) })),
        completed: this.completedPairs.has(this.pairOf.get(teamId)!),
        depotUsed: this.depotUsed.has(teamId),
        canAct: cap && el >= RIVAL.duelOpensAt && el < RIVAL.tradeClosesAt,
      },
    };
  }

  /* ---------------------------------------------------------------- persistence */

  snapshot() {
    return { matched: this.matched, pairs: this.pairs, names: [...this.names], duels: [...this.duels], offers: this.offers, completedPairs: [...this.completedPairs], depotUsed: [...this.depotUsed] };
  }

  restore(s: ReturnType<RivalService['snapshot']>) {
    this.matched = s.matched;
    this.pairs = s.pairs;
    this.partner.clear();
    this.pairOf.clear();
    for (const p of s.pairs) {
      this.partner.set(p.a, p.b);
      this.pairOf.set(p.a, p.id);
      if (p.b) (this.partner.set(p.b, p.a), this.pairOf.set(p.b, p.id));
    }
    this.names = new Map(s.names);
    this.duels = new Map(s.duels);
    this.offers = s.offers;
    this.completedPairs = new Set(s.completedPairs);
    this.depotUsed = new Set(s.depotUsed);
  }

  /* ---------------------------------------------------------------- helpers */

  private captainOnly(actor: Actor) {
    if (actor.role !== 'CAPTAIN') throw forbidden('CAPTAIN_ONLY', 'Only the Captain can do that');
  }

  private tradeWindow() {
    const el = this.elapsed();
    if (!this.matched || el < RIVAL.duelOpensAt || el >= RIVAL.tradeClosesAt) throw conflict('TRADE_CLOSED', 'The trade window is not open');
  }

  private item(x: unknown): TradeItem {
    const o = (x ?? {}) as { kind?: unknown; amount?: unknown };
    const kind = KINDS.find((k) => k === o.kind);
    const amount = Math.round(Number(o.amount));
    if (!kind || !Number.isFinite(amount)) throw badRequest('BAD_REQUEST', 'Invalid trade item');
    const [lo, hi] = RIVAL.limits[kind];
    if (amount < lo || amount > hi) throw badRequest('BAD_REQUEST', `${kind} must be between ${lo} and ${hi}`);
    return { kind, amount };
  }

  private canGive(teamId: string, it: TradeItem) {
    if (it.kind === 'credits') return this.squad.credits(teamId) >= it.amount;
    if (it.kind === 'nitro') return this.squad.inventoryOf(teamId, 'nitro_refill') >= it.amount;
    const car = this.sim.cars.get(teamId);
    return !!car && car.state.fuel - it.amount >= RIVAL.limits.fuelFloor;
  }

  private apply(teamId: string, it: TradeItem, sign: 1 | -1) {
    if (it.kind === 'credits') {
      if (sign < 0) this.squad.spend(teamId, it.amount);
      else this.squad.addCredits(teamId, it.amount);
    } else if (it.kind === 'nitro') this.squad.adjustInventory(teamId, 'nitro_refill', sign * it.amount);
    else {
      const car = this.sim.cars.get(teamId);
      if (car) car.state = { ...car.state, fuel: Math.max(0, Math.min(100, car.state.fuel + sign * it.amount)) };
    }
  }

  private async ledger(teamId: string, gave: TradeItem, got: TradeItem, key: string) {
    const fuel = (got.kind === 'fuel' ? got.amount : 0) - (gave.kind === 'fuel' ? gave.amount : 0);
    const credits = (got.kind === 'credits' ? got.amount : 0) - (gave.kind === 'credits' ? gave.amount : 0);
    await this.db
      .insert(fuelTransactions)
      .values({ teamId, deltaFuel: fuel, reason: key.startsWith('depot') ? 'rival_depot' : 'rival_trade', creditsDelta: credits, atTick: this.sim.tick, idempotencyKey: key })
      .onConflictDoNothing();
  }

  private notifyPair(teamId: string) {
    this.squad.onTeamChanged(teamId);
    const p = this.partner.get(teamId);
    if (p) this.squad.onTeamChanged(p);
  }
}
