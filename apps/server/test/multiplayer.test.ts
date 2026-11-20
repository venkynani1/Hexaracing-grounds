/**
 * M3 acceptance: actual multiplayer in ONE world (DESIGN §4/§5, MILESTONES M3).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Bot, percentile, registerSquad } from '@redline/loadtest';
import {
  BALANCE,
  NEUTRAL_INPUT,
  Predictor,
  createRng,
  isOnRoad,
  type NetCar,
  type ServerMessage,
  type Snapshot,
  type VehicleInput,
} from '@redline/shared';
import { RAMMING, STUCK, WorldSim, type SimCar } from '../src/world/WorldSim';
import { HOST_KEY, connectWs, makeServer, post, until, type TestServer } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface World {
  s: TestServer;
  base: string;
  bots: Bot[];
  teamIds: string[];
  truth: Map<number, Map<string, { x: number; z: number }>>;
  close(): Promise<void>;
}

/** Real server (manual clock, deterministic ticks) + N racer bots over real WebSockets. */
async function startWorld(n: number, over: Record<string, unknown> = {}): Promise<World> {
  const s = await makeServer({ countdownMs: 1000, releaseAtMs: 0, trafficCount: 60, joinAttemptsPerMinute: 10_000, ...over }, { manualClock: true });
  const base = await s.listen(0);
  const squads = [];
  for (let i = 0; i < n; i++) squads.push(await registerSquad(base, `Sq${i}`));
  const bots = await Promise.all(
    squads.map(async (q, i) => {
      const b = new Bot(`bot${i}`, { keepSnaps: true });
      await b.connect(base.replace('http', 'ws'), q.racer.sessionToken);
      return b;
    }),
  );
  expect((await post(s, '/api/host/start', { force: true }, { 'x-host-key': HOST_KEY })).status).toBe(200);
  s.advance(1000);
  await s.room.tick();
  expect(s.room.clockState().status).toBe('LIVE');
  for (let i = 0; i < 4; i++) s.room.worldLoop(0); // first snapshot (unstepped frames go out at 5 Hz)
  await until(() => bots.every((b) => b.predictor?.state), 5000);
  return {
    s,
    base,
    bots,
    teamIds: squads.map((q) => q.captain.teamId),
    truth: new Map(),
    async close() {
      for (const b of bots) b.close();
      await s.dispose();
    },
  };
}

/** One synchronized tick: every bot sends its input, the server steps once, every bot receives the snapshot. */
async function tickAll(w: World, input: (i: number) => Partial<VehicleInput>) {
  const t0 = Date.now();
  const seqs = w.bots.map((b, i) => b.drive(input(i)));
  await until(() => w.bots.every((_b, i) => w.s.room.sim.cars.get(w.teamIds[i]!)!.lastSeq >= seqs[i]!));
  w.s.room.worldLoop(1);
  const tick = w.s.room.sim.tick;
  w.truth.set(tick, new Map([...w.s.room.sim.cars.values()].map((c) => [c.teamId, { x: c.state.x, z: c.state.z }])));
  await until(() => w.bots.every((b) => b.snaps.has(tick)));
  // Stay under the 60 msg/s per-connection ceiling.
  const spent = Date.now() - t0;
  if (spent < 22) await sleep(22 - spent);
  return tick;
}

describe('M3: N racers in ONE world (5 → 10 → 20 → 30)', () => {
  for (const N of [5, 10, 20, 30]) {
    it(`${N} bots: one room id, one tick counter, every near car in every snapshot at server-truth positions (±0.5 m)`, async () => {
      const w = await startWorld(N);
      try {
        expect(new Set(w.bots.map((b) => b.roomId))).toEqual(new Set([w.s.room.roomId]));
        expect(w.s.room.sim.cars.size).toBe(N);
        const ticks: number[] = [];
        for (let k = 0; k < 30; k++) ticks.push(await tickAll(w, (i) => ({ throttle: 0.6 + (i % 3) * 0.2, steer: ((i % 5) - 2) * 0.02 })));
        const cidToTeam = new Map([...w.s.room.sim.cars.values()].map((c) => [c.cid, c.teamId]));
        let checked = 0;
        for (const tick of ticks) {
          const truth = w.truth.get(tick)!;
          w.bots.forEach((b, i) => {
            const snap = b.snaps.get(tick)!;
            expect(snap.tick).toBe(tick); // one shared tick counter
            const mine = truth.get(w.teamIds[i]!)!;
            expect(Math.hypot(snap.me!.x - mine.x, snap.me!.z - mine.z)).toBeLessThanOrEqual(0.5);
            const seen = new Map(snap.cars.map((c) => [cidToTeam.get(c[0])!, c]));
            for (const [team, p] of truth) {
              if (team === w.teamIds[i]) continue;
              if (Math.hypot(p.x - mine.x, p.z - mine.z) > BALANCE.nearRadius) continue;
              const c = seen.get(team);
              expect(c, `${b.label} missing ${team} at tick ${tick}`).toBeDefined();
              expect(Math.hypot(c![1] - p.x, c![2] - p.z)).toBeLessThanOrEqual(0.5);
              checked++;
            }
          });
        }
        expect(checked).toBeGreaterThanOrEqual(30 * N * Math.min(N - 1, 1));
        // Cars actually moved in the shared world.
        const first = w.truth.get(ticks[0]!)!;
        const last = w.truth.get(ticks.at(-1)!)!;
        for (const t of w.teamIds) expect(Math.hypot(last.get(t)!.x - first.get(t)!.x, last.get(t)!.z - first.get(t)!.z)).toBeGreaterThan(1);
        const kbps = w.bots.map((b) => b.stats.bytes / (30 * 0.05) / 1024);
        console.log(`[M3] N=${N}: avg downstream ≈ ${(kbps.reduce((a, b) => a + b, 0) / N).toFixed(1)} KB/s per racer (all cars bunched on the start grid)`);
      } finally {
        await w.close();
      }
    }, 120_000);
  }
});

describe('M3: overtaking on the same edge', () => {
  it('two bots see each other every tick, and the overtake changes order identically on both clients', async () => {
    const w = await startWorld(2, { trafficCount: 0 });
    try {
      const [A, B] = w.bots as [Bot, Bot];
      // Phase 1: A pulls ahead. Phase 2: A eases off, B goes flat out and passes.
      for (let k = 0; k < 110; k++) await tickAll(w, (i) => (k < 25 ? (i === 0 ? { throttle: 1 } : {}) : i === 0 ? { throttle: 0.25 } : { throttle: 1 }));
      const orders: string[] = [];
      for (const tick of w.truth.keys()) {
        const view = (bot: Bot) => {
          const s = bot.snaps.get(tick)!;
          expect(s.cars, `${bot.label} must see the other squad at tick ${tick}`).toHaveLength(1);
          const other = s.cars[0]!;
          // Spawn edge runs east (+x): larger x = further ahead.
          return bot === A ? (s.me!.x > other[1] ? 'A' : 'B') : other[1] > s.me!.x ? 'A' : 'B';
        };
        const a = view(A);
        const b = view(B);
        expect(a).toBe(b);
        orders.push(a);
      }
      expect(orders[30]).toBe('A');
      expect(orders.at(-1)).toBe('B');
      const changes = orders.filter((o, i) => i > 0 && o !== orders[i - 1]).length;
      expect(changes).toBeGreaterThanOrEqual(1);
    } finally {
      await w.close();
    }
  }, 60_000);
});

describe('M3: collisions and anti-ramming', () => {
  const setup = () => {
    const sim = new WorldSim({ seed: 'col', trafficCount: 0 });
    sim.spawn([{ teamId: 'a', name: 'A' }, { teamId: 'b', name: 'B' }]);
    sim.released = true;
    let seq = 0;
    const step = () => {
      seq++;
      for (const c of sim.cars.values()) sim.pushInput(c.teamId, seq, NEUTRAL_INPUT);
      sim.step();
    };
    return { sim, a: sim.cars.get('a')!, b: sim.cars.get('b')!, step };
  };
  const place = (c: SimCar, x: number, z: number, vx: number) => (c.state = { ...c.state, x, z, heading: Math.PI / 2, vx, vz: 0 });

  it('both cars receive identical (equal and opposite) server-resolved impulses; damage is capped', () => {
    const { a, b, step, sim } = setup();
    const z = a.state.z;
    place(a, 0, z, 30);
    place(b, 3.5, z, 0);
    step();
    const c = sim.contacts[0]!;
    expect(c).toBeDefined();
    expect(c.dvA[0]).toBeCloseTo(-c.dvB[0], 9);
    expect(c.dvA[1]).toBeCloseTo(-c.dvB[1], 9);
    expect(100 - a.state.health).toBeLessThanOrEqual(15);
    expect(100 - b.state.health).toBeLessThanOrEqual(15);
    expect(a.state.health).toBe(b.state.health);
  });

  it('repeated high-impulse hits on the same squad → aggressor ghosted 5 s, penalty logged, victim gets a free reset', () => {
    const { a, b, step, sim } = setup();
    const penalties: unknown[] = [];
    sim.onPenalty = (p) => penalties.push(p);
    const z = a.state.z;
    for (let hit = 0; hit < RAMMING.hits; hit++) {
      place(b, 100, z, 0);
      place(a, 94, z, 14);
      for (let i = 0; i < 6 && !sim.contacts.length; i++) step();
      expect(sim.contacts[0]?.aggressor).toBe('a');
      for (let i = 0; i < 20; i++) step(); // 1 s between hits
    }
    expect(sim.penalties).toHaveLength(1);
    expect(penalties).toHaveLength(1);
    expect(sim.penalties[0]).toMatchObject({ teamId: 'a', victimTeamId: 'b', reason: 'ramming' });
    expect(sim.isGhost(a)).toBe(true);
    expect(sim.isGhost(b)).toBe(false);
    expect(b.freeReset).toBe(true);
    expect(sim.canReset(b)).toBe(true);
    // While ghosted, A passes through B: no contact.
    place(b, 100, z, 0);
    place(a, 97, z, 10);
    step();
    step();
    expect(sim.contacts).toHaveLength(0);
    // Ghost-out expires after 5 s and collisions resume.
    for (let i = 0; i < RAMMING.ghostMs / 50; i++) step();
    expect(sim.isGhost(a)).toBe(false);
    // Victim uses the free reset once.
    expect(sim.resetCar('b', 'player')).toBe(true);
    expect(b.freeReset).toBe(false);
    expect(isOnRoad(sim.net, b.state.x, b.state.z)).toBe(true);
  });

  it('a mutual head-on collision has no aggressor and no penalty', () => {
    const { a, b, step, sim } = setup();
    const z = a.state.z;
    for (let hit = 0; hit < 4; hit++) {
      place(a, 96, z, 12);
      place(b, 104, z, -12);
      b.state = { ...b.state, heading: -Math.PI / 2 };
      for (let i = 0; i < 6 && !sim.contacts.length; i++) step();
      expect(sim.contacts[0]?.aggressor ?? null).toBeNull();
      for (let i = 0; i < 20; i++) step();
    }
    expect(sim.penalties).toHaveLength(0);
  });

  it('a stuck car is offered a safe reset after 3 s and auto-reset after 6 s', () => {
    const sim = new WorldSim({ seed: 'stuck', trafficCount: 0 });
    sim.spawn([{ teamId: 'a', name: 'A' }]);
    sim.released = true;
    const car = sim.cars.get('a')!;
    const bld = sim.buildings[0]!;
    // Nose against the west wall of a building, throttling into it.
    car.state = { ...car.state, x: bld.x - bld.w / 2 - 2.05, z: bld.z, heading: Math.PI / 2, vx: 0, vz: 0 };
    let seq = 0;
    const throttle = (ticks: number) => {
      for (let i = 0; i < ticks; i++) sim.pushInput('a', ++seq, { ...NEUTRAL_INPUT, throttle: 1 }), sim.step();
    };
    throttle(STUCK.offerMs / 50 + 2);
    expect(sim.canReset(car)).toBe(true);
    throttle((STUCK.autoMs - STUCK.offerMs) / 50 + 2);
    expect(isOnRoad(sim.net, car.state.x, car.state.z)).toBe(true);
    expect(car.stuckMs).toBeLessThan(STUCK.offerMs);
  });
});

describe('M3: prediction & reconciliation under latency and loss', () => {
  it('150 ms one-way latency (+0–30 ms jitter), 2% loss each way: own-car correction error p95 < 1 m', () => {
    const sim = new WorldSim({ seed: 'lat', trafficCount: 100 });
    sim.spawn([{ teamId: 'me', name: 'Me' }]);
    sim.released = true;
    const car = sim.cars.get('me')!;
    const pred = new Predictor(sim.net, sim.buildings);
    const rng = createRng('netsim');
    const LAT = 150;
    const JITTER = 30;
    const LOSS = 0.02;
    type Msg = { at: number; deliver: () => void };
    const toServer: Msg[] = [];
    const toClient: Msg[] = [];
    let lastUp = 0;
    let lastDown = 0;
    // Ordered (TCP-like) channel with jitter; 2% of messages dropped outright (worst case).
    const sendUp = (t: number, fn: () => void) => {
      if (rng.next() < LOSS) return;
      lastUp = Math.max(lastUp, t + LAT + rng.next() * JITTER);
      toServer.push({ at: lastUp, deliver: fn });
    };
    const sendDown = (t: number, fn: () => void) => {
      if (rng.next() < LOSS) return;
      lastDown = Math.max(lastDown, t + LAT + rng.next() * JITTER);
      toClient.push({ at: lastDown, deliver: fn });
    };
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const r4 = (v: number) => Math.round(v * 10000) / 10000;
    const snapshot = (): Snapshot => {
      const s = car.state;
      const me: NetCar = { cid: 1, id: 'me', n: 'Me', vc: 'vortex_gt', x: r2(s.x), z: r2(s.z), h: r4(s.heading), vx: r2(s.vx), vz: r2(s.vz), f: r2(s.fuel), hp: r2(s.health), tr: r2(s.tires), ni: r2(s.nitro), br: false, g: false, rs: false, bf: [], cs: '', cp: 0, hd: false };
      return { t: 'snap', tick: sim.tick, simMs: sim.simMs, serverTime: 0, rain: false, released: true, ack: car.ackSeq, me, cars: [], traffic: [] };
    };
    const corrections: number[] = [];
    let k = 0;
    const END = 120_000;
    for (let t = 0; t <= END; t++) {
      for (const q of [toServer, toClient]) while (q.length && q[0]!.at <= t) q.shift()!.deliver();
      if (t % 50 === 0) {
        sim.step();
        const snap = snapshot();
        sendDown(t, () => {
          const had = !!pred.state;
          pred.onSnapshot(snap);
          if (had && t > 3000) corrections.push(pred.lastCorrection);
        });
      }
      if (t % 50 === 23 && pred.state) {
        k++;
        const input: VehicleInput = { ...NEUTRAL_INPUT, throttle: k % 160 > 140 ? 0 : 1, brake: k % 160 > 140 ? 1 : 0, steer: Math.sin(k / 30) * 0.6 };
        const msg = pred.stepMessage(input);
        sendUp(t, () => {
          const batch = (msg.r ?? []).map(([seq, st, th, br, fl]) => ({ seq, input: { steer: st, throttle: th, brake: br, nitro: (fl & 1) === 1, handbrake: (fl & 2) === 2 } }));
          batch.push({ seq: msg.seq, input });
          sim.pushInputs('me', batch);
        });
      }
    }
    const p95 = percentile(corrections, 0.95);
    const p50 = percentile(corrections, 0.5);
    console.log(`[M3] prediction correction: n=${corrections.length} p50=${p50.toFixed(3)} m p95=${p95.toFixed(3)} m max=${Math.max(...corrections).toFixed(2)} m`);
    expect(corrections.length).toBeGreaterThan(1500);
    expect(p95).toBeLessThan(1);
  });
});

describe('M3: interest tiers', () => {
  it('near at 20 Hz, mid at 5 Hz, far only on the 1 Hz global map; hysteresis; no squad ever missing from the map', async () => {
    const w = await startWorld(4, { trafficCount: 0 });
    try {
      const host = await connectWs(w.base);
      host.send({ t: 'host_hello', hostKey: HOST_KEY });
      await host.next((m) => m.t === 'welcome');
      const [a, b, d, c] = [...w.s.room.sim.cars.values()] as [SimCar, SimCar, SimCar, SimCar];
      const put = (car: SimCar, x: number, z: number) => (car.state = { ...car.state, x, z, vx: 0, vz: 0 });
      const layout = (bz: number) => {
        put(a, -480, -480); // viewer (bot0)
        put(b, -480, -480 + bz); // near / boundary probe
        put(d, -480, 320); // 800 m → mid
        put(c, 480, 480); // 1358 m → far
      };
      const viewer = w.bots[0]!;
      const counts = async (ticks: number, bz: number) => {
        const n = new Map<number, number>();
        const startTick = w.s.room.sim.tick;
        for (let i = 0; i < ticks; i++) {
          layout(bz);
          w.s.room.worldLoop(1);
        }
        const last = w.s.room.sim.tick;
        await until(() => viewer.snaps.has(last));
        for (let t = startTick + 1; t <= last; t++) for (const car of viewer.snaps.get(t)!.cars) n.set(car[0], (n.get(car[0]) ?? 0) + 1);
        return n;
      };
      const n = await counts(40, 200);
      expect(n.get(b.cid)).toBe(40); // near: every tick
      expect(n.get(d.cid)).toBe(10); // mid: 5 Hz
      expect(n.get(c.cid) ?? 0).toBe(0); // far: never in the 3D snapshot…
      // …but always on the global map channel (players 1 Hz, host 5 Hz), with every squad.
      await until(() => viewer.maps.length >= 2);
      for (const m of viewer.maps) expect(m.cars.map((x) => x[0]).sort()).toEqual([1, 2, 3, 4]);
      const hostMaps: ServerMessage[] = host.inbox.filter((m) => m.t === 'map');
      expect(hostMaps.length).toBeGreaterThanOrEqual(8);
      for (const m of hostMaps) if (m.t === 'map') expect(m.cars).toHaveLength(4);

      // Hysteresis: a near car drifting to 320 m (inside +10%) stays near; at 340 m it drops to mid,
      // and at 310 m it does not flap back to near (must come within 300 m).
      expect((await counts(8, 320)).get(b.cid)).toBe(8);
      expect((await counts(8, 340)).get(b.cid)).toBe(2);
      expect((await counts(8, 310)).get(b.cid)).toBe(2);
      expect((await counts(8, 290)).get(b.cid)).toBe(8);
      host.ws.close();
    } finally {
      await w.close();
    }
  }, 60_000);
});

describe('M3: static single-world check', () => {
  it('the server codebase has exactly one WorldRoom.create call site and no other room construction', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(root);
    const creates = files.flatMap((f) => (readFileSync(f, 'utf8').match(/WorldRoom\.create\(/g) ?? []).map(() => path.relative(root, f)));
    expect(creates).toEqual(['app.ts']);
    const constructs = files.filter((f) => !f.endsWith('WorldRoom.ts') && /new\s+WorldRoom\s*\(/.test(readFileSync(f, 'utf8')));
    expect(constructs).toEqual([]);
    // No per-team or per-squad rooms/instances anywhere.
    for (const f of files) expect(readFileSync(f, 'utf8')).not.toMatch(/new\s+WorldSim\s*\([^)]*team/i);
    expect(readFileSync(path.join(root, 'app.ts'), 'utf8').match(/new WorldSim\(/g)).toHaveLength(1);
  });
});
