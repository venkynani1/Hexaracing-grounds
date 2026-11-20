import { connectPglite, type DbHandle } from '@redline/db';
import { buildServer, type BuiltServer } from '../src/app';
import { loadConfig, type ServerConfig } from '../src/config';

export const HOST_KEY = 'test-host-key-123';

export interface TestServer extends BuiltServer {
  db: DbHandle;
  config: ServerConfig;
  setNow(ms: number): void;
  advance(ms: number): void;
  dispose(): Promise<void>;
}

let counter = 0;

export async function makeServer(over: Partial<ServerConfig> = {}, opts: { manualClock?: boolean } = {}): Promise<TestServer> {
  // Tests use a short countdown by default only when asked; keep production values otherwise.
  const db = await connectPglite();
  const config: ServerConfig = {
    ...loadConfig({ NODE_ENV: 'test', HOST_ADMIN_KEY: HOST_KEY, SESSION_SECRET: 'test-secret-'.padEnd(40, 'x') }),
    eventName: `test-event-${process.pid}-${++counter}`,
    joinAttemptsPerMinute: 10_000,
    host: '127.0.0.1',
    map: 'test',
    ...over,
  };
  let t = 1_800_000_000_000;
  const now = opts.manualClock ? () => t : Date.now;
  const s = await buildServer({ config, db, now, runDirector: !opts.manualClock });
  return Object.assign(s, {
    db,
    config,
    setNow: (ms: number) => void (t = ms),
    advance: (ms: number) => void (t += ms),
    dispose: async () => {
      await s.close();
      await db.close();
    },
  });
}

export async function post(s: BuiltServer, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await s.app.inject({ method: 'POST', url, payload: payload as object, headers });
  return { status: res.statusCode, body: res.json() as any, headers: res.headers };
}

export async function get(s: BuiltServer, url: string, headers: Record<string, string> = {}) {
  const res = await s.app.inject({ method: 'GET', url, headers });
  return { status: res.statusCode, body: res.json() as any };
}

/** Create a squad and fill it with the three remaining roles. */
export async function fullSquad(s: BuiltServer, name: string) {
  const cap = await post(s, '/api/squads', { squadName: name, displayName: `${name}-cap` });
  if (cap.status !== 201) throw new Error(JSON.stringify(cap.body));
  const others = [];
  for (const role of ['RACER', 'ENGINEER', 'DECEIVER']) {
    const r = await post(s, '/api/squads/join', { code: cap.body.joinCode, displayName: `${name}-${role}`, role });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    others.push(r.body);
  }
  return { captain: cap.body, others };
}

import WebSocket from 'ws';
import type { ServerMessage } from '@redline/shared';

export interface TestSocket {
  ws: WebSocket;
  inbox: ServerMessage[];
  next: (pred: (m: ServerMessage) => boolean, timeoutMs?: number) => Promise<ServerMessage>;
  send: (m: unknown) => void;
}

export function connectWs(base: string, origin = 'http://localhost:5173'): Promise<TestSocket> {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { origin });
  const inbox: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as ServerMessage;
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(m);
    else inbox.push(m);
  });
  const next = (pred: (m: ServerMessage) => boolean, timeoutMs = 5000) =>
    new Promise<ServerMessage>((resolve, reject) => {
      const i = inbox.findIndex(pred);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]!);
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
      waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, inbox, next, send: (m) => ws.send(JSON.stringify(m)) }));
    ws.once('error', reject);
  });
}

export const until = async (cond: () => boolean, timeoutMs = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('until: timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};
