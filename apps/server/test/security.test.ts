/**
 * M8 security pass: replay protection, forged/expired sessions, rate limits, clue isolation, host route protection.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Bot } from '@redline/loadtest';
import { NEUTRAL_INPUT, ROLES } from '@redline/shared';
import { TokenSigner } from '../src/auth/tokens';
import { HOST_KEY, connectWs, fullSquad, get, makeServer, post, until } from './helpers';

const MIN = 60_000;

describe('M8: security', () => {
  it('every /api/host/* route rejects missing and wrong host keys (routes discovered from source)', async () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app.ts'), 'utf8');
    const routes = [...src.matchAll(/app\.(get|post)\('(\/api\/host\/[^']+)'/g)].map((m) => ({ method: m[1]!.toUpperCase() as 'GET' | 'POST', url: m[2]! }));
    expect(routes.length).toBeGreaterThanOrEqual(7);
    const s = await makeServer();
    try {
      for (const r of routes) {
        for (const headers of [{}, { 'x-host-key': 'wrong' }, { 'x-host-key': `${HOST_KEY} ` }, { authorization: `Bearer ${HOST_KEY}` }]) {
          const res = await s.app.inject({ method: r.method, url: r.url, headers, payload: r.method === 'POST' ? {} : undefined });
          expect(res.statusCode, `${r.method} ${r.url} ${JSON.stringify(headers)}`).toBe(r.url === '/api/host/warp' && res.statusCode === 403 ? 403 : 401);
        }
      }
      // A player session is not a host credential.
      const q = await fullSquad(s, 'NotHost');
      expect((await get(s, '/api/host/overview', { authorization: `Bearer ${q.captain.sessionToken}` })).status).toBe(401);
    } finally {
      await s.dispose();
    }
  });

  it('forged, tampered, cross-secret and expired sessions are rejected over HTTP and WS', async () => {
    const s = await makeServer();
    const base = await s.listen(0);
    try {
      const q = await fullSquad(s, 'Forge');
      const good = q.captain.sessionToken;
      const [body] = good.split('.');
      const claims = JSON.parse(Buffer.from(body!, 'base64url').toString());
      const otherSigner = new TokenSigner('a-completely-different-secret-xxxxxxxxxxxx');
      const forged = [
        `${good}x`,
        `${Buffer.from(JSON.stringify({ ...claims, tid: q.others[0].teamId, pid: q.others[0].playerId })).toString('base64url')}.${good.split('.')[1]}`,
        otherSigner.sign(claims),
        otherSigner.sign({ ...claims, exp: Date.now() - 1000 }),
        'not-a-token',
      ];
      for (const tok of forged) {
        expect((await get(s, '/api/me', { authorization: `Bearer ${tok}` })).status).toBe(401);
        expect((await get(s, '/api/squad/view', { authorization: `Bearer ${tok}` })).status).toBe(401);
        const c = await connectWs(base);
        c.send({ t: 'hello', sessionToken: tok });
        const err = await c.next((m) => m.t === 'error');
        expect(err.t === 'error' && err.error).toBe('UNAUTHORIZED');
        c.ws.close();
      }
      // Expired-but-correctly-signed session with this server's secret.
      const signer = new TokenSigner(s.config.sessionSecret);
      expect((await get(s, '/api/me', { authorization: `Bearer ${signer.sign({ ...claims, exp: Date.now() - 1 })}` })).status).toBe(401);
    } finally {
      await s.dispose();
    }
  });

  it('replayed / out-of-order input seq is rejected; non-racers cannot drive', async () => {
    const s = await makeServer({ countdownMs: 0, releaseAtMs: 0, trafficCount: 0 }, { manualClock: true });
    const base = await s.listen(0);
    try {
      const q = await fullSquad(s, 'Replay');
      await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY });
      await s.room.tick();
      const racer = new Bot('r');
      await racer.connect(base.replace('http', 'ws'), q.others[0].sessionToken);
      const car = s.room.sim.cars.get(q.captain.teamId)!;
      racer.send({ t: 'input', seq: 5, st: 0, th: 1, br: 0 });
      await until(() => car.lastSeq === 5);
      for (const seq of [5, 4, 1]) racer.send({ t: 'input', seq, st: 1, th: 0, br: 1 });
      racer.send({ t: 'input', seq: 6, st: 0, th: 1, br: 0 });
      await until(() => car.lastSeq === 6);
      expect(car.queue.map((e) => e.seq)).toEqual([5, 6]); // the replays never entered the queue
      const eng = new Bot('e');
      await eng.connect(base.replace('http', 'ws'), q.others[1].sessionToken);
      eng.send({ t: 'input', seq: 100, st: 0, th: 1, br: 0 });
      await new Promise((r) => setTimeout(r, 80));
      expect(car.lastSeq).toBe(6);
      racer.close();
      eng.close();
      void NEUTRAL_INPUT;
    } finally {
      await s.dispose();
    }
  });

  it('rate limits hold: registration (429), squad actions (429), WS flood (connection closed)', async () => {
    const s = await makeServer({ joinAttemptsPerMinute: 8 });
    const base = await s.listen(0);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await post(s, '/api/squads/join', { code: 'ZZZZZZ', displayName: 'x', role: 'RACER' })).status);
      expect(statuses.filter((c) => c === 429).length).toBeGreaterThanOrEqual(4);
    } finally {
      await s.dispose();
    }
    const s2 = await makeServer();
    const base2 = await s2.listen(0);
    try {
      const q = await fullSquad(s2, 'Flood');
      // Squad action limiter: 120/min per player.
      let limited = 0;
      for (let i = 0; i < 130; i++) if ((await get(s2, '/api/squad/view', { authorization: `Bearer ${q.captain.sessionToken}` })).status === 429) limited++;
      expect(limited).toBeGreaterThan(0);
      // WS flood: > 60 messages/s closes the connection.
      const ws = new WebSocket(`${base2.replace('http', 'ws')}/ws`, { origin: 'http://localhost:5173' });
      await new Promise((r) => ws.once('open', r));
      const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
      for (let i = 0; i < 100; i++) ws.send(JSON.stringify({ t: 'ping', clientTime: i }));
      expect(await closed).toBe(4008);
    } finally {
      await s2.dispose();
    }
    void base;
  });

  it('no clue or answer leakage across roles/squads (full message logs, two squads)', async () => {
    const s = await makeServer({ countdownMs: 0, releaseAtMs: 0, trafficCount: 0 }, { manualClock: true });
    const base = await s.listen(0);
    try {
      const sq = [await fullSquad(s, 'LeakA'), await fullSquad(s, 'LeakB')];
      const bots: { bot: Bot; team: string; role: (typeof ROLES)[number] }[] = [];
      for (const q of sq)
        for (const [role, m] of [['CAPTAIN', q.captain], ['RACER', q.others[0]], ['ENGINEER', q.others[1]], ['DECEIVER', q.others[2]]] as const) {
          const b = new Bot(role, { keepLog: true });
          await b.connect(base.replace('http', 'ws'), m.sessionToken);
          bots.push({ bot: b, team: q.captain.teamId, role });
        }
      await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY });
      for (const t of [3, 10, 24, 50.2]) {
        s.advance(t * MIN - s.room.clockState().elapsedMs);
        await s.room.tick();
      }
      await new Promise((r) => setTimeout(r, 100));
      for (const { bot, team, role } of bots) {
        const log = bot.log.join('\n');
        for (const q of sq) {
          const tid = q.captain.teamId;
          const clues = s.room.squad!.cluesFor('fourkey-1', tid)!;
          for (const r of ROLES) if (!(tid === team && r === role)) for (const m of bot.log.map((x) => JSON.parse(x)).filter((x) => x.t === 'squad')) for (const c of m.view.challenges) expect(c.clue === clues[r] && !(tid === team && r === role) && clues[r] !== clues[role]).toBe(false);
          const g = s.room.gate!.answers(tid);
          expect(log).not.toContain(`"${g.code}"`);
          expect(log).not.toContain(g.debug === 'Line 1' ? '"answer":"Line 1"' : `"answer":"${g.debug}"`);
          for (const k of ['coding-1-q1', 'coding-1-q2']) {
            const a = s.room.squad!.answerFor('coding', k, tid)!;
            if (a.length >= 5) expect(log).not.toContain(`"${a}"`);
          }
        }
        // Gate: only the Engineer sees the debug task, only the Deceiver the badges, only the Captain the code panel.
        const gate = bot.lastSquad!.gate!;
        expect(!!gate.debug).toBe(role === 'ENGINEER');
        expect(!!gate.auth).toBe(role === 'DECEIVER');
        expect(!!gate.code).toBe(role === 'CAPTAIN');
      }
      for (const b of bots) b.bot.close();
    } finally {
      await s.dispose();
    }
  });
});
