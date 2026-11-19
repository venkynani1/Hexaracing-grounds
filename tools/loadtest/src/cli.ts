/**
 * Real-time load test against a running server:
 *   npm run loadtest -- --url http://localhost:2567 --bots 30 --seconds 60 --host-key <key> [--start]
 * Registers N squads (captain + racer), connects N racer bots, optionally force-starts the event, drives
 * for the given time at 20 Hz and reports bandwidth, snapshot rate, correction error and server tick stats.
 * NOTE: registration is rate limited per IP; run the server with JOIN_RATE_LIMIT raised for large N.
 */
import { Bot, percentile, registerSquad } from './bot';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1]?.startsWith('--') || i + 1 >= process.argv.length ? 'true' : process.argv[++i]!);
}
const url = args.get('url') ?? 'http://localhost:2567';
const wsUrl = url.replace(/^http/, 'ws');
const N = Number(args.get('bots') ?? 30);
const seconds = Number(args.get('seconds') ?? 30);
const hostKey = args.get('host-key') ?? 'dev-host-key';
const origin = args.get('origin') ?? 'http://localhost:5173';

const host = (path: string, method = 'GET') =>
  fetch(`${url}${path}`, { method, headers: { 'x-host-key': hostKey, 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ force: true }) : undefined }).then((r) => r.json() as Promise<any>);

console.log(`[loadtest] ${N} racer bots → ${url} for ${seconds}s`);
const runId = Date.now().toString(36).slice(-4);
const squads = [];
for (let i = 0; i < N; i++) squads.push(await registerSquad(url, `Bot${runId}-${i}`));
const bots = await Promise.all(
  squads.map(async (s, i) => {
    const b = new Bot(`bot${i}`, { origin });
    await b.connect(wsUrl, s.racer.sessionToken);
    return b;
  }),
);
console.log(`[loadtest] connected ${bots.length}; rooms: ${new Set(bots.map((b) => b.roomId)).size}`);
if (args.get('start') === 'true') console.log('[loadtest] start →', JSON.stringify((await host('/api/host/start', 'POST')).clock ?? {}));

// Wait for LIVE + first snapshot per bot.
const t0 = Date.now();
while (bots.some((b) => !b.predictor?.state) && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 100));
for (const b of bots) {
  b.stats.bytes = 0;
  b.stats.messages = 0;
  b.stats.snaps = 0;
  b.stats.corrections = [];
}
const start = Date.now();
let k = 0;
const timer = setInterval(() => {
  k++;
  bots.forEach((b, i) => b.drive({ throttle: 1, steer: Math.sin(k / 25 + i) * 0.35, brake: k % 200 > 185 ? 1 : 0 }));
}, 50);
await new Promise((r) => setTimeout(r, seconds * 1000));
clearInterval(timer);
const elapsed = (Date.now() - start) / 1000;
const world = await host('/api/host/world');
const bytes = bots.map((b) => b.stats.bytes / elapsed);
const corr = bots.flatMap((b) => b.stats.corrections);
const report = {
  bots: N,
  seconds: Math.round(elapsed),
  rooms: new Set(bots.map((b) => b.roomId)).size,
  disconnected: bots.filter((b) => b.closed).length,
  downstreamKBps: { avg: +(bytes.reduce((a, b) => a + b, 0) / bytes.length / 1024).toFixed(1), max: +(Math.max(...bytes) / 1024).toFixed(1) },
  snapHz: +(bots.reduce((a, b) => a + b.stats.snaps, 0) / bots.length / elapsed).toFixed(1),
  correctionM: { p50: +percentile(corr, 0.5).toFixed(3), p95: +percentile(corr, 0.95).toFixed(3) },
  server: { tick: world.tick, tickHz: world.tickHz, tickP99Ms: world.tickP99Ms, cars: world.cars?.length, traffic: world.trafficCount },
};
console.log(JSON.stringify(report, null, 2));
for (const b of bots) b.close();
process.exit(0);
