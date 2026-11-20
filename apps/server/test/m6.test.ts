/**
 * M6 acceptance: fuel & pit stops, roadside recovery, Redline Director, shared weather.
 */
import { describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { Bot } from '@redline/loadtest';
import { auditLogs, fuelTransactions, pitStops, scoringEvents } from '@redline/db';
import { BALANCE, BEATS, NEUTRAL_INPUT, createRng, type Role, type ServerMessage, type SquadView } from '@redline/shared';
import { chennaiMap } from '@redline/shared/map/chennai';
import { chooseClosure, closureCandidates, closureLeavesRoutes, reachableToDest } from '../src/director/closures';
import { HOST_KEY, connectWs, fullSquad, makeServer, post, until, type TestServer } from './helpers';

const MIN = 60_000;
const settle = () => new Promise((r) => setTimeout(r, 40));

async function goTo(s: TestServer, ms: number) {
  s.advance(ms - s.room.clockState().elapsedMs);
  await s.room.tick();
}
/** One deterministic world step + pit processing. */
async function step(s: TestServer, n = 1) {
  for (let i = 0; i < n; i++) {
    for (const c of s.room.sim.cars.values()) s.room.sim.pushInput(c.teamId, c.lastSeq + 1, NEUTRAL_INPUT);
    s.room.worldLoop(1);
    await s.room.pit!.tick();
  }
}
const station = (s: TestServer) => s.room.sim.map.stations[0]!;
const intoStation = (s: TestServer, teamId: string, offset = 0) => {
  const st = station(s);
  const car = s.room.sim.cars.get(teamId)!;
  car.state = { ...car.state, x: st.x + offset, z: st.z, vx: 0, vz: 0 };
};

/** What the Engineer does: find the reading outside its printed spec. */
function outOfSpec(readings: string[], options: string[]): string {
  const i = readings.findIndex((r) => {
    const v = Number(r.match(/(-?[\d.]+) (?:bar|mm|°C)/)![1]);
    const range = r.match(/spec ([\d.]+)–([\d.]+)/);
    if (range) return v < Number(range[1]) || v > Number(range[2]);
    return v < Number(r.match(/spec ≥ ([\d.]+)/)![1]);
  });
  return options[i]!;
}

describe('M6: pit stop — 6 steps with four roles', () => {
  it('enter → Captain selects → Engineer diagnoses → Deceiver spots the false report → Captain confirms → back on the road', async () => {
    const s = await makeServer({ countdownMs: 0, releaseAtMs: 0, trafficCount: 0 }, { manualClock: true });
    const base = await s.listen(0);
    try {
      const sq = await fullSquad(s, 'PitCrew');
      const tok: Record<Role, string> = { CAPTAIN: sq.captain.sessionToken, RACER: sq.others[0].sessionToken, ENGINEER: sq.others[1].sessionToken, DECEIVER: sq.others[2].sessionToken };
      const bots = {} as Record<Role, Bot>;
      for (const r of Object.keys(tok) as Role[]) {
        bots[r] = new Bot(r, { keepLog: true });
        await bots[r].connect(base.replace('http', 'ws'), tok[r]);
      }
      await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY });
      await goTo(s, 17 * MIN + 30_000); // inside service window 1
      const teamId = sq.captain.teamId;
      const car = s.room.sim.cars.get(teamId)!;
      car.state = { ...car.state, fuel: 30, health: 70 };
      const credits0 = s.room.squad!.credits(teamId);
      const view = (r: Role) => bots[r].lastSquad as SquadView;
      const auth = (r: Role) => ({ authorization: `Bearer ${tok[r]}` });

      // Step 1: the Racer pulls into the station zone and stops.
      intoStation(s, teamId);
      await step(s);
      await settle();
      expect(view('RACER').pit!.stage).toBe('in_bay');
      expect(view('RACER').pit!.steps.enter).toBe(true);
      expect(car.held?.reason).toBe('pit');
      const bayPos = station(s).bays[view('RACER').pit!.bay!]!;
      expect(car.state.x).toBeCloseTo(bayPos.x);

      // Role-filtered: only the Engineer sees readings, only the Deceiver sees reports.
      expect(view('ENGINEER').pit!.diagnostics!.readings).toHaveLength(4);
      expect(view('CAPTAIN').pit!.diagnostics).toBeUndefined();
      expect(view('DECEIVER').pit!.reports!.items).toHaveLength(3);
      expect(view('ENGINEER').pit!.reports).toBeUndefined();

      // Wrong roles are rejected for every step.
      expect((await post(s, '/api/squad/pit/plan', { fuelPct: 10 }, auth('RACER'))).status).toBe(403);
      expect((await post(s, '/api/squad/pit/diagnose', { answer: 'Tyres' }, auth('CAPTAIN'))).status).toBe(403);
      expect((await post(s, '/api/squad/pit/verify', { index: 0 }, auth('ENGINEER'))).status).toBe(403);
      expect((await post(s, '/api/squad/pit/confirm', {}, auth('RACER'))).status).toBe(403);
      expect((await post(s, '/api/squad/pit/confirm', {}, auth('CAPTAIN'))).body.error).toBe('NO_PLAN');

      // Step 3: Engineer reads the specs.
      const d = view('ENGINEER').pit!.diagnostics!;
      const diagnosed = outOfSpec(d.readings, d.options);
      expect((await post(s, '/api/squad/pit/diagnose', { answer: diagnosed }, auth('ENGINEER'))).status).toBe(200);
      // Step 4: Deceiver compares the mechanics' reports with the real car.
      const items = view('DECEIVER').pit!.reports!.items;
      const truth = [car.state.fuel, car.state.health, car.state.tires].map(Math.round);
      const falseIdx = items.findIndex((t, i) => Number(t.match(/(\d+)%/)![1]) !== truth[i]);
      expect((await post(s, '/api/squad/pit/verify', { index: falseIdx }, auth('DECEIVER'))).status).toBe(200);
      // Step 2: Captain plans to cover the diagnosed system (+ fuel), Step 5: confirms.
      const plan = { fuelPct: 40, repair: diagnosed === 'Cooling' || diagnosed === 'Brakes', tyres: diagnosed === 'Tyres' };
      expect((await post(s, '/api/squad/pit/plan', { fuelPct: 90 }, auth('CAPTAIN'))).body.error).toBe('INVALID_PLAN'); // > tank space
      const planned = await post(s, '/api/squad/pit/plan', plan, auth('CAPTAIN'));
      expect(planned.status).toBe(200);
      const conf = await post(s, '/api/squad/pit/confirm', {}, auth('CAPTAIN'));
      expect(conf.status).toBe(200);
      await settle();
      expect(view('CAPTAIN').pit!.stage).toBe('servicing');
      expect(view('CAPTAIN').pit!.steps).toMatchObject({ select: true, diagnose: true, verify: true, confirm: true, release: false });
      expect(s.room.squad!.credits(teamId)).toBe(credits0 - planned.body.cost);

      // Step 6: service time elapses → car released onto the road at the station exit, serviced.
      await step(s, Math.ceil(conf.body.serviceEndsInMs / 50) + 1);
      await settle();
      expect(car.held).toBeNull();
      expect(car.state.x).toBeCloseTo(station(s).exit.x);
      expect(car.state.fuel).toBeCloseTo(70, 0);
      if (plan.repair) expect(car.state.health).toBe(100);
      if (plan.tyres) expect(car.state.tires).toBe(100);
      expect(view('RACER').pit!.steps.release).toBe(true);
      expect(view('RACER').pit!.result).toMatchObject({ diagnosisCorrect: true, falseSpotted: true });

      const score = await s.db.db.select().from(scoringEvents).where(eq(scoringEvents.teamId, teamId));
      expect(score.find((r) => r.category === 'FUEL_MANAGEMENT')?.points).toBe(25);
      expect(score.find((r) => r.category === 'CAPTAIN_STRATEGY')?.points).toBe(25);
      expect(await s.db.db.select().from(fuelTransactions).where(eq(fuelTransactions.teamId, teamId))).toHaveLength(1);
      const [row] = await s.db.db.select().from(pitStops).where(eq(pitStops.teamId, teamId));
      expect(row!.stage).toBe('done');
      // Driving again after release.
      for (let i = 0; i < 20; i++) {
        s.room.sim.pushInput(teamId, car.lastSeq + 1, { ...NEUTRAL_INPUT, throttle: 1 });
        s.room.worldLoop(1);
      }
      expect(Math.hypot(car.state.vx, car.state.vz)).toBeGreaterThan(3);
      for (const b of Object.values(bots)) b.close();
    } finally {
      await s.dispose();
    }
  }, 60_000);
});

describe('M6: shared station — FIFO, max dwell, never blocked', () => {
  it('6 squads arrive: 4 bays in arrival order, 2 queued FIFO; idle stops are force-released at 60 s; everyone gets served', async () => {
    const s = await makeServer({ countdownMs: 0, releaseAtMs: 0, trafficCount: 0 }, { manualClock: true });
    try {
      const teams: string[] = [];
      for (let i = 0; i < 6; i++) teams.push((await post(s, '/api/squads', { squadName: `Q${i}`, displayName: 'c' })).body.teamId);
      await post(s, '/api/host/start', { force: true }, { 'x-host-key': HOST_KEY });
      await s.room.tick();
      for (const t of teams) s.room.sim.cars.get(t)!.state.fuel = 50;
      // Arrive one per tick, all overlapping in the zone (non-collidable there).
      for (let i = 0; i < 6; i++) {
        intoStation(s, teams[i]!, i * 0.5);
        await step(s);
        // Cars overlapping inside the station never collide (the test grid's start row may still touch).
        const inStation = new Set(teams.slice(0, i + 1));
        expect(s.room.sim.contacts.filter((c) => inStation.has(c.a) || inStation.has(c.b))).toHaveLength(0);
      }
      const pit = s.room.pit!;
      const stageOf = (t: string) => pit.viewFor(t, 'RACER');
      expect(teams.slice(0, 4).map((t) => stageOf(t)!.stage)).toEqual(['in_bay', 'in_bay', 'in_bay', 'in_bay']);
      expect(stageOf(teams[4]!)!).toMatchObject({ stage: 'queued', queuePosition: 1 });
      expect(stageOf(teams[5]!)!).toMatchObject({ stage: 'queued', queuePosition: 2 });
      // Nobody acts: max dwell (60 s) releases the first four with an affordable refuel — the station can't be blocked.
      await step(s, BALANCE.pit.maxDwellMs / 50 + 2);
      for (const t of teams.slice(0, 4)) {
        expect(stageOf(t)!.stage).toBe('done');
        expect(s.room.sim.cars.get(t)!.state.fuel).toBeCloseTo(100, 0);
      }
      expect(stageOf(teams[4]!)!.stage).toBe('in_bay');
      expect(stageOf(teams[5]!)!.stage).toBe('in_bay');
      await step(s, BALANCE.pit.maxDwellMs / 50 + 2);
      for (const t of teams) expect(stageOf(t)!.stage).toBe('done');
      // Dwell never exceeded the cap.
      const rows = await s.db.db.select().from(pitStops);
      for (const r of rows) expect((r.outcome as { dwellMs: number }).dwellMs).toBeLessThanOrEqual(BALANCE.pit.maxDwellMs + 100);
    } finally {
      await s.dispose();
    }
  }, 60_000);
});

describe('M6: fuel exhaustion', () => {
  it('an empty tank triggers a disclosed roadside recovery (8 s, +15 % fuel, 50 credits) — never elimination', async () => {
    const s = await makeServer({ countdownMs: 0, releaseAtMs: 0, trafficCount: 0 }, { manualClock: true });
    try {
      const t = (await post(s, '/api/squads', { squadName: 'Dry', displayName: 'c' })).body.teamId;
      await post(s, '/api/host/start', { force: true }, { 'x-host-key': HOST_KEY });
      await s.room.tick();
      const car = s.room.sim.cars.get(t)!;
      car.state = { ...car.state, fuel: 0.02 };
      const credits0 = s.room.squad!.credits(t);
      let sawHeld = false;
      for (let i = 0; i < 60 && !car.held; i++) {
        s.room.sim.pushInput(t, car.lastSeq + 1, { ...NEUTRAL_INPUT, throttle: 1 });
        s.room.worldLoop(1);
      }
      expect(car.held?.reason).toBe('recovery');
      expect(car.state.fuel).toBe(0);
      for (let i = 0; i < BALANCE.recovery.delayMs / 50 + 2; i++) {
        sawHeld ||= !!car.held;
        s.room.sim.pushInput(t, car.lastSeq + 1, { ...NEUTRAL_INPUT, throttle: 1 });
        s.room.worldLoop(1);
        await s.room.pit!.tick();
      }
      expect(sawHeld).toBe(true);
      expect(car.held).toBeNull();
      expect(car.state.fuel).toBeGreaterThanOrEqual(BALANCE.recovery.fuelPct - 0.5);
      expect(s.room.squad!.credits(t)).toBe(credits0 - BALANCE.recovery.cost);
      const tx = await s.db.db.select().from(fuelTransactions).where(eq(fuelTransactions.teamId, t));
      expect(tx[0]!.reason).toBe('roadside_recovery');
      for (let i = 0; i < 40; i++) {
        s.room.sim.pushInput(t, car.lastSeq + 1, { ...NEUTRAL_INPUT, throttle: 1 });
        s.room.worldLoop(1);
      }
      expect(Math.hypot(car.state.vx, car.state.vz)).toBeGreaterThan(5); // still racing
    } finally {
      await s.dispose();
    }
  }, 60_000);
});

describe('M6: Redline Director', () => {
  async function run(seed: string) {
    const s = await makeServer({ map: 'chennai', trafficCount: 0, countdownMs: 0, eventSeed: seed }, { manualClock: true });
    try {
      await post(s, '/api/squads', { squadName: 'D', displayName: 'c' });
      await post(s, '/api/host/start', { force: true }, { 'x-host-key': HOST_KEY });
      const snaps: { rain: boolean; closures: number; atMs: number }[] = [];
      for (let t = 0; t <= 60 * MIN; t += 5000) {
        await goTo(s, t);
        const st = s.room.director!.state;
        snaps.push({ rain: st.rain, closures: st.closures.length, atMs: t });
      }
      const audit = await s.db.db.select().from(auditLogs).where(and(eq(auditLogs.eventId, s.eventId), eq(auditLogs.action, 'beat.fire'))).orderBy(asc(auditLogs.at));
      return { log: s.room.director!.log, audit: audit.map((a) => a.payload as { beat: string; decision: string }), snaps };
    } finally {
      await s.dispose();
    }
  }

  it('fast-forward 60 min: every beat fires exactly once, in order; same seed → identical beat log', async () => {
    const a = await run('20261119');
    const b = await run('20261119');
    expect(a.log.map((l) => l.beat)).toEqual(BEATS.map((x) => x.id));
    expect(a.audit.map((l) => l.beat)).toEqual(BEATS.map((x) => x.id));
    expect(a.log).toEqual(b.log);
    expect(a.audit.map((x) => x.decision)).toEqual(a.log.map((x) => x.decision));
    // Effects really happened in the shared world, and expired.
    expect(a.log.find((l) => l.beat === 'ROUTE_LOCKDOWN')!.decision).toMatch(/^closure:/);
    expect(a.snaps.find((x) => x.atMs === 32 * MIN)!.closures).toBe(1);
    expect(a.snaps.find((x) => x.atMs === 38 * MIN)!.closures).toBe(0);
    expect(a.snaps.find((x) => x.atMs === 36 * MIN)!.rain).toBe(false);
    expect(a.snaps.find((x) => x.atMs === 40 * MIN)!.rain).toBe(true);
    expect(a.snaps.find((x) => x.atMs === 46 * MIN)!.rain).toBe(false);
    const c = await run('different-seed-7');
    expect(c.log.map((l) => l.decision)).not.toEqual(a.log.map((l) => l.decision));
  }, 120_000);

  it('a road closure always leaves a valid route for every squad (300 seeds), and invalid closures are rejected', () => {
    const map = chennaiMap();
    expect(closureCandidates(map).length).toBeGreaterThan(10);
    const net = map.net;
    for (let i = 0; i < 300; i++) {
      const { closure } = chooseClosure(map, createRng(`seed-${i}`, 'beat:ROUTE_LOCKDOWN'), 1);
      expect(closure).not.toBeNull();
      expect(closureLeavesRoutes(map, closure!.edges)).toBe(true);
      // Independent check: every course start still reaches Hexaware avoiding the closed edges.
      const ok = reachableToDest(net, map.destination.node, new Set(closure!.edges));
      for (const st of map.starts) expect(ok[st.node]).toBe(1);
    }
    // Cutting every road into the gate must be rejected.
    const gateEdges = net.edges.filter((e) => e.a === map.destination.node || e.b === map.destination.node).map((e) => e.id);
    expect(closureLeavesRoutes(map, gateEdges)).toBe(false);
  });
});

describe('M6: shared weather', () => {
  it('Monsoon Protocol reaches every client (racer, role client, host) in ONE global update', async () => {
    const s = await makeServer({ countdownMs: 0, releaseAtMs: 0, trafficCount: 0 }, { manualClock: true });
    const base = await s.listen(0);
    try {
      const sq = await fullSquad(s, 'Rain');
      const racer = new Bot('racer', { keepLog: true });
      await racer.connect(base.replace('http', 'ws'), sq.others[0].sessionToken);
      const eng = new Bot('eng', { keepLog: true });
      await eng.connect(base.replace('http', 'ws'), sq.others[1].sessionToken);
      const host = await connectWs(base);
      host.send({ t: 'host_hello', hostKey: HOST_KEY });
      await host.next((m) => m.t === 'welcome');
      await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY });
      await goTo(s, 36 * MIN + 59_000);
      expect(s.room.sim.rain).toBe(false);
      await goTo(s, 37 * MIN);
      expect(s.room.sim.rain).toBe(true);
      const firstRain = (log: string[]) => log.find((r) => r.includes('"t":"world"') && r.includes('"rain":true'));
      await until(() => !!firstRain(racer.log) && !!firstRain(eng.log) && host.inbox.some((m) => m.t === 'world' && m.state.rain));
      const r = JSON.parse(firstRain(racer.log)!);
      const e = JSON.parse(firstRain(eng.log)!);
      const h = host.inbox.find((m) => m.t === 'world' && m.state.rain) as Extract<ServerMessage, { t: 'world' }>;
      // Same revision, same payload, same announcement for everyone.
      expect(r.state.rev).toBe(e.state.rev);
      expect(r.state.rev).toBe(h.state.rev);
      expect(r).toEqual(e);
      expect(r.state.announcement.beat).toBe('MONSOON_PROTOCOL');
      // Racer snapshots after the update carry the same weather (grip applied by the shared model).
      s.room.sim.pushInput([...s.room.sim.cars.keys()][0]!, 1, NEUTRAL_INPUT);
      s.room.worldLoop(1);
      await until(() => racer.lastSnap?.rain === true);
      racer.close();
      eng.close();
      host.ws.close();
    } finally {
      await s.dispose();
    }
  }, 60_000);
});
