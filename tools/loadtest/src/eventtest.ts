/**
 * CODE REDLINE — isolated full-event load test (server-side simulation of 120 participants).
 *
 *   npx tsx tools/loadtest/src/eventtest.ts --live-url <live server URL> [--race-minutes 20] [--squads 30]
 *
 * Isolation (all enforced before any load; the run aborts if a check fails):
 *  - spawns its OWN server process on 127.0.0.1:<port> with a fresh embedded Postgres (PGlite) data dir under the report
 *    dir, a unique EVENT_NAME `loadtest-<run>`, fresh random HOST_ADMIN_KEY / SESSION_SECRET and ALLOW_TIME_WARP=true;
 *    DATABASE_URL / DATABASE_URL_UNPOOLED are REMOVED from the child's environment → it cannot reach Neon.
 *  - checks: target ≠ live URL, target event name = loadtest-<run> ≠ live event name, different world (roomId),
 *    fresh test event (0 squads, registration open), live untouched before vs after (read-only GETs only).
 * Simulates: 30 squads × 4 roles via the real HTTP registration + signed sessions + WS hello; racers drive their real
 * courses with the shared physics/prediction (throttle/steer/brake inputs at 20 Hz); host START; reconnection storm;
 * server restart (persistence + recovery); accelerated finish (time warp, test server only) to the championship;
 * leaderboard verified against an independent SQL read of scoring_events.
 * Not simulated: phone rendering/FPS, real mobile networks, challenge answer submissions by role players.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chennaiMap } from '@redline/shared/map/chennai';
import { coursePolyline, deriveTotals, forwardSpeed, wrapAngle, type ScoringCategory, type SessionResponse, type Standing } from '@redline/shared';
import { Bot, registerFullSquad, rejoin, percentile, type FullSquad } from './bot';

/* ------------------------------------------------------------------ options */
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i]!.startsWith('--')) args.set(process.argv[i]!.slice(2), process.argv[i + 1]?.startsWith('--') ? 'true' : (process.argv[i + 1] ?? 'true'));
const LIVE_URL = (args.get('live-url') ?? '').replace(/\/$/, '');
const NO_LIVE = args.get('no-live-check') === 'true'; // harness self-test only: live check is reported NOT RUN (= FAIL)
const SQUADS = Number(args.get('squads') ?? 30);
const RACE_MIN = Number(args.get('race-minutes') ?? 20);
const PORT = Number(args.get('port') ?? 2701);
const STORM_AT = Number(args.get('storm-at-min') ?? Math.min(8, RACE_MIN / 2));
const RESTART_AT = Number(args.get('restart-at-min') ?? Math.min(14, RACE_MIN * 0.7));
const RUN = randomBytes(3).toString('hex');
const EVENT_NAME = `loadtest-${RUN}`;
const ORIGIN = 'http://loadtest.invalid';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = resolve(args.get('out') ?? join(ROOT, 'tools/loadtest/reports', `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${RUN}`));
const URL_ = `http://127.0.0.1:${PORT}`;
const HOST_KEY = `lt-${randomBytes(12).toString('hex')}`;
const PGDIR = join(OUT, 'pglite');
// constant for the whole run: a real restart keeps its secrets (rejoin credentials must stay valid)
const SESSION_SECRET = randomBytes(32).toString('hex');
const EVENT_SEED = String(Date.now());
if (!LIVE_URL && !NO_LIVE) {
  console.error('--live-url is required (read-only before/after check of the live event)');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const log = (o: Record<string, unknown>) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...o });
  console.log(line);
  appendFileSync(join(OUT, 'events.jsonl'), line + '\n');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const getJson = async (u: string, headers: Record<string, string> = {}) => {
  const r = await fetch(u, { headers });
  if (!r.ok) throw new Error(`${u} → ${r.status}`);
  return (await r.json()) as Record<string, any>;
};
const host = async (path: string, method = 'GET', body?: unknown) => {
  const r = await fetch(`${URL_}${path}`, { method, headers: { 'x-host-key': HOST_KEY, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return (await r.json()) as Record<string, any>;
};

/* ------------------------------------------------------------------ isolated server */
let server: ChildProcess | null = null;
async function startServer(label: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^(DATABASE_URL|DATABASE_URL_UNPOOLED|NEON_|HOST_ADMIN_KEY|SESSION_SECRET|EVENT_|PGLITE_DIR)/.test(k)) delete env[k];
  Object.assign(env, {
    NODE_ENV: 'production', // production config guards (secret lengths, CORS) — embedded DB via explicit opt-in only
    ALLOW_EMBEDDED_DB: 'true',
    PGLITE_DIR: PGDIR,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    EVENT_NAME,
    EVENT_SEED,
    HOST_ADMIN_KEY: HOST_KEY,
    SESSION_SECRET,
    PUBLIC_WEB_ORIGIN: ORIGIN,
    ALLOW_TIME_WARP: 'true',
    JOIN_RATE_LIMIT: '100000',
    MAP: 'chennai',
  });
  server = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['apps/server/src/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.on('data', (d) => appendFileSync(join(OUT, 'server.log'), d));
  server.stderr!.on('data', (d) => appendFileSync(join(OUT, 'server.log'), d));
  const t0 = Date.now();
  for (let i = 0; i < 180; i++) {
    try {
      const h = await getJson(`${URL_}/api/health`);
      if (h.ok) return { ok: true as const, roomId: String(h.roomId), bootMs: Date.now() - t0, label };
    } catch {
      /* booting */
    }
    await sleep(500);
  }
  throw new Error('isolated server did not become healthy');
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  s.kill('SIGTERM');
  await new Promise((r) => s.once('exit', r));
}

/* ------------------------------------------------------------------ live snapshot (read-only) */
async function liveSnapshot() {
  if (NO_LIVE) return { eventName: '(not checked)', status: null, registrationOpen: null, roomId: '(not checked)', squads: -1, teamNames: [] as string[], totals: -1 };
  const [ev, st, h] = await Promise.all([getJson(`${LIVE_URL}/api/event`), getJson(`${LIVE_URL}/api/standings`), getJson(`${LIVE_URL}/api/health`)]);
  const standings = (st.standings ?? []) as Standing[];
  return { eventName: ev.eventName, status: ev.clock?.status, registrationOpen: ev.registrationOpen, roomId: h.roomId, squads: standings.length, teamNames: standings.map((s) => s.name), totals: standings.map((s) => s.total).reduce((a, b) => a + b, 0) };
}

/* ------------------------------------------------------------------ checks + report */
interface Check { name: string; pass: boolean; value: string; need: string }
const checks: Check[] = [];
const check = (name: string, pass: boolean, value: unknown, need: string) => {
  checks.push({ name, pass, value: String(value), need });
  log({ ev: 'check', name, pass, value, need });
};

async function main() {
  log({ ev: 'run', run: RUN, eventName: EVENT_NAME, out: OUT, squads: SQUADS, raceMinutes: RACE_MIN, port: PORT });

  /* 1. isolation preflight */
  const liveBefore = await liveSnapshot();
  log({ ev: 'live-before', ...liveBefore, teamNames: undefined });
  if (existsSync(PGDIR) && readdirSync(PGDIR).length) throw new Error('PGlite dir not empty');
  const boot = await startServer('boot');
  const evInfo = await getJson(`${URL_}/api/event`);
  const ov0 = await host('/api/host/overview');
  const iso = [
    ['target ≠ live URL', NO_LIVE || new URL(URL_).host !== new URL(LIVE_URL).host, `${URL_} vs ${LIVE_URL || '(no live check)'}`],
    ['test event name', evInfo.eventName === EVENT_NAME && evInfo.eventName !== liveBefore.eventName, `${evInfo.eventName} (live: ${liveBefore.eventName})`],
    ['separate world', boot.roomId !== liveBefore.roomId, `${boot.roomId} vs ${liveBefore.roomId}`],
    ['fresh test event', (ov0.squads ?? []).length === 0 && evInfo.registrationOpen === true, `${(ov0.squads ?? []).length} squads, registrationOpen=${evInfo.registrationOpen}`],
    ['no Neon credentials in test server env', true, 'DATABASE_URL* removed; ALLOW_EMBEDDED_DB + fresh PGLITE_DIR'],
  ] as const;
  for (const [n, ok, v] of iso) check(`isolation: ${n}`, ok, v, 'must hold before load');
  if (!iso.every((x) => x[1])) throw new Error('ISOLATION FAILED — aborting before any load');
  log({ ev: 'isolation-verified', bootMs: boot.bootMs });

  /* 2. registration: real HTTP flow, every role its own signed session */
  const regMs: number[] = [];
  const squads: FullSquad[] = [];
  for (let i = 0; i < SQUADS; i++) {
    const a = Date.now();
    squads.push(await registerFullSquad(URL_, `LT ${RUN} ${String(i + 1).padStart(2, '0')}`));
    regMs.push(Date.now() - a);
  }
  check('registration: squads × roles', squads.length === SQUADS && squads.every((s) => new Set(Object.values(s.members).map((m) => m.playerId)).size === 4), `${squads.length} squads × 4 distinct players`, `${SQUADS} × 4`);

  interface Client { bot: Bot; role: string; squad: number; session: SessionResponse; rtt: number[]; snapGaps: number[]; lastSnapAt: number; inputs: number; reconnects: number }
  const clients: Client[] = [];
  const connectMs: number[] = [];
  // snapshot-interval sampling only during live racing (not paused, not the accelerated finish)
  let measuring = false;
  const attach = (c: Client) => {
    c.bot.ws.on('message', (d) => {
      const raw = d.toString();
      if (raw.startsWith('{"t":"snap"')) {
        const now = Date.now();
        if (c.lastSnapAt && measuring) c.snapGaps.push(now - c.lastSnapAt);
        c.lastSnapAt = now;
      } else if (raw.startsWith('{"t":"pong"')) c.rtt.push(Date.now() - JSON.parse(raw).clientTime);
    });
  };
  const connect = async (c: Client, token: string) => {
    const a = Date.now();
    const b = new Bot(c.bot?.label ?? `${squads[c.squad]!.name}/${c.role}`, { origin: ORIGIN });
    await b.connect(URL_, token);
    c.bot = b;
    c.lastSnapAt = 0;
    attach(c);
    return Date.now() - a;
  };
  for (const [si, sq] of squads.entries())
    for (const role of ['RACER', 'ENGINEER', 'DECEIVER', 'CAPTAIN'] as const) {
      const c = { role, squad: si, session: sq.members[role], rtt: [], snapGaps: [], lastSnapAt: 0, inputs: 0, reconnects: 0 } as unknown as Client;
      connectMs.push(await connect(c, c.session.sessionToken));
      clients.push(c);
    }
  check('connections: all participants connected', clients.length === SQUADS * 4, clients.length, `${SQUADS * 4}`);
  const { default: WebSocket } = await import('ws');
  const openObservers = () =>
    ['host', 'projector'].map(() => {
      const ws = new WebSocket(`${URL_.replace(/^http/, 'ws')}/ws`, { origin: ORIGIN });
      ws.on('open', () => ws.send(JSON.stringify({ t: 'host_hello', hostKey: HOST_KEY })));
      return ws;
    });
  let observers = openObservers();

  /* 3. host START */
  const start = await host('/api/host/start', 'POST', { force: true });
  check('host START', ['COUNTDOWN', 'LIVE'].includes(start.clock?.status), start.clock?.status, 'COUNTDOWN/LIVE');

  /* 4. racing: real input protocol at 20 Hz, pursuit along each squad's real course */
  const map = chennaiMap();
  const paths = new Map<Client, { pts: ReturnType<typeof coursePolyline>; i: number }>();
  let tick = 0;
  let driving = true;
  const driver = setInterval(() => {
    if (!driving) return;
    tick++;
    for (const c of clients) {
      if (c.role !== 'RACER') continue;
      const b = c.bot;
      const s = b.predictor?.state;
      const me = b.lastSnap?.me;
      if (!s || !me?.cs) continue;
      let P = paths.get(c);
      if (!P) paths.set(c, (P = { pts: coursePolyline(map.net, map.courses[me.cs]!.des), i: 0 }));
      let best = P.i;
      let bd = Infinity;
      for (let j = Math.max(0, P.i - 5); j < Math.min(P.pts.length, P.i + 80); j++) {
        const d = (P.pts[j]!.x - s.x) ** 2 + (P.pts[j]!.z - s.z) ** 2;
        if (d < bd) (bd = d), (best = j);
      }
      P.i = best;
      const v = Math.max(0, forwardSpeed(s));
      let j = P.i;
      while (j < P.pts.length - 1 && P.pts[j]!.d - P.pts[P.i]!.d < 7 + v * 0.6) j++;
      const t = P.pts[j]!;
      const err = wrapAngle(Math.atan2(t.x - s.x, t.z - s.z) - s.heading);
      const target = Math.abs(err) > 0.5 ? 9 : 17; // slow for corners
      const steer = Math.max(-1, Math.min(1, err * 2.2));
      if (b.drive({ steer, throttle: v < target ? 0.85 : 0, brake: v > target + 3 ? 0.6 : 0 })) c.inputs++;
    }
    if (tick % 40 === 0) for (const c of clients) c.bot.send({ t: 'ping', clientTime: Date.now() } as never);
  }, 50);

  const samples: Record<string, any>[] = [];
  const t0 = Date.now();
  let lastBytes = 0;
  let lastAt = t0;
  let storm: Record<string, unknown> | null = null;
  let restart: Record<string, unknown> | null = null;
  const sampleOnce = async () => {
    const w = await host('/api/host/world').catch(() => null);
    const ov = await host('/api/host/overview').catch(() => null);
    const bytes = clients.reduce((a, c) => a + c.bot.stats.bytes, 0);
    const now = Date.now();
    const rtts = clients.flatMap((c) => c.rtt.splice(0));
    const gaps = racerGaps.slice(-5000);
    const s = {
      ev: 'sample',
      min: +((now - t0) / 60000).toFixed(2),
      status: ov?.clock?.status,
      phase: ov?.clock?.phase,
      serverClients: w?.clients,
      tickP99Ms: w?.tickP99Ms,
      cpuPctOneCore: w?.process?.cpuPctOneCore,
      rssMB: w?.process?.rssMB,
      loopDelayP99Ms: w?.process?.eventLoopDelayP99Ms,
      oneWorld: new Set(clients.filter((c) => !c.bot.closed).map((c) => c.bot.roomId)).size === 1,
      openClients: clients.filter((c) => !c.bot.closed).length,
      downKBpsAll: +((bytes - lastBytes) / 1024 / ((now - lastAt) / 1000)).toFixed(1),
      rtt: { n: rtts.length, p50: percentile(rtts, 0.5), p95: percentile(rtts, 0.95), p99: percentile(rtts, 0.99) },
      racerSnapGapMs: { n: gaps.length, p50: percentile(gaps, 0.5), p95: percentile(gaps, 0.95), p99: percentile(gaps, 0.99) },
      cars: w?.cars?.length,
      checkpointsTotal: (w?.cars ?? []).reduce((a: number, c: any) => a + (c.checkpoint ?? c.cp ?? 0), 0),
    };
    lastBytes = bytes;
    lastAt = now;
    samples.push(s);
    log(s);
    return s;
  };
  const allRtt: number[] = [];
  const racerGaps: number[] = [];
  const roleGaps: number[] = [];
  const takeGaps = () => {
    for (const c of clients) (c.role === 'RACER' ? racerGaps : roleGaps).push(...c.snapGaps.splice(0));
  };

  const raceEnd = t0 + RACE_MIN * 60_000;
  measuring = true;
  while (Date.now() < raceEnd) {
    await sleep(15_000);
    for (const c of clients) allRtt.push(...c.rtt);
    takeGaps();
    await sampleOnce();
    const el = (Date.now() - t0) / 60000;

    if (!storm && el >= STORM_AT) {
      // reconnection storm: 40 participants drop without a close handshake and rejoin with their rejoin tokens
      const victims = clients.filter((_, i) => i % 3 === 0).slice(0, 40);
      const a = Date.now();
      for (const v of victims) v.bot.drop();
      const times = await Promise.all(
        victims.map(async (v) => {
          const s = Date.now();
          v.session = await rejoin(URL_, v.session.rejoinToken);
          await connect(v, v.session.sessionToken);
          v.reconnects++;
          if (v.role === 'RACER') paths.delete(v);
          return Date.now() - s;
        }),
      );
      storm = { victims: victims.length, totalMs: Date.now() - a, p50: percentile(times, 0.5), p95: percentile(times, 0.95), max: Math.max(...times), oneWorld: new Set(clients.map((c) => c.bot.roomId)).size === 1 };
      log({ ev: 'storm', ...storm });
    }

    if (!restart && el >= RESTART_AT) {
      // persistence: pause (freeze scoring), snapshot standings, kill the server, restart on the same DB, everyone rejoins
      measuring = false;
      await host('/api/host/pause', 'POST');
      await sleep(1500);
      const before = (await getJson(`${URL_}/api/standings`)).standings as Standing[];
      driving = false;
      const k = Date.now();
      await stopServer();
      const b2 = await startServer('restart');
      const ovR = await host('/api/host/overview');
      const after = (await getJson(`${URL_}/api/standings`)).standings as Standing[];
      const back: number[] = [];
      await Promise.all(
        clients.map(async (c) => {
          const s = Date.now();
          c.session = await rejoin(URL_, c.session.rejoinToken);
          await connect(c, c.session.sessionToken);
          c.reconnects++;
          back.push(Date.now() - s);
        }),
      );
      paths.clear();
      observers = openObservers(); // host/projector screens reconnect too
      const resumed = await host('/api/host/resume', 'POST');
      driving = true;
      for (const c of clients) c.lastSnapAt = 0;
      measuring = true;
      const same = before.length === after.length && before.every((b) => after.find((x) => x.teamId === b.teamId)?.total === b.total);
      restart = { downtimeMs: b2.bootMs, totalMs: Date.now() - k, restoredStatus: ovR.clock?.status, squadsAfter: (ovR.squads ?? []).length, standingsIdentical: same, rejoinP95Ms: percentile(back, 0.95), resumedStatus: resumed.clock?.status, oneWorld: new Set(clients.map((c) => c.bot.roomId)).size === 1 };
      log({ ev: 'restart', ...restart });
    }
  }

  /* 5. accelerated finish on the TEST server only: gate → escort → convoy → championship → finished */
  measuring = false;
  const progressAtFinish = new Map([...paths.entries()].map(([c, P]) => [c, { ...P }]));
  const preFinish = await getJson(`${URL_}/api/standings`);
  /* 4b. Levels 3–4 under load on the TEST server: every role plays its new mechanic through the real HTTP API */
  const L34 = { safeHolds: 0, safeHoldErrors: 0, jams: 0, blocked: 0, shields: 0, alliances: 0, duelAnswers: 0, duelCorrect: 0, offers: 0, accepted: 0, depot: 0, errors: [] as string[] };
  if (!args.has('skip-levels')) {
    const call = async (token: string, path: string, body: unknown) => {
      const r = await fetch(`${URL_}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as Record<string, any>;
      if (!r.ok && L34.errors.length < 12) L34.errors.push(`${path} ${r.status} ${j.error ?? ''}`);
      return { ok: r.ok, body: j };
    };
    const by = (role: string) => clients.filter((c) => c.role === role);
    const view = (c: Client) => c.bot.lastSquad as any;
    await host('/api/host/warp', 'POST', { toElapsedMs: Math.round(24.4 * 60_000) });
    await sleep(4000);
    // Racers: safe-hold during the open navigation puzzle, then release
    for (const c of by('RACER')) {
      const r = await call(c.session.sessionToken, '/api/squad/safe-hold', { on: true });
      if (r.ok) L34.safeHolds++;
      else L34.safeHoldErrors++;
    }
    await sleep(3000);
    for (const c of by('RACER')) await call(c.session.sessionToken, '/api/squad/safe-hold', { on: false });
    // Deceivers: every third raises a shield first; everyone jams its first legal target
    for (const [i, c] of by('DECEIVER').entries()) if (i % 3 === 0 && (await call(c.session.sessionToken, '/api/squad/intel/shield', {})).ok) L34.shields++;
    await sleep(1500);
    for (const c of by('DECEIVER')) {
      const t = view(c)?.intel?.deceiver?.targets?.[0]?.teamId;
      if (!t) continue;
      const r = await call(c.session.sessionToken, '/api/squad/intel/jam', { target: t });
      if (r.body.landed) L34.jams++;
      if (r.body.blocked) L34.blocked++;
    }
    // Captains: squads 1+2 and 3+4 form alliances
    const caps = by('CAPTAIN');
    for (const k of [0, 2]) {
      const a = caps[k];
      const b = caps[k + 1];
      if (!a || !b) continue;
      await call(a.session.sessionToken, '/api/squad/intel/ally/propose', { target: b.session.teamId });
      if ((await call(b.session.sessionToken, '/api/squad/intel/ally/accept', { from: a.session.teamId })).ok) L34.alliances++;
    }
    // Level 4: matchmaking at 33:00, duels answered from the Captain's own options, trades, depot
    await host('/api/host/warp', 'POST', { toElapsedMs: Math.round(33.3 * 60_000) });
    await sleep(5000);
    for (const c of caps) {
      const d = view(c)?.rival?.duel;
      for (const opt of (d?.options ?? []).slice(0, 2)) {
        const r = await call(c.session.sessionToken, '/api/squad/rival/duel', { answer: opt, key: `lt-${c.session.teamId}-${opt}` });
        L34.duelAnswers++;
        if (r.body.correct) {
          L34.duelCorrect++;
          break;
        }
        if (r.body.result && r.body.result !== 'pending') break;
      }
    }
    for (const c of caps) {
      const rv = view(c)?.rival;
      if (!rv) continue;
      if (!rv.partner) {
        if ((await call(c.session.sessionToken, '/api/squad/rival/depot', { option: 'fuel' })).ok) L34.depot++;
      } else if (c.session.teamId < rv.partner.teamId && (await call(c.session.sessionToken, '/api/squad/rival/offer', { give: { kind: 'credits', amount: 20 }, want: { kind: 'fuel', amount: 5 }, key: `lt-offer-${c.session.teamId}` })).ok) L34.offers++;
    }
    await sleep(2500);
    for (const c of caps) {
      const off = (view(c)?.rival?.trade?.offers ?? []).find((o: any) => o.from === 'them' && o.status === 'open');
      if (off && (await call(c.session.sessionToken, '/api/squad/rival/respond', { offerId: off.id, accept: true })).body.status === 'accepted') L34.accepted++;
    }
    log({ ev: 'levels34', ...L34 });
  }

  for (const [min, wait] of [[49.9, 8], [51.6, 12], [55.1, 20], [58.1, 12], [60.1, 6]] as const) {
    await host('/api/host/warp', 'POST', { toElapsedMs: Math.round(min * 60_000) });
    await sleep(wait * 1000);
    await sampleOnce();
  }
  driving = false;
  clearInterval(driver);
  const ovEnd = await host('/api/host/overview');
  const final = await getJson(`${URL_}/api/standings`);
  const finalStandings = (final.standings ?? []) as Standing[];
  const unplanned = clients.filter((c) => c.bot.closed).length + observers.filter((o) => o.readyState !== o.OPEN).length;
  const wEnd = await host('/api/host/world');

  /* 6. stop server, independent leaderboard + persistence check straight from the test database */
  for (const c of clients) c.bot.close();
  for (const o of observers) o.close();
  await stopServer();
  const { connectPglite } = await import('@redline/db');
  const dbh = await connectPglite(PGDIR, { migrate: false });
  const q = async (sql: string, params: unknown[] = []) => ((await (dbh as any).db.$client.query(sql, params)) as { rows: any[] }).rows;
  const [evRow] = await q('select id from events where name = $1', [EVENT_NAME]);
  const counts = (await q(`select (select count(*) from teams where event_id=$1)::int teams,
      (select count(*) from players p join teams t on t.id=p.team_id where t.event_id=$1)::int players,
      (select count(*) from sessions where event_id=$1)::int sessions,
      (select count(*) from scoring_events s join teams t on t.id=s.team_id where t.event_id=$1)::int scoring_events,
      (select count(*) from vehicle_checkpoints v join teams t on t.id=v.team_id where t.event_id=$1)::int checkpoints,
      (select count(*) from recovery_snapshots where event_id=$1)::int snapshots,
      (select count(*) from events)::int events_in_db,
      (select count(*) from scoring_events s join teams t on t.id=s.team_id where t.event_id=$1 and s.source_type in ('rival_duel'))::int duel_rows,
      (select count(*) from scoring_events s join teams t on t.id=s.team_id where t.event_id=$1 and s.source_type in ('rival_trade'))::int trade_rows,
      (select count(*) from scoring_events s join teams t on t.id=s.team_id where t.event_id=$1 and s.source_type in ('intel_jam','intel_block'))::int intel_rows,
      (select count(*) from fuel_transactions f join teams t on t.id=f.team_id where t.event_id=$1 and f.reason in ('rival_trade','rival_depot'))::int trade_ledger`, [evRow.id]))[0];
  const raw = await q('select s.team_id, s.category, s.points from scoring_events s join teams t on t.id=s.team_id where t.event_id=$1', [evRow.id]);
  await dbh.close();
  const mismatches: string[] = [];
  for (const st of finalStandings) {
    const mine = raw.filter((r) => r.team_id === st.teamId).map((r) => ({ category: r.category as ScoringCategory, points: Number(r.points) }));
    const exp = deriveTotals(mine);
    if (exp.total !== st.total) mismatches.push(`${st.name}: standings ${st.total} vs SQL ${exp.total}`);
  }
  const ranksOk = finalStandings.every((s, i) => s.rank === i + 1) && finalStandings.every((s, i) => i === 0 || finalStandings[i - 1]!.total >= s.total);

  /* 7. live event untouched (read-only) */
  const liveAfter = await liveSnapshot();
  const leaked = liveAfter.teamNames.filter((n) => n.includes(`LT ${RUN}`) || n.startsWith('LT '));

  /* 8. verdict */
  const rttAll = allRtt.concat(clients.flatMap((c) => c.rtt));
  takeGaps();
  const gapAll = racerGaps;
  const raceSamples = samples.filter((s) => s.status === 'LIVE');
  const maxOf = (k: string) => Math.max(0, ...samples.map((s) => Number(s[k]) || 0));
  check('stability: unplanned disconnects', unplanned === 0, unplanned, '0');
  check('one shared world (every sample)', samples.every((s) => s.oneWorld), samples.filter((s) => !s.oneWorld).length + ' bad samples', 'all');
  check('server tick p99 (worst 15 s window)', maxOf('tickP99Ms') <= 25, maxOf('tickP99Ms') + ' ms', '≤ 25 ms (tick budget 50 ms)');
  check('event-loop delay p99 (worst)', maxOf('loopDelayP99Ms') <= 50, maxOf('loopDelayP99Ms') + ' ms', '≤ 50 ms');
  check('server RSS peak', maxOf('rssMB') <= 1536, maxOf('rssMB') + ' MB', '≤ 1.5 GB (Codespaces 2-core has 8 GB)');
  check('WS round-trip p99 (server responsiveness, local network)', percentile(rttAll, 0.99) <= 100, `p50 ${percentile(rttAll, 0.5)} / p95 ${percentile(rttAll, 0.95)} / p99 ${percentile(rttAll, 0.99)} ms`, 'p99 ≤ 100 ms');
  check('racer snapshot interval (designed 20 Hz = 50 ms)', percentile(gapAll, 0.95) <= 75, `p50 ${percentile(gapAll, 0.5)} / p95 ${percentile(gapAll, 0.95)} / p99 ${percentile(gapAll, 0.99)} ms (n=${gapAll.length})`, 'p95 ≤ 75 ms');
  const roleMsgs = clients.filter((c) => c.role !== 'RACER').map((c) => c.bot.stats.messages);
  check('role consoles (Engineer/Deceiver/Captain) receive live updates', roleMsgs.length > 0 && Math.min(...roleMsgs) > 0, `min ${Math.min(...roleMsgs)} msgs per role client since last (re)connect`, '> 0 for every role client');
  const prog = [...progressAtFinish.values()].map((P) => (P.pts[P.i]!.d / P.pts[P.pts.length - 1]!.d) * 100).sort((a, b) => a - b);
  check('racers drove their real courses', prog.length === SQUADS && percentile(prog, 0.5) > (RACE_MIN >= 6 ? 5 : 0), `course progress min ${prog[0]?.toFixed(1)}% / median ${percentile(prog, 0.5).toFixed(1)}% / max ${prog[prog.length - 1]?.toFixed(1)}% (since last reconnect)`, RACE_MIN >= 6 ? 'median > 5%' : 'recorded');
  check('racing scored driving points', RACE_MIN < 6 || counts.scoring_events > 0, `${counts.checkpoints} checkpoint passes, ${counts.scoring_events} scoring events${RACE_MIN < 6 ? ' (run too short to reach checkpoint 1: not judged)' : ''}`, '> 0 scoring events');
  check('reconnection storm (40 drop + rejoin)', !!storm && (storm as any).p95 <= 10_000 && (storm as any).oneWorld, storm ? `p95 ${(storm as any).p95} ms, max ${(storm as any).max} ms` : 'not run', 'p95 ≤ 10 s, same world');
  check('restart: recovery + persistence', !!restart && (restart as any).restoredStatus === 'PAUSED' && (restart as any).squadsAfter === SQUADS && (restart as any).standingsIdentical && (restart as any).oneWorld, restart ? JSON.stringify(restart) : 'not run', 'PAUSED, all squads, identical standings, one world');
  check('race completion', ovEnd.clock?.status === 'FINISHED' && final.final === true && finalStandings.length === SQUADS, `${ovEnd.clock?.status}, final=${final.final}, ${finalStandings.length} teams`, `FINISHED, final standings for ${SQUADS}`);
  check('leaderboard = independent SQL over scoring_events', mismatches.length === 0 && ranksOk, mismatches.length ? mismatches.slice(0, 5).join('; ') : `${finalStandings.length} teams match, ranks ordered`, 'exact');
  check('persistence: rows in test DB', counts.teams === SQUADS && counts.players === SQUADS * 4 && counts.sessions >= SQUADS * 4 && counts.snapshots > 0, JSON.stringify(counts), `${SQUADS} teams, ${SQUADS * 4} players, sessions, snapshots`);
  if (!args.has('skip-levels')) {
    const pairs = Math.floor(SQUADS / 2);
    check('L3 safe-hold (every Racer, open navigation puzzle)', L34.safeHolds === SQUADS, `${L34.safeHolds}/${SQUADS} holds, ${L34.safeHoldErrors} refused`, `${SQUADS}`);
    check('L3 Deceiver jams + shields landed and scored', L34.jams > 0 && counts.intel_rows === L34.jams + L34.blocked, `${L34.jams} jams, ${L34.blocked} blocked, ${L34.shields} shields, ${counts.intel_rows} DECEPTION rows`, 'rows = landed + blocked');
    check('L3 alliances (both Captains)', L34.alliances === Math.min(2, Math.floor(SQUADS / 2)), L34.alliances, 'as proposed');
    check('L4 duels answered by Captains only via their own options', L34.duelAnswers > 0 && counts.duel_rows === L34.duelCorrect, `${L34.duelAnswers} answers, ${L34.duelCorrect} correct, ${counts.duel_rows} duel rows`, 'rows = correct answers');
    check('L4 trades atomic + ledgered once', L34.accepted === L34.offers && counts.trade_rows === 2 * L34.accepted && counts.trade_ledger === 2 * L34.accepted + L34.depot, `${L34.offers} offers, ${L34.accepted} accepted (${pairs} pairs), ${L34.depot} depot, ${counts.trade_ledger} ledger rows`, 'ledger = 2×trades + depot');
    check('L3–L4 API errors', L34.errors.every((e) => /COOLDOWN|TARGET_PROTECTED|BAD_TARGET|DUEL_DONE/.test(e)), L34.errors.join('; ') || 'none', 'only expected rule refusals');
  }
  if (NO_LIVE) check('live event untouched', false, 'NOT RUN (--no-live-check)', 'identical before/after');
  else check('live event untouched', leaked.length === 0 && liveAfter.eventName === liveBefore.eventName && liveAfter.squads === liveBefore.squads && liveAfter.status === liveBefore.status && liveAfter.totals === liveBefore.totals, `squads ${liveBefore.squads}→${liveAfter.squads}, status ${liveBefore.status}→${liveAfter.status}, test names leaked: ${leaked.length}`, 'identical before/after');

  const pass = checks.every((c) => c.pass);
  const report = {
    pass,
    run: RUN,
    eventName: EVENT_NAME,
    environment: { host: process.env.CODESPACE_NAME ? `codespace ${process.env.CODESPACE_NAME}` : 'local', cpus: (await import('node:os')).cpus().length, note: 'server + 122 bot clients on the same machine; RTT measures server responsiveness, not mobile networks' },
    durationMin: +((Date.now() - t0) / 60000).toFixed(1),
    raceMinutesLive: RACE_MIN,
    registrationMs: { p50: percentile(regMs, 0.5), p95: percentile(regMs, 0.95), p99: percentile(regMs, 0.99) },
    wsConnectMs: { p50: percentile(connectMs, 0.5), p95: percentile(connectMs, 0.95), p99: percentile(connectMs, 0.99) },
    rttMs: { n: rttAll.length, p50: percentile(rttAll, 0.5), p95: percentile(rttAll, 0.95), p99: percentile(rttAll, 0.99) },
    roleSnapshotIntervalMs: { n: roleGaps.length, p50: percentile(roleGaps, 0.5), p95: percentile(roleGaps, 0.95), p99: percentile(roleGaps, 0.99) },
    racerSnapshotIntervalMs: { n: gapAll.length, p50: percentile(gapAll, 0.5), p95: percentile(gapAll, 0.95), p99: percentile(gapAll, 0.99) },
    server: { tickP99WorstMs: maxOf('tickP99Ms'), tickP99AllMs: wEnd.tickP99AllMs, cpuPctOneCoreAvg: +(raceSamples.reduce((a, s) => a + (s.cpuPctOneCore ?? 0), 0) / Math.max(1, raceSamples.length)).toFixed(1), cpuPctOneCorePeak: maxOf('cpuPctOneCore'), rssPeakMB: maxOf('rssMB'), loopDelayP99WorstMs: maxOf('loopDelayP99Ms'), bytesOutTotalMB: +((wEnd.bytesOut ?? 0) / 1048576).toFixed(1) },
    network: { downKBpsAllPeak: maxOf('downKBpsAll'), downKBpsPerClientAvg: +(raceSamples.reduce((a, s) => a + s.downKBpsAll, 0) / Math.max(1, raceSamples.length) / clients.length).toFixed(2), inputsSent: clients.reduce((a, c) => a + c.inputs, 0) },
    storm,
    restart,
    dbCounts: counts,
    finalTop3: finalStandings.slice(0, 3).map((s) => ({ rank: s.rank, name: s.name, total: s.total })),
    preFinishLeader: (preFinish.standings ?? [])[0]?.total,
    liveBefore: { ...liveBefore, teamNames: undefined },
    liveAfter: { ...liveAfter, teamNames: undefined },
    checks,
  };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const md = [
    `# CODE REDLINE isolated load test — ${pass ? 'PASS' : 'FAIL'}`,
    '',
    `Run \`${RUN}\` · event \`${EVENT_NAME}\` (isolated, embedded Postgres) · ${report.environment.host}, ${report.environment.cpus} CPUs · ${report.durationMin} min (${RACE_MIN} min live racing + accelerated finish)`,
    '',
    '| Check | Result | Measured | Requirement |',
    '|---|---|---|---|',
    ...checks.map((c) => `| ${c.name} | ${c.pass ? 'PASS' : '**FAIL**'} | ${c.value.replace(/\|/g, '/')} | ${c.need} |`),
    '',
    '## Measurements',
    '```json',
    JSON.stringify({ registrationMs: report.registrationMs, wsConnectMs: report.wsConnectMs, rttMs: report.rttMs, racerSnapshotIntervalMs: report.racerSnapshotIntervalMs, roleSnapshotIntervalMs: report.roleSnapshotIntervalMs, server: report.server, network: report.network, storm, restart, dbCounts: counts }, null, 2),
    '```',
    '',
    'Not covered by this server-side simulation: phone rendering/FPS, touch input, real mobile/Wi-Fi networks, Codespaces/Internet path latency from Chennai, role challenge answer submissions.',
  ].join('\n');
  writeFileSync(join(OUT, 'report.md'), md);
  log({ ev: 'done', pass, report: join(OUT, 'report.md') });
}

main()
  .catch(async (e) => {
    log({ ev: 'aborted', error: String((e as Error).stack ?? e) });
    await stopServer();
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServer();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
