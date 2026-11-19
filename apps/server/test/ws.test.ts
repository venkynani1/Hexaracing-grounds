import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@redline/shared';
import { HOST_KEY, makeServer, post, type TestServer } from './helpers';

let s: TestServer;
let base: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  s = await makeServer({ publicWebOrigins: ['http://localhost:5173'] });
  base = await s.listen(0);
});
afterEach(async () => {
  for (const w of sockets.splice(0)) w.terminate();
  await s.dispose();
});

function connect(): Promise<{ ws: WebSocket; next: (pred: (m: ServerMessage) => boolean) => Promise<ServerMessage> }> {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { origin: 'http://localhost:5173' });
  sockets.push(ws);
  const inbox: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as ServerMessage;
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(m);
    else inbox.push(m);
  });
  const next = (pred: (m: ServerMessage) => boolean) =>
    new Promise<ServerMessage>((resolve, reject) => {
      const i = inbox.findIndex(pred);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]!);
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), 5000);
      waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, next }));
    ws.once('error', reject);
  });
}

describe('ws: lobby', () => {
  it('a lobby client receives roster updates when a teammate joins; all share one room id', async () => {
    const cap = await post(s, '/api/squads', { squadName: 'Live', displayName: 'Cap' });
    const a = await connect();
    a.ws.send(JSON.stringify({ t: 'hello', sessionToken: cap.body.sessionToken }));
    const welcome = (await a.next((m) => m.t === 'welcome')) as Extract<ServerMessage, { t: 'welcome'; kind: 'player' }>;
    expect(welcome.kind).toBe('player');
    expect(welcome.roster.players).toHaveLength(1);
    expect(welcome.roomId).toBe(s.room.roomId);

    const racer = await post(s, '/api/squads/join', { code: cap.body.joinCode, displayName: 'Ravi', role: 'RACER' });
    const update = (await a.next((m) => m.t === 'roster' && m.roster.players.length === 2)) as Extract<ServerMessage, { t: 'roster' }>;
    expect(update.roster.players.map((p) => p.displayName).sort()).toEqual(['Cap', 'Ravi']);
    expect(update.roster.players.find((p) => p.displayName === 'Cap')!.connected).toBe(true);
    expect(update.roster.players.find((p) => p.displayName === 'Ravi')!.connected).toBe(false);

    const b = await connect();
    b.ws.send(JSON.stringify({ t: 'hello', sessionToken: racer.body.sessionToken }));
    const wb = (await b.next((m) => m.t === 'welcome')) as Extract<ServerMessage, { t: 'welcome'; kind: 'player' }>;
    expect(wb.roomId).toBe(welcome.roomId);
    const online = (await a.next(
      (m) => m.t === 'roster' && m.roster.players.length === 2 && m.roster.players.every((p) => p.connected),
    )) as Extract<ServerMessage, { t: 'roster' }>;
    expect(online.roster.players).toHaveLength(2);

    b.ws.close();
    await a.next((m) => m.t === 'roster' && m.roster.players.some((p) => p.displayName === 'Ravi' && !p.connected));
  });

  it('host receives overview; bad host key and bad session are rejected; foreign origins refused', async () => {
    const h = await connect();
    h.ws.send(JSON.stringify({ t: 'host_hello', hostKey: HOST_KEY }));
    const w = await h.next((m) => m.t === 'welcome');
    expect(w.t === 'welcome' && w.kind === 'host').toBe(true);
    await post(s, '/api/squads', { squadName: 'Seen', displayName: 'Cap' });
    const ov = await h.next((m) => m.t === 'overview' && m.overview.squadCount === 1);
    expect(ov.t).toBe('overview');

    const bad = await connect();
    bad.ws.send(JSON.stringify({ t: 'host_hello', hostKey: 'nope' }));
    const err = await bad.next((m) => m.t === 'error');
    expect(err.t === 'error' && err.error).toBe('UNAUTHORIZED');

    const bad2 = await connect();
    bad2.ws.send(JSON.stringify({ t: 'hello', sessionToken: 'forged.token' }));
    const err2 = await bad2.next((m) => m.t === 'error');
    expect(err2.t === 'error' && err2.error).toBe('UNAUTHORIZED');

    const foreign = new WebSocket(base.replace('http', 'ws') + '/ws', { origin: 'https://evil.example' });
    sockets.push(foreign);
    await expect(new Promise((res, rej) => (foreign.once('open', res), foreign.once('error', rej)))).rejects.toThrow();
  });
});
