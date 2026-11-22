/**
 * M4 acceptance: four-player squad mechanics wired to the real squad car in the one world.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Bot } from '@redline/loadtest';
import { bluffEntries, bluffVotes, challengeClues, scoringEvents } from '@redline/db';
import { BALANCE, ROLES, SQUAD_RUBRIC, deriveTotals, forwardSpeed, type Role, type ScoringCategory, type SquadView } from '@redline/shared';
import { HOST_KEY, fullSquad, get, makeServer, post, until, type TestServer } from './helpers';

const MIN = 60_000;
let s: TestServer;
let base: string;
interface Member {
  role: Role;
  token: string;
  playerId: string;
  bot: Bot;
}
interface Team {
  teamId: string;
  name: string;
  m: Record<Role, Member>;
}
const teams: Team[] = [];
const allBots: Bot[] = [];
let keySeq = 0;
const key = () => `test-key-${++keySeq}-${Date.now()}`;
const auth = (m: Member) => ({ authorization: `Bearer ${m.token}` });

async function goTo(elapsedMs: number) {
  const cur = s.room.clockState().elapsedMs;
  s.advance(elapsedMs - cur);
  await s.room.tick();
}
const view = (m: Member): SquadView => m.bot.lastSquad!;
const ch = (m: Member, id: string) => view(m).challenges.find((c) => c.id === id)!;
const settle = () => new Promise((r) => setTimeout(r, 60));

beforeAll(async () => {
  s = await makeServer({ countdownMs: 1000, releaseAtMs: 0, trafficCount: 0 }, { manualClock: true });
  base = await s.listen(0);
  for (let i = 0; i < 3; i++) {
    const { captain, others } = await fullSquad(s, `Squad${i}`);
    const tokens: Record<Role, { sessionToken: string; playerId: string }> = {
      CAPTAIN: captain,
      RACER: others[0],
      ENGINEER: others[1],
      DECEIVER: others[2],
    };
    const m = {} as Record<Role, Member>;
    for (const role of ROLES) {
      const bot = new Bot(`t${i}-${role}`, { keepLog: true });
      await bot.connect(base.replace('http', 'ws'), tokens[role].sessionToken);
      allBots.push(bot);
      m[role] = { role, token: tokens[role].sessionToken, playerId: tokens[role].playerId, bot };
    }
    teams.push({ teamId: captain.teamId, name: `Squad${i}`, m });
  }
  expect((await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY })).status).toBe(200);
  s.advance(1000);
  await s.room.tick();
  expect(s.room.clockState().status).toBe('LIVE');
}, 60_000);

afterAll(async () => {
  for (const b of allBots) b.close();
  await s.dispose();
});

describe('M4: Engineer', () => {
  it('correct answer → CODING scoring event + engine-tune buff on the REAL squad car (faster on the server)', async () => {
    const [t0, t1] = teams as [Team, Team];
    const eng = t0.m.ENGINEER;
    expect(ch(eng, 'coding-1').status).toBe('upcoming');
    expect((await post(s, '/api/squad/coding/coding-1-q1', { answer: 'x', idempotencyKey: key() }, auth(eng))).status).toBe(409);
    await goTo(3 * MIN);
    await settle();
    const c = ch(eng, 'coding-1');
    expect(c.status).toBe('open');
    expect(c.action).toBe('answer');
    expect(c.questions).toHaveLength(4);
    expect(c.questions![0]!.code.length).toBeGreaterThan(5);
    // Non-engineers see progress only, never the code.
    expect(ch(t0.m.CAPTAIN, 'coding-1').questions![0]!.code).toBe('');
    expect((await post(s, '/api/squad/coding/coding-1-q1', { answer: '1', idempotencyKey: key() }, auth(t0.m.CAPTAIN))).status).toBe(403);

    // Wrong then right → second-try points.
    const ans2 = s.room.squad!.answerFor('coding', 'coding-1-q2', t0.teamId)!;
    const wrong = await post(s, '/api/squad/coding/coding-1-q2', { answer: `${ans2}zz`, idempotencyKey: key() }, auth(eng));
    expect(wrong.body).toEqual({ correct: false, points: 0, attemptsLeft: 1 });
    const right2 = await post(s, '/api/squad/coding/coding-1-q2', { answer: ans2, idempotencyKey: key() }, auth(eng));
    expect(right2.body).toMatchObject({ correct: true, points: SQUAD_RUBRIC.coding.secondTry });

    // First-try correct answer, replayed with the same idempotency key → scored once.
    const ans1 = s.room.squad!.answerFor('coding', 'coding-1-q1', t0.teamId)!;
    const k = key();
    const r1 = await post(s, '/api/squad/coding/coding-1-q1', { answer: ans1, idempotencyKey: k }, auth(eng));
    const r1b = await post(s, '/api/squad/coding/coding-1-q1', { answer: ans1, idempotencyKey: k }, auth(eng));
    expect(r1.body).toEqual({ correct: true, points: 25, attemptsLeft: 1 });
    expect(r1b.body).toEqual(r1.body);
    const rows = await s.db.db.select().from(scoringEvents).where(and(eq(scoringEvents.teamId, t0.teamId), eq(scoringEvents.category, 'CODING')));
    expect(rows.map((r) => r.points).sort()).toEqual([10, 25]);
    expect(rows.every((r) => r.reason && r.sourceId && r.createdAt)).toBe(true);
    // Variants differ per squad (anti-copying) but the same answer for t1 is checked against t1's own variant.
    expect(s.room.squad!.answerFor('coding', 'coding-1-q1', t1.teamId)).toBeDefined();

    // Buff is on the real car: the buffed squad out-accelerates an unbuffed squad on the server.
    expect(s.room.sim.activeBuffs(t0.teamId).map((b) => b.kind)).toContain('engine_tune');
    expect(s.room.sim.activeBuffs(t1.teamId)).toHaveLength(0);
    const carA = s.room.sim.cars.get(t0.teamId)!;
    const carB = s.room.sim.cars.get(t1.teamId)!;
    expect(carA.state.x).toBeCloseTo(carB.state.x, 1); // same spawn row (side by side, spawn edge runs east)
    let seq = 0;
    for (let i = 0; i < 30; i++) {
      seq++;
      for (const c2 of [carA, carB]) s.room.sim.pushInput(c2.teamId, seq, { steer: 0, throttle: 1, brake: 0, nitro: false, handbrake: false });
      s.room.worldLoop(1);
    }
    expect(forwardSpeed(carA.state)).toBeGreaterThan(forwardSpeed(carB.state) + 0.5);
    await settle();
    expect(view(t0.m.RACER).buffs.map((b) => b.kind)).toContain('engine_tune');
    expect(view(t0.m.CAPTAIN).score.byCategory.CODING).toBe(35);
  });
});

describe('M4: Captain four-key + private clues', () => {
  it('each role sees only its own clue; Captain submits the combined answer; reward is a power-up', async () => {
    await goTo(10 * MIN);
    await settle();
    const t0 = teams[0]!;
    const clues = s.room.squad!.cluesFor('fourkey-1', t0.teamId)!;
    for (const role of ROLES) {
      const c = ch(t0.m[role], 'fourkey-1');
      expect(c.status).toBe('open');
      expect(c.clue).toBe(clues[role]);
      expect(c.action).toBe(role === 'CAPTAIN' ? 'submit' : 'view');
    }
    // Clues are stored encrypted.
    const stored = await s.db.db.select().from(challengeClues).where(eq(challengeClues.teamId, t0.teamId));
    expect(stored.length).toBeGreaterThanOrEqual(4);
    for (const row of stored) for (const c of Object.values(clues)) expect(row.clueCiphertext).not.toContain(c);

    expect((await post(s, '/api/squad/fourkey/fourkey-1', { answer: '0000', idempotencyKey: key() }, auth(t0.m.ENGINEER))).status).toBe(403);
    const ans = s.room.squad!.answerFor('four_key', 'fourkey-1', t0.teamId)!;
    const r = await post(s, '/api/squad/fourkey/fourkey-1', { answer: ans.toLowerCase(), idempotencyKey: key() }, auth(t0.m.CAPTAIN));
    expect(r.body).toMatchObject({ correct: true, points: 75 });
    await settle();
    expect(view(t0.m.CAPTAIN).inventory.grip_boost).toBe(1);
    expect(view(t0.m.DECEIVER).score.byCategory.TEAM_ASSESSMENTS).toBe(75);
  });
});

describe('M4: Deceiver bluffing', () => {
  it('one entry per team, cannot vote own team, one vote per player, deterministic points', async () => {
    const [t0, t1, t2] = teams as [Team, Team, Team];
    await goTo(10.5 * MIN);
    await settle();
    const truth = s.room.squad!.answerFor('bluff', 'bluff-1', t0.teamId)!;
    expect(ch(t0.m.DECEIVER, 'bluff-1')).toMatchObject({ phase: 'write', action: 'write' });
    expect(ch(t0.m.CAPTAIN, 'bluff-1').action).toBe('view');
    const entry = (t: Team, text: string, m: Member = t.m.DECEIVER) => post(s, '/api/squad/bluff/bluff-1/entry', { text }, auth(m));
    expect((await entry(t0, 'A cat', t0.m.CAPTAIN)).status).toBe(403);
    expect((await entry(t0, truth.toUpperCase())).body.error).toBe('TOO_TRUE');
    expect((await entry(t0, 'A tiny cricket')).status).toBe(200);
    expect((await entry(t0, 'Another one')).body.error).toBe('ALREADY_ENTERED');
    expect((await entry(t1, 'a tiny cricket')).body.error).toBe('DUPLICATE_BLUFF');
    expect((await entry(t1, 'A loose screw')).status).toBe(200);
    expect((await entry(t2, 'Static electricity')).status).toBe(200);
    const vote = (m: Member, choiceId: string) => post(s, '/api/squad/bluff/bluff-1/vote', { choiceId }, auth(m));
    expect((await vote(t0.m.DECEIVER, 'x')).body.error).toBe('PHASE'); // voting not open yet

    await goTo(13 * MIN);
    await settle();
    const opts = (t: Team) => ch(t.m.DECEIVER, 'bluff-1').bluffOptions!;
    // Own squad's bluff is never offered; all others + the truth are, in the same order for everyone.
    expect(opts(t0).map((o) => o.text)).not.toContain('A tiny cricket');
    expect(opts(t0)).toHaveLength(3);
    const idOf = (t: Team, text: string) => opts(t).find((o) => o.text === text)!.choiceId;
    const t0Choice = idOf(t1, 'A tiny cricket');
    // Own-team vote is rejected server-side even if the id is known.
    expect((await vote(t0.m.DECEIVER, t0Choice)).body.error).toBe('OWN_TEAM');
    expect((await vote(t0.m.CAPTAIN, idOf(t0, truth))).status).toBe(403);
    expect((await vote(t0.m.DECEIVER, idOf(t0, truth))).status).toBe(200);
    expect((await vote(t0.m.DECEIVER, idOf(t0, 'A loose screw'))).body.error).toBe('ALREADY_VOTED');
    expect((await vote(t1.m.DECEIVER, t0Choice)).status).toBe(200);
    expect((await vote(t2.m.DECEIVER, t0Choice)).status).toBe(200);

    await goTo(16 * MIN);
    await settle();
    const res = (t: Team) => ch(t.m.DECEIVER, 'bluff-1').results!;
    expect(res(t0)).toEqual({ truth, myTeamFooled: 2, detected: true, points: 25 + 20 });
    expect(res(t1)).toEqual({ truth, myTeamFooled: 0, detected: false, points: 0 });
    expect(res(t2).points).toBe(0);
    const dec = await s.db.db.select().from(scoringEvents).where(and(eq(scoringEvents.teamId, t0.teamId), eq(scoringEvents.category, 'DECEPTION')));
    expect(dec.map((r) => r.points).sort((a, b) => a - b)).toEqual([20, 25]);
    expect(await s.db.db.select().from(bluffEntries)).toHaveLength(3);
    expect(await s.db.db.select().from(bluffVotes)).toHaveLength(3);
    expect(view(t0.m.CAPTAIN).inventory.nitro_refill).toBe(2); // starting 1 + detection reward
  });
});

describe('M4: Captain navigation + power-ups', () => {
  it('navigation choice sets the Racer’s waypoint; power-ups change the real car; inventory enforced', async () => {
    const [t0, t1] = teams as [Team, Team];
    const cap = t0.m.CAPTAIN;
    expect((await post(s, '/api/squad/waypoint', { waypoint: 'north_gate' }, auth(cap))).status).toBe(200);
    expect((await post(s, '/api/squad/waypoint', { waypoint: 'north_gate' }, auth(t0.m.RACER))).status).toBe(403);
    expect((await post(s, '/api/squad/waypoint', { waypoint: 'atlantis' }, auth(cap))).status).toBe(400);
    await settle();
    expect(view(t0.m.RACER).waypoint).toBe('north_gate');
    expect(view(t1.m.RACER).waypoint).toBeNull(); // other squads unaffected

    // Power-ups: patch repairs, nitro refills, grip boost buffs — all on the server car.
    const car = s.room.sim.cars.get(t0.teamId)!;
    car.state = { ...car.state, health: 50, nitro: 10 };
    expect((await post(s, '/api/squad/powerup', { kind: 'patch' }, auth(cap))).body.inventory.patch).toBe(0);
    expect(car.state.health).toBe(65);
    expect((await post(s, '/api/squad/powerup', { kind: 'patch' }, auth(cap))).body.error).toBe('NONE_LEFT');
    await post(s, '/api/squad/powerup', { kind: 'nitro_refill' }, auth(cap));
    expect(car.state.nitro).toBe(100);
    await post(s, '/api/squad/powerup', { kind: 'grip_boost' }, auth(cap));
    expect(s.room.sim.activeBuffs(t0.teamId).map((b) => b.kind)).toContain('grip_boost');
    expect((await post(s, '/api/squad/powerup', { kind: 'nitro_refill' }, auth(t0.m.ENGINEER))).status).toBe(403);

    // Navigation intel at 24:00: correct option also sets the waypoint.
    await goTo(24 * MIN);
    await settle();
    const nav = ch(cap, 'nav-1');
    expect(nav.options).toHaveLength(5);
    expect(ch(t0.m.RACER, 'nav-1').options).toBeUndefined();
    const ans = s.room.squad!.answerFor('navigation', 'nav-1', t0.teamId)!;
    const wrong = nav.options!.find((o) => o !== ans)!;
    expect((await post(s, '/api/squad/navigation/nav-1', { answer: wrong, idempotencyKey: key() }, auth(cap))).body.correct).toBe(false);
    expect((await post(s, '/api/squad/navigation/nav-1', { answer: ans, idempotencyKey: key() }, auth(cap))).body).toMatchObject({ correct: true, points: 20 });
    await settle();
    expect(view(t0.m.RACER).score.byCategory.CAPTAIN_STRATEGY).toBe(20);
    // The correct navigation answer also sets the squad waypoint to that place.
    expect(view(t0.m.RACER).waypoint).toBe(s.room.sim.map.waypoints.find((w) => w.label === ans)!.id);
  });
});

describe('M4: private clues never leak (full message logs)', () => {
  it('no player’s WS stream ever contained another role’s or another squad’s clue', async () => {
    await settle();
    let checked = 0;
    // 1) Structural: every `clue` field a player ever received is exactly its own clue.
    for (const t of teams) {
      const clues = s.room.squad!.cluesFor('fourkey-1', t.teamId)!;
      for (const role of ROLES) {
        const bot = t.m[role].bot;
        const received = new Set<string>();
        for (const raw of bot.log) {
          const m = JSON.parse(raw);
          if (m.t !== 'squad') continue;
          for (const c of m.view.challenges) if (c.clue !== undefined) received.add(c.clue);
        }
        expect([...received], bot.label).toEqual([clues[role]]);
      }
    }
    // 2) Raw bytes: a clue text that is unique to one (squad, role) appears only in that player's stream.
    const owners = new Map<string, string[]>();
    for (const t of teams) {
      const clues = s.room.squad!.cluesFor('fourkey-1', t.teamId)!;
      for (const role of ROLES) owners.set(clues[role], [...(owners.get(clues[role]) ?? []), `${t.name}/${role}`]);
    }
    for (const t of teams) {
      const clues = s.room.squad!.cluesFor('fourkey-1', t.teamId)!;
      for (const owner of ROLES) {
        const clue = clues[owner];
        if (owners.get(clue)!.length > 1) continue; // identical text drawn for two squads — not distinguishable
        for (const t2 of teams)
          for (const role of ROLES) {
            const bot = t2.m[role].bot;
            const seen = bot.log.some((raw) => raw.includes(JSON.stringify(clue).slice(1, -1)));
            const shouldSee = t2 === t && role === owner;
            expect(seen, `${bot.label} ${shouldSee ? 'must' : 'must NOT'} see ${t.name}/${owner} clue`).toBe(shouldSee);
            checked++;
          }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4 * 3 * 4); // at least one squad's clues were all unique
    // Answers never travel to clients either.
    for (const t of teams) {
      const ans = s.room.squad!.answerFor('coding', 'coding-1-q4', t.teamId)!;
      const code = s.room.squad!.answerFor('four_key', 'fourkey-1', t.teamId)!;
      for (const b of allBots) {
        if (code.length >= 4) expect(b.log.some((raw) => raw.includes(`"${code}"`)), `${b.label} saw a four-key answer`).toBe(false);
        if (ans.length >= 6) expect(b.log.some((raw) => raw.includes(`"${ans}"`))).toBe(false);
      }
    }
    // Totals are derived from scoring_events rows, never stored.
    const t0rows = await s.db.db.select().from(scoringEvents).where(eq(scoringEvents.teamId, teams[0]!.teamId));
    expect(s.room.squad!.scoreOf(teams[0]!.teamId).total).toBe(deriveTotals(t0rows.map((r) => ({ category: r.category as ScoringCategory, points: r.points }))).total);
    expect(BALANCE.maxSquads).toBe(30);
  });

  it('host can warp only when explicitly enabled (rehearsal only)', async () => {
    expect((await post(s, '/api/host/warp', { toElapsedMs: 40 * MIN }, { 'x-host-key': HOST_KEY })).body.error).toBe('WARP_DISABLED');
    expect((await get(s, '/api/squad/view', { authorization: `Bearer ${teams[0]!.m.RACER.token}` })).body.role).toBe('RACER');
    await until(() => true);
  });
});
