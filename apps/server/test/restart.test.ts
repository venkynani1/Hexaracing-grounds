/**
 * M8: server restart mid-event recovers from the newest snapshot; diff vs pre-crash within one snapshot interval.
 */
import { describe, expect, it } from 'vitest';
import { connectPglite } from '@redline/db';
import { Bot } from '@redline/loadtest';
import { NEUTRAL_INPUT } from '@redline/shared';
import { buildServer, type BuiltServer } from '../src/app';
import { loadConfig, type ServerConfig } from '../src/config';
import { WorldRoom } from '../src/world/WorldRoom';
import { HOST_KEY, fullSquad, post } from './helpers';

const MIN = 60_000;

describe('M8: restart recovery', () => {
  it('crash → reboot restores the world PAUSED at the snapshot; scores, attempts, bluffs, buffs, waypoints, cars intact; racers rejoin and drive', async () => {
    const db = await connectPglite();
    let t = 1_800_000_000_000;
    const now = () => t;
    const config: ServerConfig = {
      ...loadConfig({ NODE_ENV: 'test', HOST_ADMIN_KEY: HOST_KEY, SESSION_SECRET: 'restart-secret-'.padEnd(40, 'x') }),
      eventName: `restart-${process.pid}`,
      host: '127.0.0.1',
      map: 'test',
      trafficCount: 20,
      countdownMs: 0,
      releaseAtMs: 0,
      joinAttemptsPerMinute: 10_000,
    };
    const boot = () => buildServer({ config, db, now, runDirector: false });
    const goTo = async (s: BuiltServer, ms: number) => {
      t += ms - s.room.clockState().elapsedMs;
      await s.room.tick();
    };
    const drive = (s: BuiltServer, n: number) => {
      for (let i = 0; i < n; i++) {
        t += 50;
        for (const c of s.room.sim.cars.values()) s.room.sim.pushInput(c.teamId, c.lastSeq + 1, { ...NEUTRAL_INPUT, throttle: 1, steer: 0.05 });
        s.room.worldLoop(1);
      }
    };

    // ---------- Server A: a real event in progress ----------
    const A = await boot();
    const sqA = await fullSquad(A as never, 'Alpha');
    const sqB = await fullSquad(A as never, 'Bravo');
    const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
    expect((await post(A as never, '/api/host/start', {}, { 'x-host-key': HOST_KEY })).status).toBe(200);
    await goTo(A, 3 * MIN);
    const ans = A.room.squad!.answerFor('coding', 'coding-1-q1', sqA.captain.teamId)!;
    expect((await post(A as never, '/api/squad/coding/coding-1-q1', { answer: ans, idempotencyKey: 'restart-key-1' }, auth(sqA.others[1].sessionToken))).body.correct).toBe(true);
    drive(A, 200);
    await goTo(A, 10.75 * MIN);
    expect((await post(A as never, '/api/squad/bluff/bluff-1/entry', { text: 'A paper plane' }, auth(sqA.others[2].sessionToken))).status).toBe(200);
    expect((await post(A as never, '/api/squad/waypoint', { waypoint: 'east_flyover' }, auth(sqB.captain.sessionToken))).status).toBe(200);
    drive(A, 40);
    const snap = (await A.room.snapshotNow('test'))!;
    const scoreA = A.room.squad!.scoreOf(sqA.captain.teamId);
    // Keep running < one snapshot interval, then crash hard (no final snapshot, no graceful shutdown).
    drive(A, 100);
    const preCrash = new Map([...A.room.sim.cars.values()].map((c) => [c.teamId, { x: c.state.x, z: c.state.z, tick: A.room.sim.tick }]));
    const preCrashElapsed = A.room.clockState().elapsedMs;
    await A.close();
    expect(WorldRoom.liveRoomsFor(A.eventId)).toBe(0);

    // ---------- Server B: reboot on the same database ----------
    t += 30_000; // downtime is NOT counted as event time
    const B = await boot();
    try {
      expect(B.eventId).toBe(A.eventId);
      const clock = B.room.clockState();
      expect(clock.status).toBe('PAUSED');
      expect(clock.elapsedMs).toBe(snap.elapsedMs);
      expect(preCrashElapsed - clock.elapsedMs).toBeLessThanOrEqual(WorldRoom.SNAPSHOT_INTERVAL_MS);
      // Cars restored exactly to the snapshot; diff vs pre-crash bounded by one snapshot interval of driving.
      expect(B.room.sim.tick).toBe(snap.sim.tick);
      for (const c of snap.sim.cars) {
        const r = B.room.sim.cars.get(c.teamId)!;
        expect(r.state.x).toBe(c.state.x);
        expect(r.state.z).toBe(c.state.z);
        expect(r.cid).toBe(c.cid);
        const p = preCrash.get(c.teamId)!;
        expect(p.tick - B.room.sim.tick).toBeLessThanOrEqual(WorldRoom.SNAPSHOT_INTERVAL_MS / 50);
        expect(Math.hypot(p.x - r.state.x, p.z - r.state.z)).toBeLessThanOrEqual(44 * (WorldRoom.SNAPSHOT_INTERVAL_MS / 1000));
      }
      // Scores (from scoring_events), attempts, bluff entries, waypoints, buffs survived.
      expect(B.room.squad!.scoreOf(sqA.captain.teamId)).toEqual(scoreA);
      expect((await post(B as never, '/api/host/resume', {}, { 'x-host-key': HOST_KEY })).body.clock.status).toBe('LIVE');
      expect((await post(B as never, '/api/squad/coding/coding-1-q1', { answer: ans, idempotencyKey: 'restart-key-1' }, auth(sqA.others[1].sessionToken))).body).toMatchObject({ correct: true }); // idempotent replay returns the original result
      expect((await post(B as never, '/api/squad/bluff/bluff-1/entry', { text: 'Another' }, auth(sqA.others[2].sessionToken))).body.error).toBe('ALREADY_ENTERED');
      const viewB = B.room.squad!.viewFor(sqB.captain.teamId, 'RACER', sqB.others[0].playerId);
      expect(viewB.waypoint).toBe('east_flyover');
      expect(B.room.sim.activeBuffs(sqA.captain.teamId).map((b) => b.kind)).toContain('engine_tune');
      // Racer rejoins (fresh predictor, seq restarts at 1) and drives the restored car.
      const base = await B.listen(0);
      const rj = await post(B as never, '/api/session/rejoin', { rejoinToken: sqA.others[0].rejoinToken });
      expect(rj.body.playerId).toBe(sqA.others[0].playerId);
      const bot = new Bot('racer', {});
      await bot.connect(base.replace('http', 'ws'), rj.body.sessionToken);
      const car = B.room.sim.cars.get(sqA.captain.teamId)!;
      B.room.sim.resetCar(sqA.captain.teamId, 'auto'); // clear lane (the car had nudged a wall before the crash)
      const x0 = car.state.x;
      const z0 = car.state.z;
      for (let i = 1; i <= 60; i++) {
        bot.send({ t: 'input', seq: i, st: 0, th: 1, br: 0 });
        await new Promise((r) => setTimeout(r, 20));
        t += 50;
        B.room.worldLoop(1);
      }
      expect(car.lastSeq).toBeGreaterThan(30);
      expect(Math.hypot(car.state.x - x0, car.state.z - z0)).toBeGreaterThan(5);
      bot.close();
    } finally {
      await B.close();
      await db.close();
    }
  }, 120_000);
});
