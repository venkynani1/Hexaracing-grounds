/**
 * Full 60-minute rehearsal against a running server, real time (no time warp):
 *   npx tsx src/rehearsal.ts --url http://localhost:2567 --host-key <key> [--minutes 62]
 * 30 full squads (4 role clients each = 120 participant connections) + host + projector observers.
 * Racers drive their real courses (reference-style pursuit on the shared physics); every minute samples:
 * phase, server tick p99, clients, cars, one-world check (every client reports the same roomId), RTT (ping/pong).
 * At 20:00 a reconnection storm: 40 clients drop and rejoin with their rejoin tokens.
 * Writes JSON lines to stdout; final summary at the end.
 */
import { chennaiMap } from '@redline/shared/map/chennai';
import { coursePolyline, forwardSpeed, wrapAngle, type SessionResponse } from '@redline/shared';
import { Bot, registerFullSquad, rejoin, percentile, type FullSquad } from './bot';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i]!.startsWith('--')) args.set(process.argv[i]!.slice(2), process.argv[i + 1] ?? 'true');
const url = args.get('url') ?? 'http://localhost:2567';
const hostKey = args.get('host-key') ?? 'dev-host-key';
const minutes = Number(args.get('minutes') ?? 62);
const origin = args.get('origin') ?? 'http://localhost:5173';
const log = (o: unknown) => console.log(JSON.stringify({ t: new Date().toISOString(), ...(o as object) }));
const host = async (path: string, method = 'GET', body?: unknown) => {
  const r = await fetch(`${url}${path}`, { method, headers: { 'x-host-key': hostKey, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json() as Promise<Record<string, any>>;
};
const map = chennaiMap();

const squads: FullSquad[] = [];
for (let i = 0; i < 30; i++) squads.push(await registerFullSquad(url, `Rehearsal ${String(i + 1).padStart(2, '0')}`));
log({ ev: 'registered', squads: squads.length, players: squads.length * 4 });

interface Client {
  bot: Bot;
  role: string;
  squad: number;
  session: SessionResponse;
  rtt: number[];
}
const clients: Client[] = [];
for (const [si, sq] of squads.entries())
  for (const role of ['RACER', 'ENGINEER', 'DECEIVER', 'CAPTAIN'] as const) {
    const b = new Bot(`${sq.name}/${role}`, { origin });
    const session = sq.members[role];
    await b.connect(url, session.sessionToken);
    b.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === 'pong') c.rtt.push(Date.now() - m.clientTime);
    });
    const c: Client = { bot: b, role, squad: si, session, rtt: [] };
    clients.push(c);
  }
// host + projector observers (read-only world feeds)
const observers: { closed: boolean; bytes: number }[] = [];
for (const kind of ['host', 'projector']) {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`, { origin });
  const o = { closed: false, bytes: 0 };
  ws.on('message', (d) => (o.bytes += d.toString().length));
  ws.on('close', () => (o.closed = true));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'host_hello', hostKey }));
  observers.push(o);
}
log({ ev: 'connected', clients: clients.length, observers: observers.length });
log({ ev: 'start', clock: (await host('/api/host/start', 'POST', { force: true })).clock });

// Racer driving: pursuit along each squad's real course (the server decides everything).
const racers = clients.filter((c) => c.role === 'RACER');
const paths = new Map<Client, { pts: ReturnType<typeof coursePolyline>; i: number }>();
let k = 0;
const driver = setInterval(() => {
  k++;
  for (const c of racers) {
    const b = c.bot;
    const s = b.predictor?.state;
    const me = b.lastSnap?.me;
    if (!s || !me?.cs) continue;
    let P = paths.get(c);
    if (!P) paths.set(c, (P = { pts: coursePolyline(map.net, map.courses[me.cs]!.des), i: 0 }));
    let best = P.i;
    let bd = Infinity;
    for (let j = P.i; j < Math.min(P.pts.length, P.i + 80); j++) {
      const d = (P.pts[j]!.x - s.x) ** 2 + (P.pts[j]!.z - s.z) ** 2;
      if (d < bd) (bd = d), (best = j);
    }
    P.i = best;
    const v = Math.max(0, forwardSpeed(s));
    let j = P.i;
    while (j < P.pts.length - 1 && P.pts[j]!.d - P.pts[P.i]!.d < 7 + v * 0.6) j++;
    const t = P.pts[j]!;
    const steer = Math.max(-1, Math.min(1, wrapAngle(Math.atan2(t.x - s.x, t.z - s.z) - s.heading) * 2.2));
    const target = 15;
    b.drive({ steer, throttle: v < target ? 0.8 : 0, brake: v > target + 4 ? 0.5 : 0 });
  }
  // RTT probes: every 5 s from every client
  if (k % 100 === 0) for (const c of clients) c.bot.send({ t: 'ping', clientTime: Date.now() } as never);
}, 50);

const samples: Record<string, unknown>[] = [];
let storm: Record<string, unknown> | null = null;
const t0 = Date.now();
const deadline = t0 + minutes * 60_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 60_000));
  const w = await host('/api/host/world');
  const ov = await host('/api/host/overview').catch(() => ({}));
  const rooms = new Set(clients.filter((c) => !c.bot.closed).map((c) => c.bot.roomId));
  const rtts = clients.flatMap((c) => c.rtt.splice(0));
  const sample = {
    ev: 'sample',
    min: Math.round((Date.now() - t0) / 60_000),
    phase: (ov as any).clock?.phase ?? null,
    status: (ov as any).clock?.status ?? null,
    elapsed: (ov as any).clock?.elapsedMs ?? null,
    tickP99Last400Ms: w.tickP99Ms,
    tickP99AllMs: w.tickP99AllMs,
    clientsServer: w.clients,
    cars: w.cars?.length,
    traffic: w.trafficCount,
    closedClients: clients.filter((c) => c.bot.closed).length,
    oneWorld: rooms.size === 1,
    rttMs: rtts.length ? { p50: percentile(rtts, 0.5), p95: percentile(rtts, 0.95), max: Math.max(...rtts) } : null,
    downKBpsPerClient: +(clients.reduce((a, c) => a + c.bot.stats.bytes, 0) / clients.length / ((Date.now() - t0) / 1000) / 1024).toFixed(2),
  };
  samples.push(sample);
  log(sample);
  if (!storm && Date.now() - t0 > 20 * 60_000) {
    // reconnection storm: 40 clients drop without a close handshake and rejoin with their rejoin tokens
    const victims = clients.filter((_, i) => i % 3 === 0).slice(0, 40);
    const ts = Date.now();
    for (const v of victims) v.bot.drop();
    const times: number[] = [];
    await Promise.all(
      victims.map(async (v) => {
        const a = Date.now();
        const fresh = await rejoin(url, v.session.rejoinToken);
        const nb = new Bot(v.bot.label, { origin });
        await nb.connect(url, fresh.sessionToken);
        nb.ws.on('message', (d) => {
          const m = JSON.parse(d.toString());
          if (m.t === 'pong') v.rtt.push(Date.now() - m.clientTime);
        });
        v.bot = nb;
        v.session = fresh;
        if (v.role === 'RACER') paths.delete(v);
        times.push(Date.now() - a);
      }),
    );
    storm = { ev: 'storm', clients: victims.length, totalMs: Date.now() - ts, rejoinP95Ms: percentile(times, 0.95), sameWorld: new Set(clients.map((c) => c.bot.roomId)).size === 1 };
    log(storm);
  }
}
clearInterval(driver);
const standings = await fetch(`${url}/api/standings`).then((r) => r.json()).catch(() => null);
const world = await host('/api/host/world');
const summary = {
  ev: 'summary',
  minutes,
  clients: clients.length,
  observers: observers.length,
  everDisconnectedUnplanned: clients.filter((c) => c.bot.closed).length + observers.filter((o) => o.closed).length,
  oneWorldEverySample: samples.every((s) => s.oneWorld),
  worstTickP99AllMs: Math.max(...samples.map((s) => Number(s.tickP99AllMs) || 0)),
  worstTickP99Last400Ms: Math.max(...samples.map((s) => Number(s.tickP99Last400Ms) || 0)),
  rttP95Worst: Math.max(...samples.map((s) => (s.rttMs as any)?.p95 ?? 0)),
  phasesSeen: [...new Set(samples.map((s) => s.phase))],
  finalStatus: samples[samples.length - 1]?.status,
  storm,
  standingsSquads: (standings as any)?.standings?.length ?? (standings as any)?.length ?? null,
  serverTicks: world.tick,
};
log(summary);
for (const c of clients) c.bot.close();
process.exit(0);
