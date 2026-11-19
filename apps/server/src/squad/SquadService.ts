import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  bluffEntries,
  bluffRounds,
  bluffVotes,
  challengeClues,
  challengeSubmissions,
  challengeVariants,
  challenges,
  scoringEvents,
  type Db,
} from '@redline/db';
import {
  CHALLENGE_SCHEDULE,
  POWER_UPS,
  ROLES,
  SQUAD_RUBRIC,
  STARTING_POWER_UPS,
  WAYPOINTS,
  createRng,
  deriveTotals,
  phaseAt,
  type BluffOption,
  type ChallengeStatus,
  type ChallengeView,
  type CodingQuestionView,
  type PowerUpKind,
  type Role,
  type ScheduledChallenge,
  type ScoringCategory,
  type SquadView,
  type WaypointId,
} from '@redline/shared';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import type { WorldSim } from '../world/WorldSim';
import {
  BLUFF_PROMPTS,
  CODING_TEMPLATES,
  FOUR_KEY_TEMPLATES,
  codingRoundTemplates,
  navigationVariant,
  normalizeAnswer,
  type CodingVariant,
  type FourKeyVariant,
  type NavigationVariant,
} from './content';

export interface Actor {
  playerId: string;
  teamId: string;
  role: Role;
}

interface Attempt {
  attempts: number;
  solved: boolean;
  points: number;
}

interface BluffState {
  sched: ScheduledChallenge;
  dbId: string;
  prompt: string;
  truth: string;
  /** Opaque; indistinguishable from entry ids. */
  truthChoiceId: string;
  entries: Map<string, { choiceId: string; text: string; playerId: string }>;
  votes: Map<string, { teamId: string; choiceId: string }>;
  /** Fixed display order of choices (seeded), computed when voting opens. */
  order: string[] | null;
  results: Map<string, { fooled: number; detected: boolean; points: number }> | null;
}

interface ScoreRow {
  category: ScoringCategory;
  points: number;
  sourceId: string;
}

export interface SubmitResult {
  correct: boolean;
  points: number;
  attemptsLeft: number;
}

/**
 * Server-side squad mechanics: synchronised challenges, private clues, bluffing, Captain actions,
 * scoring events and vehicle effects on the REAL squad car in the one world. Pure in-memory state for
 * speed, with every submission / vote / score written to Postgres (idempotent keys, unique constraints).
 */
export class SquadService {
  private active = false;
  private readonly dbIds = new Map<string, string>();
  private readonly coding = new Map<string, CodingVariant>();
  private readonly fourKey = new Map<string, FourKeyVariant>();
  private readonly nav = new Map<string, NavigationVariant>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly bluffs = new Map<string, BluffState>();
  private readonly teams = new Map<string, { inventory: Record<PowerUpKind, number>; waypoint: WaypointId | null }>();
  private readonly scores = new Map<string, ScoreRow[]>();
  private readonly idem = new Map<string, unknown>();
  private readonly lastStatus = new Map<string, string>();
  private readonly clueKey: Buffer;
  private codingTemplates: string[][] = [];
  /** Called whenever a squad's view may have changed (WorldRoom pushes per-role views). */
  onTeamChanged: (teamId: string | null) => void = () => {};

  constructor(
    private readonly db: Db,
    private readonly eventId: string,
    private readonly seed: string,
    private readonly sim: WorldSim,
    private readonly clock: () => { live: boolean; elapsedMs: number; started: boolean },
    secret: string,
  ) {
    this.clueKey = createHash('sha256').update(`${secret}:clues`).digest();
  }

  /* ---------------- activation (at START) ---------------- */

  /** Generate every squad's variants and persist them. Idempotent per process. */
  async activate(teamIds: string[]) {
    if (this.active) return;
    this.active = true;
    const eventRng = createRng(this.seed, 'squad:event');
    const codingRounds = CHALLENGE_SCHEDULE.filter((c) => c.kind === 'coding');
    this.codingTemplates = codingRoundTemplates(eventRng, codingRounds.length, codingRounds[0]?.questions ?? 4);
    const fourKeyKinds = ['digits', 'word'];
    const bluffPick = [...BLUFF_PROMPTS.keys()];
    for (let i = bluffPick.length - 1; i > 0; i--) {
      const j = eventRng.int(i + 1);
      [bluffPick[i], bluffPick[j]] = [bluffPick[j]!, bluffPick[i]!];
    }
    let codingIdx = 0;
    let fourKeyIdx = 0;
    let bluffIdx = 0;
    for (const sched of CHALLENGE_SCHEDULE) {
      if (sched.kind === 'coding') {
        const templates = this.codingTemplates[codingIdx++]!;
        for (let q = 0; q < templates.length; q++) {
          const qid = `${sched.id}-q${q + 1}`;
          const dbId = await this.insertChallenge(qid, 'coding', sched, SQUAD_RUBRIC.coding.firstTry, 'CODING');
          for (const teamId of teamIds) {
            const v = CODING_TEMPLATES[templates[q]!]!(createRng(this.seed, `coding:${qid}:${teamId}`));
            this.coding.set(`${qid}:${teamId}`, v);
            await this.insertVariant(dbId, teamId, { prompt: v.prompt, code: v.code, options: v.options }, v.answer);
          }
        }
      } else if (sched.kind === 'four_key') {
        const tpl = FOUR_KEY_TEMPLATES[fourKeyKinds[fourKeyIdx++ % fourKeyKinds.length]!]!;
        const dbId = await this.insertChallenge(sched.id, 'four_key', sched, SQUAD_RUBRIC.fourKey.byAttempt[0], 'TEAM_ASSESSMENTS');
        for (const teamId of teamIds) {
          const v = tpl(createRng(this.seed, `fourkey:${sched.id}:${teamId}`));
          this.fourKey.set(`${sched.id}:${teamId}`, v);
          await this.insertVariant(dbId, teamId, { prompt: v.prompt }, v.answer);
          for (const role of ROLES) {
            await this.db.insert(challengeClues).values({ challengeId: dbId, teamId, role, clueCiphertext: this.encrypt(v.clues[role]) }).onConflictDoNothing();
          }
        }
      } else if (sched.kind === 'navigation') {
        const dbId = await this.insertChallenge(sched.id, 'navigation', sched, SQUAD_RUBRIC.navigation.firstTry, 'CAPTAIN_STRATEGY');
        for (const teamId of teamIds) {
          const v = navigationVariant(createRng(this.seed, `nav:${sched.id}:${teamId}`));
          this.nav.set(`${sched.id}:${teamId}`, v);
          await this.insertVariant(dbId, teamId, { prompt: v.prompt, options: v.options }, v.answer);
        }
      } else if (sched.kind === 'bluff') {
        const p = BLUFF_PROMPTS[bluffPick[bluffIdx++ % bluffPick.length]!]!;
        const t0 = Date.now();
        const [row] = await this.db
          .insert(bluffRounds)
          .values({
            eventId: this.eventId,
            prompt: p.prompt,
            trueAnswerHash: this.hash(p.truth),
            opensAt: new Date(t0 + sched.opensAt),
            closesAt: new Date(t0 + sched.closesAt),
          })
          .returning({ id: bluffRounds.id });
        this.bluffs.set(sched.id, { sched, dbId: row!.id, prompt: p.prompt, truth: p.truth, truthChoiceId: randomUUID(), entries: new Map(), votes: new Map(), order: null, results: null });
      }
    }
    for (const teamId of teamIds) {
      this.teams.set(teamId, { inventory: { ...STARTING_POWER_UPS }, waypoint: null });
      this.scores.set(teamId, []);
    }
  }

  private async insertChallenge(code: string, type: 'coding' | 'four_key' | 'navigation', sched: ScheduledChallenge, maxPoints: number, category: ScoringCategory) {
    const [row] = await this.db
      .insert(challenges)
      .values({ eventId: this.eventId, code, type, phase: phaseAt(sched.opensAt) ?? 'IGNITION', payload: { title: sched.title, opensAt: sched.opensAt, closesAt: sched.closesAt }, answerHash: 'per-team', maxPoints, category })
      .returning({ id: challenges.id });
    this.dbIds.set(code, row!.id);
    return row!.id;
  }

  private insertVariant(challengeId: string, teamId: string, payload: unknown, answer: string) {
    return this.db.insert(challengeVariants).values({ challengeId, teamId, payload, answerHash: this.hash(answer) }).onConflictDoNothing();
  }

  private hash(answer: string) {
    return createHash('sha256').update(`${this.seed}:${normalizeAnswer(answer)}`).digest('hex');
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.clueKey, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `${iv.toString('base64url')}.${enc.toString('base64url')}.${c.getAuthTag().toString('base64url')}`;
  }

  /* ---------------- timing ---------------- */

  statusOf(s: ScheduledChallenge): ChallengeStatus {
    const { started, elapsedMs } = this.clock();
    if (!started || !this.active || elapsedMs < s.opensAt) return 'upcoming';
    return elapsedMs < s.closesAt ? 'open' : 'closed';
  }

  private bluffPhase(b: BluffState): 'write' | 'vote' | 'results' {
    const { elapsedMs } = this.clock();
    if (elapsedMs < (b.sched.writeUntil ?? b.sched.opensAt)) return 'write';
    return elapsedMs < b.sched.closesAt ? 'vote' : 'results';
  }

  /** Director hook: detect opens/closes/phase changes; settle bluff rounds; notify every squad. */
  async onTick() {
    if (!this.active) return;
    let changed = false;
    for (const s of CHALLENGE_SCHEDULE) {
      let st: string = this.statusOf(s);
      const b = this.bluffs.get(s.id);
      if (b && st === 'open') st = this.bluffPhase(b);
      if (b && st === 'closed') st = 'results';
      if (this.lastStatus.get(s.id) === st) continue;
      this.lastStatus.set(s.id, st);
      changed = true;
      if (b && st === 'vote' && !b.order) this.fixBluffOrder(b);
      if (b && st === 'results' && !b.results) await this.settleBluff(b);
    }
    if (changed) this.onTeamChanged(null);
  }

  private requireLive() {
    if (!this.active || !this.clock().live) throw conflict('NOT_LIVE', 'Challenges only accept answers while the event is live');
  }

  private requireOpen(s: ScheduledChallenge) {
    this.requireLive();
    if (this.statusOf(s) !== 'open') throw conflict('CHALLENGE_CLOSED', 'This challenge is not open right now');
  }

  private sched(id: string) {
    const s = CHALLENGE_SCHEDULE.find((c) => c.id === id);
    if (!s) throw notFound('UNKNOWN_CHALLENGE', 'No such challenge');
    return s;
  }

  /** Idempotency: replaying the same client key returns the original result, never re-scores. */
  private async once<T>(actor: Actor, key: unknown, fn: () => Promise<T>): Promise<T> {
    if (typeof key !== 'string' || key.length < 8 || key.length > 80) throw badRequest('IDEMPOTENCY_KEY', 'idempotencyKey (8–80 chars) is required');
    const k = `${actor.playerId}:${key}`;
    if (this.idem.has(k)) return this.idem.get(k) as T;
    const r = await fn();
    this.idem.set(k, r);
    return r;
  }

  /* ---------------- scoring + rewards ---------------- */

  private async award(teamId: string, category: ScoringCategory, points: number, reason: string, sourceType: string, sourceId: string) {
    if (points <= 0) return;
    const rows = await this.db
      .insert(scoringEvents)
      .values({ teamId, category, points, reason, sourceType, sourceId, tick: this.sim.tick })
      .onConflictDoNothing()
      .returning({ id: scoringEvents.id });
    if (rows.length) this.scores.get(teamId)?.push({ category, points, sourceId });
  }

  private grant(teamId: string, kind: PowerUpKind) {
    const t = this.teams.get(teamId);
    if (t) t.inventory[kind]++;
  }

  private async submission(challengeCode: string, actor: Actor, answer: string, correct: boolean, points: number, key: string) {
    const challengeId = this.dbIds.get(challengeCode)!;
    await this.db
      .insert(challengeSubmissions)
      .values({ challengeId, teamId: actor.teamId, playerId: actor.playerId, answer: answer.slice(0, 200), correct, points, idempotencyKey: `${actor.playerId}:${key}` })
      .onConflictDoNothing();
  }

  private attempt(key: string): Attempt {
    let a = this.attempts.get(key);
    if (!a) this.attempts.set(key, (a = { attempts: 0, solved: false, points: 0 }));
    return a;
  }

  /* ---------------- Engineer: coding ---------------- */

  async answerCoding(actor: Actor, questionId: string, answer: unknown, key: unknown): Promise<SubmitResult> {
    if (actor.role !== 'ENGINEER') throw forbidden('WRONG_ROLE', 'Only the Engineer answers coding questions');
    const roundId = questionId.replace(/-q\d+$/, '');
    const s = this.sched(roundId);
    if (s.kind !== 'coding') throw notFound('UNKNOWN_CHALLENGE', 'No such question');
    const v = this.coding.get(`${questionId}:${actor.teamId}`);
    if (!v) throw notFound('UNKNOWN_CHALLENGE', 'No such question');
    return this.once(actor, key, async () => {
      this.requireOpen(s);
      const R = SQUAD_RUBRIC.coding;
      const a = this.attempt(`${questionId}:${actor.teamId}`);
      if (a.solved || a.attempts >= R.maxAttempts) throw conflict('NO_ATTEMPTS', 'No attempts left for this question');
      a.attempts++;
      const correct = normalizeAnswer(answer) === normalizeAnswer(v.answer);
      let points = 0;
      if (correct) {
        a.solved = true;
        points = a.attempts === 1 ? R.firstTry : R.secondTry;
        a.points = points;
        await this.award(actor.teamId, R.category, points, `coding ${questionId} attempt ${a.attempts}`, 'coding', questionId);
        // Reward on the REAL squad car in the shared world.
        this.sim.addBuff(actor.teamId, 'engine_tune');
      }
      await this.submission(questionId, actor, String(answer ?? ''), correct, points, key as string);
      this.onTeamChanged(actor.teamId);
      return { correct, points, attemptsLeft: R.maxAttempts - a.attempts };
    });
  }

  /* ---------------- Captain: four-key + navigation ---------------- */

  async submitFourKey(actor: Actor, challengeId: string, answer: unknown, key: unknown): Promise<SubmitResult> {
    if (actor.role !== 'CAPTAIN') throw forbidden('WRONG_ROLE', 'Only the Captain submits the combined answer');
    const s = this.sched(challengeId);
    const v = this.fourKey.get(`${challengeId}:${actor.teamId}`);
    if (s.kind !== 'four_key' || !v) throw notFound('UNKNOWN_CHALLENGE', 'No such challenge');
    return this.once(actor, key, async () => {
      this.requireOpen(s);
      const R = SQUAD_RUBRIC.fourKey;
      const a = this.attempt(`${challengeId}:${actor.teamId}`);
      if (a.solved || a.attempts >= R.maxAttempts) throw conflict('NO_ATTEMPTS', 'No attempts left');
      a.attempts++;
      const correct = normalizeAnswer(answer).replace(/\s/g, '') === normalizeAnswer(v.answer);
      let points = 0;
      if (correct) {
        a.solved = true;
        points = R.byAttempt[a.attempts - 1] ?? 0;
        a.points = points;
        await this.award(actor.teamId, R.category, points, `four-key ${challengeId} attempt ${a.attempts}`, 'four_key', challengeId);
        this.grant(actor.teamId, 'grip_boost');
      }
      await this.submission(challengeId, actor, String(answer ?? ''), correct, points, key as string);
      this.onTeamChanged(actor.teamId);
      return { correct, points, attemptsLeft: R.maxAttempts - a.attempts };
    });
  }

  async answerNavigation(actor: Actor, challengeId: string, answer: unknown, key: unknown): Promise<SubmitResult> {
    if (actor.role !== 'CAPTAIN') throw forbidden('WRONG_ROLE', 'Only the Captain answers navigation intel');
    const s = this.sched(challengeId);
    const v = this.nav.get(`${challengeId}:${actor.teamId}`);
    if (s.kind !== 'navigation' || !v) throw notFound('UNKNOWN_CHALLENGE', 'No such challenge');
    return this.once(actor, key, async () => {
      this.requireOpen(s);
      const R = SQUAD_RUBRIC.navigation;
      const a = this.attempt(`${challengeId}:${actor.teamId}`);
      if (a.solved || a.attempts >= R.maxAttempts) throw conflict('NO_ATTEMPTS', 'No attempts left');
      a.attempts++;
      const correct = normalizeAnswer(answer) === normalizeAnswer(v.answer);
      let points = 0;
      if (correct) {
        a.solved = true;
        points = a.attempts === 1 ? R.firstTry : R.secondTry;
        a.points = points;
        await this.award(actor.teamId, R.category, points, `navigation ${challengeId} attempt ${a.attempts}`, 'navigation', challengeId);
        const wp = WAYPOINTS.find((w) => w.label === v.answer);
        if (wp) this.teams.get(actor.teamId)!.waypoint = wp.id;
      }
      await this.submission(challengeId, actor, String(answer ?? ''), correct, points, key as string);
      this.onTeamChanged(actor.teamId);
      return { correct, points, attemptsLeft: R.maxAttempts - a.attempts };
    });
  }

  /** Captain navigation choice: sets the squad waypoint shown on the Racer's HUD and map. */
  async setWaypoint(actor: Actor, waypoint: unknown) {
    if (actor.role !== 'CAPTAIN') throw forbidden('WRONG_ROLE', 'Only the Captain sets navigation');
    if (!this.active) throw conflict('NOT_LIVE', 'Navigation opens when the event starts');
    const wp = waypoint === null ? null : WAYPOINTS.find((w) => w.id === waypoint);
    if (wp === undefined) throw badRequest('UNKNOWN_WAYPOINT', 'Unknown waypoint');
    this.teams.get(actor.teamId)!.waypoint = wp?.id ?? null;
    this.onTeamChanged(actor.teamId);
    return { waypoint: wp?.id ?? null };
  }

  /** Captain power-up deployment: effect applied to the real squad car. */
  async deployPowerUp(actor: Actor, kind: unknown) {
    if (actor.role !== 'CAPTAIN') throw forbidden('WRONG_ROLE', 'Only the Captain deploys power-ups');
    this.requireLive();
    if (typeof kind !== 'string' || !(kind in POWER_UPS)) throw badRequest('UNKNOWN_POWER_UP', 'Unknown power-up');
    const k = kind as PowerUpKind;
    const t = this.teams.get(actor.teamId)!;
    if (t.inventory[k] <= 0) throw conflict('NONE_LEFT', 'No power-ups of that kind left');
    if (!this.sim.cars.has(actor.teamId)) throw conflict('NO_CAR', 'Squad car not in the world');
    t.inventory[k]--;
    if (k === 'nitro_refill') this.sim.refillNitro(actor.teamId);
    else if (k === 'patch') this.sim.patch(actor.teamId, 15);
    else this.sim.addBuff(actor.teamId, 'grip_boost');
    this.onTeamChanged(actor.teamId);
    return { inventory: { ...t.inventory } };
  }

  /* ---------------- Deceiver: bluffing ---------------- */

  private bluff(id: string) {
    const b = this.bluffs.get(id);
    if (!b) throw notFound('UNKNOWN_CHALLENGE', 'No such bluff round');
    return b;
  }

  async bluffEntry(actor: Actor, roundId: string, text: unknown) {
    if (actor.role !== 'DECEIVER') throw forbidden('WRONG_ROLE', 'Only the Deceiver writes the bluff');
    const b = this.bluff(roundId);
    this.requireOpen(b.sched);
    if (this.bluffPhase(b) !== 'write') throw conflict('PHASE', 'Bluff writing has closed');
    const t = typeof text === 'string' ? text.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim() : '';
    if (t.length < 1 || t.length > 60) throw badRequest('INVALID_BLUFF', 'Bluff must be 1–60 characters');
    if (b.entries.has(actor.teamId)) throw conflict('ALREADY_ENTERED', 'Your squad already submitted its bluff (one entry per squad)');
    const norm = normalizeAnswer(t);
    if (norm === normalizeAnswer(b.truth)) throw conflict('TOO_TRUE', 'That is too close to the real answer — bluff harder');
    for (const e of b.entries.values()) if (normalizeAnswer(e.text) === norm) throw conflict('DUPLICATE_BLUFF', 'Another squad already wrote that — be original');
    const [row] = await this.db
      .insert(bluffEntries)
      .values({ roundId: b.dbId, teamId: actor.teamId, playerId: actor.playerId, fakeAnswer: t })
      .onConflictDoNothing()
      .returning({ id: bluffEntries.id });
    if (!row) throw conflict('ALREADY_ENTERED', 'Your squad already submitted its bluff (one entry per squad)');
    b.entries.set(actor.teamId, { choiceId: row.id, text: t, playerId: actor.playerId });
    this.onTeamChanged(actor.teamId);
    return { ok: true };
  }

  async bluffVote(actor: Actor, roundId: string, choiceId: unknown) {
    if (actor.role !== 'DECEIVER') throw forbidden('WRONG_ROLE', 'Only Deceivers vote in bluff rounds');
    const b = this.bluff(roundId);
    this.requireOpen(b.sched);
    if (this.bluffPhase(b) !== 'vote') throw conflict('PHASE', 'Voting is not open');
    if (typeof choiceId !== 'string') throw badRequest('INVALID_CHOICE', 'Choose an answer');
    const own = b.entries.get(actor.teamId);
    if (own && own.choiceId === choiceId) throw forbidden('OWN_TEAM', 'You cannot vote for your own squad’s bluff');
    const valid = choiceId === b.truthChoiceId || [...b.entries.values()].some((e) => e.choiceId === choiceId);
    if (!valid) throw badRequest('INVALID_CHOICE', 'Unknown choice');
    if (b.votes.has(actor.playerId)) throw conflict('ALREADY_VOTED', 'One vote per player');
    const rows = await this.db
      .insert(bluffVotes)
      .values({ roundId: b.dbId, voterTeamId: actor.teamId, voterPlayerId: actor.playerId, choiceId: choiceId === b.truthChoiceId ? null : choiceId })
      .onConflictDoNothing()
      .returning({ id: bluffVotes.id });
    if (!rows.length) throw conflict('ALREADY_VOTED', 'One vote per player');
    b.votes.set(actor.playerId, { teamId: actor.teamId, choiceId });
    this.onTeamChanged(actor.teamId);
    return { ok: true };
  }

  private fixBluffOrder(b: BluffState) {
    const ids = [b.truthChoiceId, ...[...b.entries.values()].map((e) => e.choiceId)].sort();
    const rng = createRng(this.seed, `bluff-order:${b.sched.id}`);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    }
    b.order = ids;
  }

  /** Deterministic settlement: +detect for voting the truth; +perFooled per vote on your bluff (capped). */
  private async settleBluff(b: BluffState) {
    const R = SQUAD_RUBRIC.bluff;
    const results = new Map<string, { fooled: number; detected: boolean; points: number }>();
    for (const teamId of this.teams.keys()) results.set(teamId, { fooled: 0, detected: false, points: 0 });
    for (const v of b.votes.values()) {
      if (v.choiceId === b.truthChoiceId) results.get(v.teamId)!.detected = true;
      else for (const [teamId, e] of b.entries) if (e.choiceId === v.choiceId && teamId !== v.teamId) results.get(teamId)!.fooled++;
    }
    for (const [teamId, r] of results) {
      const fooledPts = Math.min(R.maxFooled, r.fooled * R.perFooled);
      r.points = (r.detected ? R.detect : 0) + fooledPts;
      if (r.detected) {
        await this.award(teamId, R.category, R.detect, `${b.sched.id}: detected the real answer`, 'bluff_detect', b.sched.id);
        this.grant(teamId, 'nitro_refill');
      }
      if (fooledPts) await this.award(teamId, R.category, fooledPts, `${b.sched.id}: fooled ${r.fooled} player(s)`, 'bluff_fooled', b.sched.id);
    }
    b.results = results;
  }

  /** SERVER-INTERNAL answer key (tests / host tooling). Never routed to any client. */
  answerFor(kind: 'coding' | 'four_key' | 'navigation' | 'bluff', id: string, teamId: string): string | undefined {
    if (kind === 'coding') return this.coding.get(`${id}:${teamId}`)?.answer;
    if (kind === 'four_key') return this.fourKey.get(`${id}:${teamId}`)?.answer;
    if (kind === 'navigation') return this.nav.get(`${id}:${teamId}`)?.answer;
    return this.bluffs.get(id)?.truth;
  }

  /** SERVER-INTERNAL: a squad's four private clues (tests assert none leaks to another role). */
  cluesFor(id: string, teamId: string) {
    return this.fourKey.get(`${id}:${teamId}`)?.clues;
  }

  /* ---------------- views ---------------- */

  scoreOf(teamId: string) {
    return deriveTotals(this.scores.get(teamId) ?? []);
  }

  scoringRows(teamId: string) {
    return [...(this.scores.get(teamId) ?? [])];
  }

  /** The ONLY way challenge data reaches a client: filtered for this player's role. */
  viewFor(teamId: string, role: Role, playerId: string): SquadView {
    const out: ChallengeView[] = [];
    for (const s of CHALLENGE_SCHEDULE) {
      const status = this.statusOf(s);
      const base: ChallengeView = { id: s.id, kind: s.kind, title: s.title, status, opensAt: s.opensAt, closesAt: s.closesAt, action: 'view' };
      if (status === 'upcoming') {
        out.push(base);
        continue;
      }
      if (s.kind === 'coding') {
        const qs: CodingQuestionView[] = [];
        for (let q = 1; q <= (s.questions ?? 0); q++) {
          const qid = `${s.id}-q${q}`;
          const v = this.coding.get(`${qid}:${teamId}`);
          if (!v) continue;
          const a = this.attempts.get(`${qid}:${teamId}`) ?? { attempts: 0, solved: false, points: 0 };
          const showCode = role === 'ENGINEER';
          qs.push({ id: qid, prompt: showCode ? v.prompt : 'Engineer challenge', code: showCode ? v.code : '', options: showCode ? v.options : null, attempts: a.attempts, maxAttempts: SQUAD_RUBRIC.coding.maxAttempts, solved: a.solved, points: a.points });
        }
        out.push({ ...base, action: role === 'ENGINEER' && status === 'open' ? 'answer' : 'view', questions: qs });
      } else if (s.kind === 'four_key') {
        const v = this.fourKey.get(`${s.id}:${teamId}`);
        const a = this.attempts.get(`${s.id}:${teamId}`) ?? { attempts: 0, solved: false, points: 0 };
        out.push({
          ...base,
          action: role === 'CAPTAIN' && status === 'open' && !a.solved ? 'submit' : 'view',
          prompt: v?.prompt,
          clue: v?.clues[role], // this player's OWN clue only
          attempts: a.attempts,
          maxAttempts: SQUAD_RUBRIC.fourKey.maxAttempts,
          solved: a.solved,
          points: a.points,
        });
      } else if (s.kind === 'navigation') {
        const v = this.nav.get(`${s.id}:${teamId}`);
        const a = this.attempts.get(`${s.id}:${teamId}`) ?? { attempts: 0, solved: false, points: 0 };
        const cap = role === 'CAPTAIN';
        out.push({
          ...base,
          action: cap && status === 'open' && !a.solved ? 'answer' : 'view',
          prompt: cap ? v?.prompt : 'Captain is decoding navigation intel',
          options: cap ? v?.options : undefined,
          attempts: a.attempts,
          maxAttempts: SQUAD_RUBRIC.navigation.maxAttempts,
          solved: a.solved,
          points: a.points,
        });
      } else if (s.kind === 'bluff') {
        const b = this.bluffs.get(s.id)!;
        const phase = status === 'closed' ? 'results' : this.bluffPhase(b);
        const isDec = role === 'DECEIVER';
        const own = b.entries.get(teamId);
        let bluffOptions: BluffOption[] | undefined;
        if (isDec && phase === 'vote' && b.order) {
          const textOf = new Map<string, string>([[b.truthChoiceId, b.truth], ...[...b.entries.values()].map((e) => [e.choiceId, e.text] as [string, string])]);
          bluffOptions = b.order.filter((id) => id !== own?.choiceId).map((id) => ({ choiceId: id, text: textOf.get(id)! }));
        }
        const r = b.results?.get(teamId);
        out.push({
          ...base,
          writeUntil: s.writeUntil,
          phase,
          prompt: b.prompt,
          action: !isDec || status !== 'open' ? 'view' : phase === 'write' && !own ? 'write' : phase === 'vote' && !b.votes.has(playerId) ? 'vote' : 'view',
          myEntry: own?.text ?? null,
          bluffOptions,
          myVote: b.votes.get(playerId)?.choiceId ?? null,
          results: phase === 'results' && r ? { truth: b.truth, myTeamFooled: r.fooled, detected: r.detected, points: r.points } : null,
        });
      }
    }
    const t = this.teams.get(teamId) ?? { inventory: { ...STARTING_POWER_UPS }, waypoint: null };
    return {
      teamId,
      role,
      challenges: out,
      inventory: { ...t.inventory },
      waypoint: t.waypoint,
      buffs: this.sim.activeBuffs(teamId),
      score: this.scoreOf(teamId),
    };
  }
}
