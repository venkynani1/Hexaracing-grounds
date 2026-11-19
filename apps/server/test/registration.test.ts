import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOIN_CODE_ALPHABET } from '@redline/shared';
import { HOST_KEY, fullSquad, get, makeServer, post, type TestServer } from './helpers';

let s: TestServer;
beforeEach(async () => {
  s = await makeServer();
});
afterEach(async () => {
  await s.dispose();
});

describe('api: squads', () => {
  it('creating a squad returns a 6-char safe-alphabet code; creator is Captain in slot 4', async () => {
    const r = await post(s, '/api/squads', { squadName: 'Velocity', displayName: 'Asha' });
    expect(r.status).toBe(201);
    expect(r.body.joinCode).toHaveLength(6);
    for (const ch of r.body.joinCode) expect(JOIN_CODE_ALPHABET).toContain(ch);
    expect(r.body.role).toBe('CAPTAIN');
    expect(r.body.slot).toBe(4);
    expect(r.body.sessionToken).toBeTruthy();
    expect(r.body.rejoinToken).toBeTruthy();
  });

  it('3 more players join; a 5th is rejected; duplicate role rejected; unknown code rejected', async () => {
    const cap = await post(s, '/api/squads', { squadName: 'Apex', displayName: 'Cap' });
    const code: string = cap.body.joinCode;
    const r1 = await post(s, '/api/squads/join', { code, displayName: 'Ravi', role: 'RACER' });
    expect(r1.status).toBe(201);
    expect(r1.body.slot).toBe(1);
    const dup = await post(s, '/api/squads/join', { code, displayName: 'Dup', role: 'RACER' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('ROLE_TAKEN');
    const dupCap = await post(s, '/api/squads/join', { code: code.toLowerCase(), displayName: 'Dup', role: 'CAPTAIN' });
    expect(dupCap.body.error).toBe('ROLE_TAKEN');
    expect((await post(s, '/api/squads/join', { code, displayName: 'Eve', role: 'ENGINEER' })).status).toBe(201);
    const preview = await get(s, `/api/squads/${code}`);
    expect(preview.body.freeRoles).toEqual(['DECEIVER']);
    expect((await post(s, '/api/squads/join', { code, displayName: 'Dev', role: 'DECEIVER' })).status).toBe(201);
    const fifth = await post(s, '/api/squads/join', { code, displayName: 'Fifth', role: 'RACER' });
    expect(fifth.status).toBe(409);
    expect(fifth.body.error).toBe('SQUAD_FULL');
    const unknown = await post(s, '/api/squads/join', { code: 'ZZZZZZ', displayName: 'X', role: 'RACER' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('UNKNOWN_CODE');
    const malformed = await post(s, '/api/squads/join', { code: 'O0O0O0', displayName: 'X', role: 'RACER' });
    expect(malformed.status).toBe(404);
  });

  it('validates names and rejects duplicate squad names (case-insensitive)', async () => {
    expect((await post(s, '/api/squads', { squadName: '', displayName: 'A' })).status).toBe(400);
    expect((await post(s, '/api/squads', { squadName: 'x'.repeat(40), displayName: 'A' })).status).toBe(400);
    expect((await post(s, '/api/squads', { squadName: 'Nitro', displayName: 'A' })).status).toBe(201);
    const dup = await post(s, '/api/squads', { squadName: 'NITRO', displayName: 'B' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('SQUAD_NAME_TAKEN');
  });

  it('30 squads × 4 players = 120 registrations succeed; the 31st squad is rejected', async () => {
    let players = 0;
    for (let i = 0; i < 30; i++) {
      await fullSquad(s, `Squad${i}`);
      players += 4;
    }
    expect(players).toBe(120);
    const ov = await get(s, '/api/host/overview', { 'x-host-key': HOST_KEY });
    expect(ov.body.squadCount).toBe(30);
    expect(ov.body.playerCount).toBe(120);
    expect(ov.body.canStart).toBe(true);
    const over = await post(s, '/api/squads', { squadName: 'Squad30', displayName: 'Late' });
    expect(over.status).toBe(409);
    expect(over.body.error).toBe('EVENT_FULL');
  }, 120_000);

  it('concurrent squad creation never exceeds capacity', async () => {
    for (let i = 0; i < 28; i++) await post(s, '/api/squads', { squadName: `Pre${i}`, displayName: 'c' });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => post(s, '/api/squads', { squadName: `Race${i}`, displayName: 'c' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.body.error === 'EVENT_FULL')).toHaveLength(4);
  }, 60_000);
});

describe('api: role changes', () => {
  it('allows Captain-authorised swaps before START; rejects non-captains, duplicates, and after START', async () => {
    const { captain, others } = await fullSquad(s, 'Swap');
    const [racer, engineer] = others;
    const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });

    const notCap = await post(s, '/api/team/roles', { assignments: [{ playerId: racer.playerId, role: 'ENGINEER' }] }, auth(racer.sessionToken));
    expect(notCap.status).toBe(403);
    expect(notCap.body.error).toBe('NOT_CAPTAIN');

    const dup = await post(s, '/api/team/roles', { assignments: [{ playerId: racer.playerId, role: 'ENGINEER' }] }, auth(captain.sessionToken));
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('DUPLICATE_ROLE');

    // Swap Racer <-> Engineer atomically.
    const swap = await post(
      s,
      '/api/team/roles',
      { assignments: [{ playerId: racer.playerId, role: 'ENGINEER' }, { playerId: engineer.playerId, role: 'RACER' }] },
      auth(captain.sessionToken),
    );
    expect(swap.status).toBe(200);
    const byId = Object.fromEntries(swap.body.roster.players.map((p: any) => [p.playerId, p]));
    expect(byId[racer.playerId].role).toBe('ENGINEER');
    expect(byId[engineer.playerId].role).toBe('RACER');
    // Slots are stable identities: unchanged by role swaps.
    expect(byId[racer.playerId].slot).toBe(1);
    expect(byId[engineer.playerId].slot).toBe(2);

    // Captain hands over captaincy.
    const handover = await post(
      s,
      '/api/team/roles',
      { assignments: [{ playerId: captain.playerId, role: 'RACER' }, { playerId: engineer.playerId, role: 'CAPTAIN' }] },
      auth(captain.sessionToken),
    );
    expect(handover.status).toBe(200);
    const noCaptain = await post(s, '/api/team/roles', { assignments: [{ playerId: engineer.playerId, role: 'DECEIVER' }] }, auth(engineer.sessionToken));
    expect(noCaptain.status).toBe(409);

    expect((await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY })).status).toBe(200);
    const after = await post(
      s,
      '/api/team/roles',
      { assignments: [{ playerId: captain.playerId, role: 'DECEIVER' }, { playerId: others[2].playerId, role: 'RACER' }] },
      auth(engineer.sessionToken),
    );
    expect(after.status).toBe(409);
    expect(after.body.error).toBe('EVENT_STARTED');
    // Registration is closed after START too.
    expect((await post(s, '/api/squads', { squadName: 'Late', displayName: 'L' })).body.error).toBe('REGISTRATION_CLOSED');
  });
});

describe('auth', () => {
  it('rejoin token restores the same slot with a new session; tampered token rejected', async () => {
    const cap = await post(s, '/api/squads', { squadName: 'Rejoin', displayName: 'Cap' });
    const racer = await post(s, '/api/squads/join', { code: cap.body.joinCode, displayName: 'R', role: 'RACER' });
    const back = await post(s, '/api/session/rejoin', { rejoinToken: racer.body.rejoinToken });
    expect(back.status).toBe(200);
    expect(back.body.playerId).toBe(racer.body.playerId);
    expect(back.body.slot).toBe(1);
    expect(back.body.role).toBe('RACER');
    expect(back.body.sessionToken).not.toBe(racer.body.sessionToken);
    const me = await get(s, '/api/me', { authorization: `Bearer ${back.body.sessionToken}` });
    expect(me.status).toBe(200);
    expect(me.body.playerId).toBe(racer.body.playerId);

    const tok: string = racer.body.rejoinToken;
    const [body, sig] = tok.split('.');
    const claims = JSON.parse(Buffer.from(body!, 'base64url').toString());
    const forgedBody = Buffer.from(JSON.stringify({ ...claims, pid: cap.body.playerId })).toString('base64url');
    expect((await post(s, '/api/session/rejoin', { rejoinToken: `${forgedBody}.${sig}` })).status).toBe(401);
    const flipped = tok.slice(0, -2) + (tok.endsWith('AA') ? 'BB' : 'AA');
    expect((await post(s, '/api/session/rejoin', { rejoinToken: flipped })).status).toBe(401);
    expect((await post(s, '/api/session/rejoin', { rejoinToken: 'garbage' })).status).toBe(401);
    // Session token used as a rejoin token is rejected (kind check).
    expect((await post(s, '/api/session/rejoin', { rejoinToken: racer.body.sessionToken })).status).toBe(401);
    // Tampered session token rejected on authenticated routes.
    expect((await get(s, '/api/me', { authorization: `Bearer ${racer.body.sessionToken}x` })).status).toBe(401);
    expect((await get(s, '/api/me')).status).toBe(401);
  });

  it('host endpoints reject missing or invalid host key', async () => {
    for (const [method, url] of [
      ['GET', '/api/host/overview'],
      ['POST', '/api/host/start'],
      ['POST', '/api/host/pause'],
      ['POST', '/api/host/resume'],
    ] as const) {
      const none = await s.app.inject({ method, url });
      expect(none.statusCode, url).toBe(401);
      const bad = await s.app.inject({ method, url, headers: { 'x-host-key': 'wrong' } });
      expect(bad.statusCode, url).toBe(401);
    }
    expect((await get(s, '/api/host/overview', { 'x-host-key': HOST_KEY })).status).toBe(200);
  });
});

describe('rate-limit', () => {
  it('returns 429 after N join attempts per minute per IP', async () => {
    const limited = await makeServer({ joinAttemptsPerMinute: 5 });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        statuses.push((await post(limited, '/api/squads/join', { code: 'ZZZZZZ', displayName: 'x', role: 'RACER' })).status);
      }
      expect(statuses.slice(0, 5).every((c) => c === 404)).toBe(true);
      expect(statuses.slice(5).every((c) => c === 429)).toBe(true);
      const res = await limited.app.inject({ method: 'POST', url: '/api/squads', payload: { squadName: 'a', displayName: 'b' } });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
    } finally {
      await limited.dispose();
    }
  });
});
