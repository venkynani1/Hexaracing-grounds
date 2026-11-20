/**
 * M7 acceptance: Hexaware Gate + escort, Welcome Convoy, offer letters, championship.
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Bot } from '@redline/loadtest';
import { offerLetters, players, scoringEvents, teams } from '@redline/db';
import { NEUTRAL_INPUT, SQUAD_RUBRIC, gateLayout, tieBreakHash, type Role, type ScoringCategory, type ServerMessage } from '@redline/shared';
import { computeStandings } from '../src/gate/championship';
import { OFFER_LETTER_DISCLAIMER } from '../src/gate/letters';
import { HOST_KEY, connectWs, fullSquad, get, makeServer, post, until, type TestServer } from './helpers';

const MIN = 60_000;
const settle = () => new Promise((r) => setTimeout(r, 40));
async function goTo(s: TestServer, ms: number) {
  s.advance(ms - s.room.clockState().elapsedMs);
  await s.room.tick();
}
async function step(s: TestServer, n = 1, input = NEUTRAL_INPUT) {
  for (let i = 0; i < n; i++) {
    for (const c of s.room.sim.cars.values()) s.room.sim.pushInput(c.teamId, c.lastSeq + 1, input);
    s.room.worldLoop(1);
    await s.room.gate!.tickWorld();
  }
}

describe('M7: Hexaware Gate + escort', () => {
  it('assessment open to all squads 50:00–55:00; escort is disclosed and skipped checkpoints score 0 driving points', async () => {
    const s = await makeServer({ map: 'chennai', trafficCount: 0, countdownMs: 0, releaseAtMs: 0 }, { manualClock: true });
    try {
      const A = await fullSquad(s, 'Arrivers');
      const B = await fullSquad(s, 'Escorted');
      const tokA: Record<Role, string> = { CAPTAIN: A.captain.sessionToken, RACER: A.others[0].sessionToken, ENGINEER: A.others[1].sessionToken, DECEIVER: A.others[2].sessionToken };
      const tokB: Record<Role, string> = { CAPTAIN: B.captain.sessionToken, RACER: B.others[0].sessionToken, ENGINEER: B.others[1].sessionToken, DECEIVER: B.others[2].sessionToken };
      const auth = (t: string) => ({ authorization: `Bearer ${t}` });
      await post(s, '/api/team/start-location', { code: 'kelambakkam' }, auth(tokA.CAPTAIN));
      await post(s, '/api/team/start-location', { code: 'kelambakkam' }, auth(tokB.CAPTAIN));
      await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY });
      await s.room.tick();
      const sim = s.room.sim;
      const carA = sim.cars.get(A.captain.teamId)!;
      const carB = sim.cars.get(B.captain.teamId)!;
      const course = sim.map.courses.kelambakkam!;
      const cps = course.checkpoints;
      // A drives the whole course under its own power (checkpoint gates in order); B only the first 3.
      const visit = async (car: typeof carA, i: number) => {
        car.state = { ...car.state, x: cps[i]!.x, z: cps[i]!.z, vx: 0, vz: 0 };
        await step(s);
      };
      for (let i = 0; i < cps.length; i++) await visit(carA, i);
      for (let i = 0; i < 3; i++) await visit(carB, i);
      await settle();
      expect(carA.arrival?.mode).toBe('driven');
      expect(carB.arrival).toBeNull();

      // Before 50:00 the gate is closed.
      expect((await post(s, '/api/squad/gate/code', { code: '1234' }, auth(tokA.CAPTAIN))).body.error).toBe('GATE_CLOSED');
      await goTo(s, 50 * MIN);
      // Open to BOTH squads wherever their car is.
      for (const tok of [tokA, tokB]) {
        const v = (await get(s, '/api/squad/view', auth(tok.ENGINEER))).body.gate;
        expect(v.status).toBe('open');
        expect(v.debug.lines.length).toBeGreaterThan(3);
      }
      expect((await get(s, '/api/squad/view', auth(tokB.CAPTAIN))).body.gate.escortAvailable).toBe(true);
      expect((await post(s, '/api/squad/gate/escort', {}, auth(tokB.ENGINEER))).status).toBe(403);
      expect((await post(s, '/api/squad/gate/escort', {}, auth(tokA.RACER))).body.error).toBe('ARRIVED');
      expect((await post(s, '/api/squad/gate/escort', {}, auth(tokB.RACER))).status).toBe(200);
      expect(carB.auto?.kind).toBe('escort');
      expect(s.room.sim.cars.get(B.captain.teamId)!.auto).not.toBeNull();
      // Escort drives the real course roads (visible: NetCar.au = 'escort') and delivers within ~60 s.
      let ticks = 0;
      while (!carB.arrival && ticks < 1600) {
        await step(s, 20);
        ticks += 20;
        if (carB.auto) expect(sim.net && Math.hypot(carB.state.vx, carB.state.vz)).toBeGreaterThan(20);
      }
      await settle();
      expect(carB.arrival?.mode).toBe('escort');
      expect(ticks * 50).toBeLessThanOrEqual(70_000);
      expect(carB.nextCp).toBe(cps.length); // gates were passed on the real road…
      const driving = async (teamId: string) =>
        (await s.db.db.select().from(scoringEvents).where(eq(scoringEvents.teamId, teamId))).filter((r) => r.category === 'DRIVING');
      // …but only the 3 driven checkpoints score; the 7 escorted ones award 0.
      const dB = await driving(B.captain.teamId);
      expect(new Set(dB.map((r) => r.sourceId)).size).toBe(3);
      expect(dB.reduce((a, r) => a + r.points, 0)).toBe(3 * (SQUAD_RUBRIC.driving.reach + SQUAD_RUBRIC.driving.clean));
      const dA = await driving(A.captain.teamId);
      expect(dA.reduce((a, r) => a + r.points, 0)).toBe(250);

      // The four gate tasks (Racer parking, Engineer debug, Deceiver badges, Captain combined code).
      const ans = s.room.gate!.answers(A.captain.teamId);
      carA.state = { ...carA.state, x: ans.spot.x + 0.5, z: ans.spot.z, heading: ans.spot.heading, vx: 0, vz: 0 };
      await step(s, 25);
      const vA = (await get(s, '/api/squad/view', auth(tokA.RACER))).body.gate;
      expect(vA.parking.points).toBeGreaterThanOrEqual(22);
      expect(vA.myDigit.digit).toBe(Number(ans.code[0]));
      // Captain can't see teammates' digits until revealed; Engineer/Deceiver reveal theirs by submitting.
      expect((await get(s, '/api/squad/view', auth(tokA.ENGINEER))).body.gate.myDigit.digit).toBeNull();
      expect((await post(s, '/api/squad/gate/debug', { answer: ans.debug }, auth(tokA.ENGINEER))).body).toMatchObject({ correct: true, digit: Number(ans.code[1]) });
      expect((await post(s, '/api/squad/gate/auth', { index: ans.forged }, auth(tokA.DECEIVER))).body).toMatchObject({ correct: true, digit: Number(ans.code[2]) });
      expect((await post(s, '/api/squad/gate/code', { code: ans.code }, auth(tokA.ENGINEER))).status).toBe(403);
      expect((await post(s, '/api/squad/gate/code', { code: ans.code }, auth(tokA.CAPTAIN))).body).toMatchObject({ correct: true, points: 25 });
      const gateA = (await s.db.db.select().from(scoringEvents).where(eq(scoringEvents.teamId, A.captain.teamId))).filter((r) => r.category === 'HEXAWARE_GATE');
      expect(gateA.reduce((a, r) => a + r.points, 0)).toBeGreaterThanOrEqual(97);
      // B's Engineer can still play while B was escorted.
      expect((await post(s, '/api/squad/gate/debug', { answer: s.room.gate!.answers(B.captain.teamId).debug }, auth(tokB.ENGINEER))).body.correct).toBe(true);

      // 55:00 — window closes.
      await goTo(s, 55 * MIN);
      expect((await post(s, '/api/squad/gate/auth', { index: 0 }, auth(tokB.DECEIVER))).body.error).toBe('GATE_CLOSED');
    } finally {
      await s.dispose();
    }
  }, 120_000);

  it('squads still on the road at 51:30 are auto-escorted (disclosed)', async () => {
    const s = await makeServer({ map: 'chennai', trafficCount: 0, countdownMs: 0, releaseAtMs: 0 }, { manualClock: true });
    try {
      const q = await fullSquad(s, 'Late');
      await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY });
      await goTo(s, 51.5 * MIN);
      expect(s.room.sim.cars.get(q.captain.teamId)!.auto?.kind).toBe('escort');
    } finally {
      await s.dispose();
    }
  }, 60_000);
});

describe('M7: Welcome Convoy', () => {
  it('all 30 real cars take convoy slots in the same world; every client receives the identical timeline', async () => {
    const s = await makeServer({ map: 'chennai', trafficCount: 0, countdownMs: 0, releaseAtMs: 0 }, { manualClock: true });
    const base = await s.listen(0);
    try {
      const squads = [];
      for (let i = 0; i < 30; i++) squads.push((await post(s, '/api/squads', { squadName: `Convoy${i}`, displayName: 'c' })).body);
      const racerSquad = await post(s, '/api/squads/join', { code: squads[0].joinCode, displayName: 'R', role: 'RACER' });
      const engSquad = await post(s, '/api/squads/join', { code: squads[0].joinCode, displayName: 'E', role: 'ENGINEER' });
      const racer = new Bot('racer', { keepLog: true });
      await racer.connect(base.replace('http', 'ws'), racerSquad.body.sessionToken);
      const eng = new Bot('eng', { keepLog: true });
      await eng.connect(base.replace('http', 'ws'), engSquad.body.sessionToken);
      const host = await connectWs(base);
      host.send({ t: 'host_hello', hostKey: HOST_KEY });
      await host.next((m) => m.t === 'welcome');
      await post(s, '/api/host/start', { force: true }, { 'x-host-key': HOST_KEY });
      await s.room.tick();
      expect(s.room.sim.cars.size).toBe(30);
      await goTo(s, 55 * MIN);
      const sim = s.room.sim;
      // Every real squad car is in convoy mode, on the path, spaced, in one world.
      const lay = gateLayout(sim.map);
      const cars = [...sim.cars.values()];
      expect(cars.every((c) => c.auto?.kind === 'convoy')).toBe(true);
      expect(cars.every((c) => c.arrival !== null)).toBe(true); // assisted entry for those not there
      const tl = s.room.gate!.timeline!;
      expect(tl.slots).toHaveLength(30);
      expect(new Set(tl.slots.map((x) => x.teamId))).toEqual(new Set(cars.map((c) => c.teamId)));
      const ss = tl.slots.map((x) => x.s0).sort((a, b) => a - b);
      for (let i = 1; i < ss.length; i++) expect(ss[i]! - ss[i - 1]!).toBeGreaterThanOrEqual(9);
      for (const c of cars) {
        const near = lay.convoyPath.some((p) => Math.hypot(p.x - c.state.x, p.z - c.state.z) < 4);
        expect(near).toBe(true);
      }
      // Identical timeline for racer, role client and host (same serialized payload, same timestamps).
      const conv = (log: string[]) => log.find((r) => r.startsWith('{"t":"convoy"'))!;
      await until(() => !!conv(racer.log) && !!conv(eng.log) && host.inbox.some((m) => m.t === 'convoy'));
      const h = host.inbox.find((m) => m.t === 'convoy') as Extract<ServerMessage, { t: 'convoy' }>;
      expect(conv(racer.log)).toBe(conv(eng.log));
      expect(JSON.parse(conv(racer.log)).timeline).toEqual(h.timeline);
      expect(h.timeline.startsAtServerTime).toBe(JSON.parse(conv(eng.log)).timeline.startsAtServerTime);
      // The server moves the real cars along the path after the formation hold.
      const before = cars.map((c) => ({ x: c.state.x, z: c.state.z }));
      // 3 s formation hold (60 ticks), then 3 m/s: 200 ticks ≈ 21 m.
      for (let i = 0; i < 200; i++) {
        for (const c of cars) sim.pushInput(c.teamId, c.lastSeq + 1, { ...NEUTRAL_INPUT, throttle: 1, steer: 1 }); // ignored
        s.room.worldLoop(1);
      }
      cars.forEach((c, i) => expect(Math.hypot(c.state.x - before[i]!.x, c.state.z - before[i]!.z)).toBeGreaterThan(5));
      expect(sim.contacts).toHaveLength(0);
      racer.close();
      eng.close();
      host.ws.close();
    } finally {
      await s.dispose();
    }
  }, 120_000);
});

/** Extract text drawn with pdf-lib standard fonts (hex strings inside, possibly Flate-compressed, content streams). */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    let body = Buffer.from(m[1]!, 'latin1');
    try {
      body = inflateSync(body);
    } catch {
      /* not compressed */
    }
    const text = body.toString('latin1');
    for (const t of text.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      const bytes = Buffer.from(t[1]!, 'hex');
      // WinAnsi: 0x97 = em dash
      out.push([...bytes].map((b) => (b === 0x97 ? '—' : b === 0xb7 ? '·' : String.fromCharCode(b))).join(''));
    }
  }
  return out.join('\n');
}

describe('M7: championship + offer letters', () => {
  it('totals derive from scoring_events; predeclared tie-breaks resolve every case', async () => {
    const s = await makeServer();
    try {
      const mk = async (name: string) => (await post(s, '/api/squads', { squadName: name, displayName: 'c' })).body.teamId as string;
      const add = (teamId: string, category: ScoringCategory, points: number, sourceId: string, at?: Date) =>
        s.db.db.insert(scoringEvents).values({ teamId, category, points, reason: 'test', sourceType: sourceId.startsWith('gate') ? 'gate_code' : 'test', sourceId, tick: 0, ...(at ? { createdAt: at } : {}) });
      const [t1, t2, t3, t4, t5, t6, t7, t8] = await Promise.all(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'].map(mk)) as string[];
      // Highest total wins; capped categories (CODING 260 → 200).
      await add(t1!, 'CODING', 260, 'a');
      await add(t1!, 'DRIVING', 100, 'b');
      // t2/t3 tie on 200: TEAM_ASSESSMENTS decides.
      await add(t2!, 'TEAM_ASSESSMENTS', 120, 'a');
      await add(t2!, 'DRIVING', 80, 'b');
      await add(t3!, 'TEAM_ASSESSMENTS', 100, 'a');
      await add(t3!, 'DRIVING', 100, 'b');
      // t4/t5 tie on 150, equal TA: CODING decides.
      await add(t4!, 'CODING', 90, 'a');
      await add(t4!, 'DRIVING', 60, 'b');
      await add(t5!, 'CODING', 80, 'a');
      await add(t5!, 'DRIVING', 70, 'b');
      // t6/t7 tie on 100 with equal TA/coding/driving: earliest final gate submission decides.
      await add(t6!, 'DRIVING', 75, 'b');
      await add(t6!, 'HEXAWARE_GATE', 25, 'gate', new Date('2026-11-20T10:50:30Z'));
      await add(t7!, 'DRIVING', 75, 'b');
      await add(t7!, 'HEXAWARE_GATE', 25, 'gate', new Date('2026-11-20T10:50:10Z'));
      // t8: no rows → 0.
      const st = await computeStandings(s.db.db, s.eventId, s.config.eventSeed);
      const order = st.map((x) => x.teamId);
      expect(st[0]!.teamId).toBe(t1);
      expect(st[0]!.total).toBe(300);
      expect(order.indexOf(t2!)).toBeLessThan(order.indexOf(t3!));
      expect(order.indexOf(t4!)).toBeLessThan(order.indexOf(t5!));
      expect(order.indexOf(t7!)).toBeLessThan(order.indexOf(t6!));
      expect(st.at(-1)!.teamId).toBe(t8);
      expect(st.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      // Totals equal the capped sum of the rows — derived, not stored.
      for (const x of st) {
        const rows = await s.db.db.select().from(scoringEvents).where(eq(scoringEvents.teamId, x.teamId));
        const raw = rows.reduce((a, r) => a + r.points, 0);
        expect(x.total).toBe(x.teamId === t1 ? raw - 60 : raw);
      }
      // Perfect tie on everything → predeclared hash order.
      const [u1, u2] = [await mk('U1'), await mk('U2')];
      await add(u1, 'DRIVING', 10, 'z');
      await add(u2, 'DRIVING', 10, 'z');
      const st2 = await computeStandings(s.db.db, s.eventId, s.config.eventSeed);
      const o2 = st2.map((x) => x.teamId);
      const expectFirst = tieBreakHash(s.config.eventSeed, u1) < tieBreakHash(s.config.eventSeed, u2) ? u1 : u2;
      expect(Math.min(o2.indexOf(u1), o2.indexOf(u2))).toBe(o2.indexOf(expectFirst));
      expect((await get(s, '/api/standings')).body.standings.map((x: { teamId: string }) => x.teamId)).toEqual(o2);
    } finally {
      await s.dispose();
    }
  });

  it('58:00 reveal → one PDF per player with all required fields and the exact disclaimer', async () => {
    const s = await makeServer({ map: 'chennai', trafficCount: 0, countdownMs: 0, releaseAtMs: 0 }, { manualClock: true });
    const base = await s.listen(0);
    try {
      const sq = [await fullSquad(s, 'Letters A'), await fullSquad(s, 'Letters B')];
      const host = await connectWs(base);
      host.send({ t: 'host_hello', hostKey: HOST_KEY });
      await host.next((m) => m.t === 'welcome');
      await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY });
      await s.room.tick();
      expect((await get(s, '/api/offer-letter', { authorization: `Bearer ${sq[0]!.captain.sessionToken}` })).status).toBe(404);
      for (const t of [50, 55, 58]) await goTo(s, t * MIN);
      const champ = (await host.next((m) => m.t === 'championship')) as Extract<ServerMessage, { t: 'championship' }>;
      expect(champ.standings).toHaveLength(2);
      const allPlayers = await s.db.db.select().from(players).innerJoin(teams, eq(players.teamId, teams.id)).where(eq(teams.eventId, s.eventId));
      const letters = await s.db.db.select().from(offerLetters);
      expect(letters).toHaveLength(allPlayers.length); // one per player
      expect(new Set(letters.map((l) => l.playerId)).size).toBe(8);
      for (const q of sq) {
        for (const [role, p] of [['CAPTAIN', q.captain], ['RACER', q.others[0]], ['ENGINEER', q.others[1]], ['DECEIVER', q.others[2]]] as const) {
          const res = await s.app.inject({ method: 'GET', url: '/api/offer-letter', headers: { authorization: `Bearer ${p.sessionToken}` } });
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toBe('application/pdf');
          const body = res.rawPayload;
          expect(body.subarray(0, 5).toString()).toBe('%PDF-');
          const text = pdfText(body);
          expect(text).toContain(OFFER_LETTER_DISCLAIMER);
          expect(OFFER_LETTER_DISCLAIMER).toBe('COMMEMORATIVE GAME OFFER LETTER — NOT AN EMPLOYMENT OFFER');
          const row = allPlayers.find((x) => x.players.id === p.playerId)!;
          const st = champ.standings.find((x) => x.teamId === row.teams.id)!;
          for (const field of [row.players.displayName, row.teams.name, role === 'CAPTAIN' ? 'P4 — Captain' : role === 'RACER' ? 'P1 — Racer' : role === 'ENGINEER' ? 'P2 — Engineer' : 'P3 — Deceiver', 'Vortex GT', `${st.total} / 1000`, 'Assisted entry for the Welcome Convoy']) {
            expect(text, field).toContain(field);
          }
          expect(text).toMatch(/Achievement:[\s\S]*(Champion Squad|Podium Finisher)/);
        }
      }
      host.ws.close();
    } finally {
      await s.dispose();
    }
  }, 120_000);
});

describe('security: the event seed never reaches a client', () => {
  it('welcome/world/api expose only a derived world seed', async () => {
    const s = await makeServer({ eventSeed: '987654321' });
    const base = await s.listen(0);
    try {
      const q = await fullSquad(s, 'Seed');
      const bot = new Bot('b', { keepLog: true });
      await bot.connect(base.replace('http', 'ws'), q.others[0].sessionToken);
      const ev = await get(s, '/api/event');
      expect(ev.body.worldSeed).toBeTruthy();
      expect(JSON.stringify(ev.body)).not.toContain('987654321');
      expect(bot.seed).not.toContain('987654321');
      expect(bot.log.join('\n')).not.toContain('987654321');
      expect(bot.seed).toBe(s.room.sim.opts.seed);
      bot.close();
    } finally {
      await s.dispose();
    }
  });
});
