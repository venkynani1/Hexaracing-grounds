import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { NEUTRAL_INPUT, SPAWN_DE, deHeading, type ServerMessage } from '@redline/shared';
import { INPUT_BUDGET_MAX, WorldSim } from '../src/world/WorldSim';
import { HOST_KEY, connectWs, get, makeServer, post, until } from './helpers';

describe('world sim', () => {
  it('tick p99 < 2 ms with 1 car + 100 traffic agents (benchmark)', () => {
    const sim = new WorldSim({ seed: 'bench', trafficCount: 100 });
    sim.spawn([{ teamId: 't1', name: 'Bench' }]);
    sim.released = true;
    expect(sim.traffic.agents.length).toBe(100);
    let seq = 0;
    for (let i = 0; i < 200; i++) {
      sim.pushInput('t1', ++seq, { ...NEUTRAL_INPUT, throttle: 1, steer: Math.sin(i / 15) * 0.3 });
      sim.step();
    }
    const d: number[] = [];
    for (let i = 0; i < 3000; i++) {
      sim.pushInput('t1', ++seq, { ...NEUTRAL_INPUT, throttle: 1, steer: Math.sin(i / 15) * 0.3 });
      const t0 = performance.now();
      sim.step();
      d.push(performance.now() - t0);
    }
    d.sort((a, b) => a - b);
    const p99 = d[Math.floor(d.length * 0.99)]!;
    console.log(`[bench] tick p50=${d[1500]!.toFixed(3)}ms p99=${p99.toFixed(3)}ms`);
    expect(p99).toBeLessThan(2);
  });

  it('rejects replayed and out-of-order input seq', () => {
    const sim = new WorldSim({ seed: 's', trafficCount: 0 });
    sim.spawn([{ teamId: 't', name: 'T' }]);
    expect(sim.pushInput('t', 1, NEUTRAL_INPUT)).toBe(true);
    expect(sim.pushInput('t', 3, NEUTRAL_INPUT)).toBe(true);
    expect(sim.pushInput('t', 2, NEUTRAL_INPUT)).toBe(false);
    expect(sim.pushInput('t', 3, NEUTRAL_INPUT)).toBe(false);
    expect(sim.pushInput('t', 1.5, NEUTRAL_INPUT)).toBe(false);
    expect(sim.pushInput('nope', 9, NEUTRAL_INPUT)).toBe(false);
  });

  it('cars are held until release; disconnected cars AI-brake', () => {
    const sim = new WorldSim({ seed: 's', trafficCount: 0 });
    sim.spawn([{ teamId: 't', name: 'T' }]);
    const car = sim.cars.get('t')!;
    const x0 = car.state.x;
    for (let i = 1; i <= 20; i++) sim.pushInput('t', i, { ...NEUTRAL_INPUT, throttle: 1 }), sim.step();
    expect(car.state.x).toBe(x0);
    expect(car.ackSeq).toBe(20);
    sim.released = true;
    for (let i = 21; i <= 60; i++) sim.pushInput('t', i, { ...NEUTRAL_INPUT, throttle: 1 }), sim.step();
    const moving = Math.hypot(car.state.vx, car.state.vz);
    expect(moving).toBeGreaterThan(10);
    for (let i = 0; i < 100; i++) sim.step(); // no more inputs → after 1 s, AI brake
    expect(Math.hypot(car.state.vx, car.state.vz)).toBeLessThan(moving / 2);
  });

  it('two cars on the same spot are separated symmetrically', () => {
    const sim = new WorldSim({ seed: 's', trafficCount: 0 });
    sim.spawn([{ teamId: 'a', name: 'A' }, { teamId: 'b', name: 'B' }]);
    const a = sim.cars.get('a')!;
    const b = sim.cars.get('b')!;
    b.state = { ...b.state, x: a.state.x + 1, z: a.state.z, vx: -10 };
    sim.step();
    expect(Math.hypot(b.state.x - a.state.x, b.state.z - a.state.z)).toBeGreaterThanOrEqual(3.99);
    expect(a.state.health).toBe(b.state.health);
    expect(a.state.health).toBeLessThan(100);
  });
});

describe('world room: input → server-authoritative car', () => {
  it('racer inputs move the squad car on the server; snapshots carry ack; non-racers cannot drive', async () => {
    const s = await makeServer({ countdownMs: 1000, releaseAtMs: 0, trafficCount: 20 }, { manualClock: true });
    const base = await s.listen(0);
    try {
      const cap = await post(s, '/api/squads', { squadName: 'Drive', displayName: 'Cap' });
      const racer = await post(s, '/api/squads/join', { code: cap.body.joinCode, displayName: 'R', role: 'RACER' });
      expect((await post(s, '/api/host/start', { force: true }, { 'x-host-key': HOST_KEY })).status).toBe(200);
      expect(s.room.sim.cars.size).toBe(1);
      const car = s.room.sim.cars.get(cap.body.teamId)!;
      expect(car.state.heading).toBeCloseTo(deHeading(s.room.sim.net, SPAWN_DE));

      const r = await connectWs(base);
      r.send({ t: 'hello', sessionToken: racer.body.sessionToken });
      await r.next((m) => m.t === 'welcome');
      const c = await connectWs(base);
      c.send({ t: 'hello', sessionToken: cap.body.sessionToken });
      await c.next((m) => m.t === 'welcome');

      s.advance(1000);
      await s.room.tick();
      expect(s.room.clockState().status).toBe('LIVE');

      const start = { x: car.state.x, z: car.state.z };
      // Burst: the input budget (anti speed-hack) accepts at most INPUT_BUDGET_MAX unconsumed inputs.
      for (let seq = 1; seq <= 30; seq++) r.send({ t: 'input', seq, st: 0, th: 1, br: 0 });
      await until(() => car.lastSeq === INPUT_BUDGET_MAX);
      await new Promise((res) => setTimeout(res, 50));
      expect(car.lastSeq).toBe(INPUT_BUDGET_MAX);
      expect(car.queue.length).toBeLessThanOrEqual(6);
      await new Promise((res) => setTimeout(res, 1100)); // stay under the 60 msg/s connection ceiling
      for (let i = 0; i < 10; i++) s.room.worldLoop(1); // consume the backlog; budget refills one per tick
      expect(car.queue.length).toBe(0);
      expect(car.ackSeq).toBe(INPUT_BUDGET_MAX);
      let seq = 30;
      for (let i = 0; i < 40; i++) {
        r.send({ t: 'input', seq: ++seq, st: 0, th: 1, br: 0 });
        await until(() => car.lastSeq === seq);
        s.room.worldLoop(1);
        if (i === 25) await new Promise((res) => setTimeout(res, 1100));
      }
      for (let i = 0; i < 6; i++) s.room.worldLoop(1); // drain the queue
      const moved = Math.hypot(car.state.x - start.x, car.state.z - start.z);
      expect(moved).toBeGreaterThan(10);
      const snap = (await r.next((m) => m.t === 'snap' && m.ack === 70)) as Extract<ServerMessage, { t: 'snap' }>;
      expect(snap.me!.id).toBe(cap.body.teamId);
      expect(snap.released).toBe(true);
      expect(snap.traffic.length).toBeGreaterThan(0);
      expect(snap.traffic.length).toBeLessThanOrEqual(20);

      // Replay of an old seq is dropped.
      r.send({ t: 'input', seq: 10, st: 1, th: 0, br: 1 });
      // Captain is not the racer: inputs ignored.
      c.send({ t: 'input', seq: 1000, st: 1, th: 0, br: 1 });
      await new Promise((res) => setTimeout(res, 50));
      expect(car.lastSeq).toBe(70);

      // Role clients get the squad car telemetry.
      for (let i = 0; i < 4; i++) s.room.worldLoop(0);
      const tele = (await c.next((m) => m.t === 'car')) as Extract<ServerMessage, { t: 'car' }>;
      expect(tele.car.id).toBe(cap.body.teamId);

      const world = await get(s, '/api/host/world', { 'x-host-key': HOST_KEY });
      expect(world.status).toBe(200);
      expect(world.body.cars).toHaveLength(1);
      expect(world.body.tick).toBe(s.room.sim.tick);
      expect((await get(s, '/api/host/world')).status).toBe(401);
      r.ws.close();
      c.ws.close();
    } finally {
      await s.dispose();
    }
  });
});
