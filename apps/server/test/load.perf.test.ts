/**
 * M8 load test (fast-forward): 120 real WebSocket clients (30 racers + 90 role clients) + host + projector, the whole
 * 60-minute timeline on the Chennai map with 400 traffic agents, concurrent submissions at every challenge.
 * Budgets: server tick p99 < 10 ms, per-client downstream < 40 KB/s average, zero disconnects.
 */
import { describe, expect, it } from 'vitest';
import { Bot, percentile, registerFullSquad, type FullSquad } from '@redline/loadtest';
import { BALANCE, wrapAngle, type Role, type ServerMessage } from '@redline/shared';
import { HOST_KEY, connectWs, makeServer, post, until } from './helpers';

const MIN = 60_000;
const ROLES: Role[] = ['CAPTAIN', 'RACER', 'ENGINEER', 'DECEIVER'];

describe('M8: 120-client load (fast-forward 60 min)', () => {
  it('120 clients + host + projector through the whole event within budgets', async () => {
    const s = await makeServer({ map: 'chennai', trafficCount: 400, countdownMs: 0, releaseAtMs: 3 * MIN }, { manualClock: true });
    const base = await s.listen(0);
    const wsUrl = base.replace('http', 'ws');
    const squads: FullSquad[] = [];
    const bots = new Map<string, Bot>(); // `${squad}:${role}`
    try {
      for (let i = 0; i < 30; i++) squads.push(await registerFullSquad(base, `Load${String(i).padStart(2, '0')}`));
      await Promise.all(
        squads.flatMap((sq) =>
          ROLES.map(async (role) => {
            const b = new Bot(`${sq.name}-${role}`);
            await b.connect(wsUrl, sq.members[role].sessionToken);
            bots.set(`${sq.name}:${role}`, b);
          }),
        ),
      );
      const host = await connectWs(base);
      host.send({ t: 'host_hello', hostKey: HOST_KEY });
      await host.next((m) => m.t === 'welcome');
      const projector = await connectWs(base);
      projector.send({ t: 'host_hello', hostKey: HOST_KEY });
      await projector.next((m) => m.t === 'welcome');
      expect(s.room.clients.size).toBe(122);
      expect((await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY })).status).toBe(200);

      const sim = s.room.sim;
      const map = sim.map;
      const racers = squads.map((sq) => ({ sq, bot: bots.get(`${sq.name}:RACER`)!, teamId: sq.members.CAPTAIN.teamId }));
      const bot = (sq: FullSquad, r: Role) => bots.get(`${sq.name}:${r}`)!;
      const api = (path: string, sq: FullSquad, r: Role, body: unknown) =>
        fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sq.members[r].sessionToken}` }, body: JSON.stringify(body) }).then((x) => x.json() as Promise<any>);
      // Autopilot: steer toward the next checkpoint on the squad's own course.
      const steerFor = (b: Bot) => {
        const me = b.lastSnap?.me;
        const st = b.predictor?.state;
        if (!me || !st) return 0;
        const cp = map.courses[me.cs]?.checkpoints[me.cp];
        if (!cp) return 0;
        return Math.max(-1, Math.min(1, wrapAngle(Math.atan2(cp.x - st.x, cp.z - st.z) - st.heading) * 2));
      };

      let steps = 0;
      const tickP99s: number[] = [];
      const done = new Set<string>();
      const once = async (key: string, at: number, elapsed: number, fn: () => Promise<unknown>) => {
        if (elapsed >= at && !done.has(key)) {
          done.add(key);
          await fn();
        }
      };
      for (let elapsed = 0; elapsed <= 60 * MIN; elapsed += 5000) {
        s.advance(elapsed - s.room.clockState().elapsedMs);
        await s.room.tick();
        // Concurrent submissions from all 30 squads at each challenge.
        await once('coding', 3 * MIN, elapsed, () =>
          Promise.all(squads.map((sq) => api('/api/squad/coding/coding-1-q1', sq, 'ENGINEER', { answer: s.room.squad!.answerFor('coding', 'coding-1-q1', sq.members.CAPTAIN.teamId), idempotencyKey: `load-${sq.name}-c1` }))),
        );
        await once('fourkey', 10 * MIN, elapsed, () =>
          Promise.all(squads.map((sq) => api('/api/squad/fourkey/fourkey-1', sq, 'CAPTAIN', { answer: s.room.squad!.answerFor('four_key', 'fourkey-1', sq.members.CAPTAIN.teamId), idempotencyKey: `load-${sq.name}-fk` }))),
        );
        await once('bluff-w', 10.5 * MIN, elapsed, () => Promise.all(squads.map((sq, i) => api('/api/squad/bluff/bluff-1/entry', sq, 'DECEIVER', { text: `Load bluff number ${i}` }))));
        await once('bluff-v', 13 * MIN, elapsed, async () => {
          await new Promise((r) => setTimeout(r, 100));
          await Promise.all(
            squads.map((sq) => {
              const opts = bot(sq, 'DECEIVER').lastSquad?.challenges.find((c) => c.id === 'bluff-1')?.bluffOptions ?? [];
              return opts[0] ? api('/api/squad/bluff/bluff-1/vote', sq, 'DECEIVER', { choiceId: opts[0].choiceId }) : null;
            }),
          );
        });
        await once('gate', 50.2 * MIN, elapsed, () =>
          Promise.all(
            squads.flatMap((sq) => {
              const a = s.room.gate!.answers(sq.members.CAPTAIN.teamId);
              return [api('/api/squad/gate/debug', sq, 'ENGINEER', { answer: a.debug }), api('/api/squad/gate/auth', sq, 'DECEIVER', { index: a.forged }), api('/api/squad/gate/code', sq, 'CAPTAIN', { code: a.code })];
            }),
          ),
        );
        // A few real simulation steps per 5 s of event time, racers driving through the real protocol.
        if (s.room.clockState().status === 'LIVE') {
          for (let k = 0; k < 4; k++) {
            // Real phones send 20 inputs/s; the server closes connections above 60 msg/s — pace at ≤ 50/s.
            const t0 = Date.now();
            const seqs = racers.map((r) => r.bot.drive({ throttle: 0.9, steer: steerFor(r.bot) }));
            try {
              await until(() => racers.every((r, i) => !seqs[i] || sim.cars.get(r.teamId)!.lastSeq >= seqs[i]!), 3000);
            } catch (e) {
              const lag = racers.map((r, i) => ({ n: r.sq.name, sent: seqs[i], last: sim.cars.get(r.teamId)!.lastSeq, budget: sim.cars.get(r.teamId)!.inputBudget, closed: r.bot.closed })).filter((x) => x.sent && x.last < x.sent!);
              console.log('[debug lag]', elapsed, JSON.stringify(lag.slice(0, 5)));
              throw e;
            }
            s.advance(50);
            s.room.worldLoop(1);
            steps++;
            const spent = Date.now() - t0;
            if (spent < 21) await new Promise((r) => setTimeout(r, 21 - spent));
          }
          tickP99s.push(s.room.tickStats().tickP99Ms);
        }
      }
      await until(() => host.inbox.some((m) => m.t === 'championship'), 10_000);

      // ---------- Assertions ----------
      const all = [...bots.values()];
      const disconnected = all.filter((b) => b.closed).length;
      const simSeconds = steps * 0.05;
      const kbps = all.map((b) => b.stats.bytes / simSeconds / 1024);
      const racerKbps = racers.map((r) => r.bot.stats.bytes / simSeconds / 1024);
      // True p99 over every simulation step of the run (bots share this process, so GC from 122 clients is included).
      const tickP99 = percentile(s.room.allTickDurations, 0.99);
      const worstWindow = Math.max(...tickP99s);
      const champ = host.inbox.find((m) => m.t === 'championship') as Extract<ServerMessage, { t: 'championship' }>;
      const lettersRes = await fetch(`${base}/api/host/offer-letters`, { headers: { 'x-host-key': HOST_KEY } }).then((r) => r.json() as Promise<unknown[]>);
      console.log(
        `[M8 load] clients=122 steps=${steps} tick p50=${percentile(s.room.allTickDurations, 0.5).toFixed(2)} p99=${tickP99.toFixed(2)}ms worst-window-p99=${worstWindow.toFixed(2)}ms ` +
          `downstream avg=${(kbps.reduce((a, b) => a + b, 0) / kbps.length).toFixed(1)}KB/s racer avg=${(racerKbps.reduce((a, b) => a + b, 0) / 30).toFixed(1)} racer p95=${percentile(racerKbps, 0.95).toFixed(1)} ` +
          `disconnected=${disconnected} cpPassed=${[...sim.cars.values()].reduce((a, c) => a + c.nextCp, 0)} letters=${lettersRes.length}`,
      );
      expect(disconnected).toBe(0);
      expect(tickP99).toBeLessThan(10);
      expect(kbps.reduce((a, b) => a + b, 0) / kbps.length).toBeLessThan(40);
      expect(champ.standings).toHaveLength(30);
      expect(lettersRes).toHaveLength(120);
      // Every challenge submission was processed (scores exist for every squad).
      for (const sq of squads) expect(s.room.squad!.scoreOf(sq.members.CAPTAIN.teamId).total).toBeGreaterThanOrEqual(100);
      // One world throughout.
      expect(new Set(all.map((b) => b.roomId)).size).toBe(1);
      expect(s.room.gate!.timeline!.slots).toHaveLength(30);
      void BALANCE;
      host.ws.close();
      projector.ws.close();
    } finally {
      for (const b of bots.values()) b.close();
      await s.dispose();
    }
  }, 600_000);
});
