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
  const db = await connectPglite();
  const config: ServerConfig = {
    ...loadConfig({ NODE_ENV: 'test', HOST_ADMIN_KEY: HOST_KEY, SESSION_SECRET: 'test-secret-'.padEnd(40, 'x') }),
    eventName: `test-event-${process.pid}-${++counter}`,
    joinAttemptsPerMinute: 10_000,
    host: '127.0.0.1',
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
