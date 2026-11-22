import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { WebSocketServer, type WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { eq as eqOp } from 'drizzle-orm';
import { events, recoverySnapshots, seedCatalogue, startLocations, worldMetadata, type DbHandle } from '@redline/db';
import { desc as descOp } from 'drizzle-orm';
import { testMap, type StartLocationInfo, type WorldMap } from '@redline/shared';
import { chennaiMap } from '@redline/shared/map/chennai';
import type { ClientMessage, ServerMessage } from '@redline/shared';
import type { ServerConfig } from './config';
import { TokenSigner, safeEqual } from './auth/tokens';
import { ApiError, unauthorized } from './http/errors';
import { RateLimiter } from './http/rateLimit';
import { RegistrationService } from './services/registration';
import { WorldRoom, clockFromEventRow } from './world/WorldRoom';
import { WorldSim } from './world/WorldSim';
import { SquadService, type Actor } from './squad/SquadService';
import { PitService } from './pit/PitService';
import { Director } from './director/Director';
import { GateService } from './gate/GateService';
import { RivalService } from './rival/RivalService';
import { computeStandings } from './gate/championship';
import { buildOfferLetterPdf } from './gate/letters';
import { offerLetters, players as playersT, teams as teamsT } from '@redline/db';
import { VEHICLES, ROLE_LABEL, hash32 } from '@redline/shared';
import { audit } from './services/audit';

export interface BuiltServer {
  app: FastifyInstance;
  room: WorldRoom;
  registration: RegistrationService;
  eventId: string;
  /** Listen on config.port (0 = random). Returns the base URL. */
  listen(port?: number): Promise<string>;
  close(): Promise<void>;
}

export interface BuildOptions {
  config: ServerConfig;
  db: DbHandle;
  now?: () => number;
  /** Start the Director interval loop (disable in unit tests that drive tick() manually). */
  runDirector?: boolean;
}

/** Load the configured event, or create it on first boot. One process = one event = one WorldRoom. */
/**
 * Mirror the map's verified start locations and world metadata into Postgres. A location is enabled only when
 * the map build verified it (coordinates matched to OSM + route to Hexaware); everything else is disabled.
 */
async function syncMapToDb(db: DbHandle, eventId: string, map: WorldMap) {
  const verifiedAt = map.verifiedAt ? new Date(map.verifiedAt) : new Date();
  const all = await db.db.select().from(startLocations);
  for (const st of map.starts) {
    const values = {
      name: st.name,
      lat: st.lat,
      lon: st.lon,
      worldX: st.x,
      worldZ: st.z,
      enabled: st.verified,
      verifiedAt: st.verified ? verifiedAt : null,
      maxSquads: map.maxSquadsPerStart,
    };
    await db.db.insert(startLocations).values({ code: st.code, ...values }).onConflictDoUpdate({ target: startLocations.code, set: values });
  }
  for (const row of all) if (!map.starts.some((st) => st.code === row.code)) await db.db.update(startLocations).set({ enabled: false }).where(eqOp(startLocations.id, row.id));
  const [meta] = await db.db.select().from(worldMetadata).where(eqOp(worldMetadata.eventId, eventId)).limit(1);
  const metaValues = { anchorLat: map.anchor.lat, anchorLon: map.anchor.lon, worldScale: map.scale, mapVersion: map.version, osmAttribution: map.attribution };
  if (meta) await db.db.update(worldMetadata).set(metaValues).where(eqOp(worldMetadata.id, meta.id));
  else await db.db.insert(worldMetadata).values({ eventId, ...metaValues });
}

async function loadOrCreateEvent(db: DbHandle, config: ServerConfig) {
  const [existing] = await db.db.select().from(events).where(eq(events.name, config.eventName)).limit(1);
  if (existing) return existing;
  const [created] = await db.db
    .insert(events)
    .values({ name: config.eventName, seed: BigInt(config.eventSeed.replace(/\D/g, '') || '0'), status: 'REGISTRATION_OPEN' })
    .returning();
  return created!;
}

export async function buildServer(opts: BuildOptions): Promise<BuiltServer> {
  const { config, db } = opts;
  const now = opts.now ?? Date.now;
  await seedCatalogue(db.db);
  const event = await loadOrCreateEvent(db, config);
  const { clock, autoPaused } = clockFromEventRow(event, now(), config.countdownMs);
  const map: WorldMap = config.map === 'test' ? testMap() : chennaiMap();
  await syncMapToDb(db, event.id, map);
  // SECURITY: the event seed drives secret content (answer variants, Director, bluff order) and never leaves the
  // server. Clients get a one-way derived WORLD seed for visuals, signals and traffic only.
  const worldSeed = `w${hash32(`${String(event.seed)}:world:${config.sessionSecret}`).toString(16)}`;
  const sim = new WorldSim({ seed: worldSeed, trafficCount: config.trafficCount, map });
  const warm = sim.prewarm();
  const jitMs = map.id !== 'test' ? WorldSim.warmJit(map) : 0;
  if (map.id !== 'test') console.log(`[server] prewarmed ${warm.cells} corridor cells in ${warm.ms} ms; JIT warm-up ${jitMs} ms`);
  const room = WorldRoom.create({ eventId: event.id, eventName: event.name, clock, db, now, sim, releaseAtMs: config.releaseAtMs });
  const signer = new TokenSigner(config.sessionSecret);
  const registration = new RegistrationService(db.db, signer, event.id, room.registrationOpen, now);
  room.attachRegistration(registration);
  const squad = new SquadService(
    db.db,
    event.id,
    String(event.seed),
    sim,
    () => {
      const t = now();
      return { live: clock.status(t) === 'LIVE', elapsedMs: clock.elapsedMs(t), started: clock.started };
    },
    config.sessionSecret,
  );
  room.attachSquad(squad);
  const director = new Director(String(event.seed), sim, squad, (state) => room.broadcastWorldState(state));
  room.attachDirector(director);
  const pit = new PitService(db.db, String(event.seed), sim, squad, () => clock.elapsedMs(now()), () => director.state.fuelPriceMul);
  squad.pitView = (teamId, role) => pit.viewFor(teamId, role);
  room.attachPit(pit);
  const gate = new GateService(db.db, event.id, String(event.seed), sim, squad, () => clock.elapsedMs(now()), now);
  squad.gateView = (teamId, role) => gate.viewFor(teamId, role);
  room.attachGate(gate);
  const rival = new RivalService(db.db, event.id, String(event.seed), sim, squad, () => clock.elapsedMs(now()));
  squad.rivalView = (teamId, role) => rival.viewFor(teamId, role);
  room.attachRival(rival);
  if (clock.started) {
    // Crash recovery: restore the newest snapshot (PAUSED for the host), else fall back to a fresh spawn.
    const [latest] = await db.db
      .select()
      .from(recoverySnapshots)
      .where(eqOp(recoverySnapshots.eventId, event.id))
      .orderBy(descOp(recoverySnapshots.createdAt))
      .limit(1);
    if (latest) {
      await room.restoreFrom(latest.state as Parameters<WorldRoom['restoreFrom']>[0]);
      await audit(db.db, event.id, 'system', null, 'event.recovered_from_snapshot', { tick: latest.tick, snapshotId: latest.id });
    } else {
      await room.spawnCars();
      await squad.activate([...sim.cars.keys()]);
      gate.activate([...sim.cars.keys()]);
    }
  }
  if (autoPaused) await audit(db.db, event.id, 'system', null, 'event.recovered_paused', { at: now() });

  const app = Fastify({ logger: false, trustProxy: config.trustProxy, bodyLimit: 16 * 1024 });
  await app.register(cors, { origin: config.publicWebOrigins, methods: ['GET', 'POST'] });

  const joinLimiter = new RateLimiter(config.joinAttemptsPerMinute, 60_000, now);
  const ipHash = (req: FastifyRequest) => createHash('sha256').update(`${config.sessionSecret}:${req.ip}`).digest('hex').slice(0, 16);
  const meta = (req: FastifyRequest) => ({ userAgent: req.headers['user-agent'], ipHash: ipHash(req) });

  const limitJoin = async (req: FastifyRequest, reply: FastifyReply) => {
    const wait = joinLimiter.hit(`join:${req.ip}`);
    if (wait > 0) {
      reply.header('retry-after', Math.ceil(wait / 1000));
      throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts, wait a moment and try again');
    }
  };
  const requireHost = async (req: FastifyRequest) => {
    const key = req.headers['x-host-key'];
    if (typeof key !== 'string' || !key || !safeEqual(key, config.hostAdminKey)) throw unauthorized('Host key required');
  };
  const requirePlayer = async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    if (!token) throw unauthorized();
    return registration.authenticate(token);
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: err.code, message: err.message });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: 'BAD_REQUEST', message: e.message });
    console.error('[http]', err);
    return reply.status(500).send({ error: 'INTERNAL', message: 'Internal error' });
  });

  /* ---------- public ---------- */
  app.get('/api/health', async () => ({ ok: true, db: await db.ping(), roomId: room.roomId, clients: room.clients.size }));
  app.get('/api/event', async () => ({ eventName: room.eventName, clock: room.clockState(), registrationOpen: room.registrationOpen(), map: map.id, worldSeed }));

  /* ---------- registration ---------- */
  app.post('/api/squads', { preHandler: limitJoin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const res = await registration.createSquad({ squadName: body.squadName, displayName: body.displayName }, meta(req));
    room.scheduleOverview();
    return reply.status(201).send(res);
  });
  app.get('/api/squads/:code', { preHandler: limitJoin }, async (req) => registration.previewSquad((req.params as { code: string }).code));
  app.post('/api/squads/join', { preHandler: limitJoin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const res = await registration.joinSquad({ code: body.code, displayName: body.displayName, role: body.role }, meta(req));
    await room.broadcastRoster(res.teamId);
    return reply.status(201).send(res);
  });
  app.post('/api/session/rejoin', { preHandler: limitJoin }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return registration.rejoin(body.rejoinToken, meta(req));
  });
  app.get('/api/me', async (req) => {
    const s = await requirePlayer(req);
    const team = await registration.getTeam(s.tid);
    return { playerId: s.pid, role: s.player.role, slot: s.player.slot, roster: room.toRoster(team!), clock: room.clockState() };
  });
  app.post('/api/team/roles', async (req) => {
    const s = await requirePlayer(req);
    await registration.assignRoles(s.pid, ((req.body ?? {}) as { assignments?: unknown }).assignments);
    await room.broadcastRoster(s.tid);
    const team = await registration.getTeam(s.tid);
    return { roster: room.toRoster(team!) };
  });

  /* ---------- start locations (M5) ---------- */
  app.get('/api/start-locations', async (): Promise<StartLocationInfo[]> => {
    const usage = await registration.startLocationUsage();
    return map.starts.map((st) => {
      const taken = usage.get(st.code) ?? 0;
      const course = map.courses[st.code];
      return {
        code: st.code,
        name: st.name,
        verified: st.verified,
        selectable: st.verified && taken < map.maxSquadsPerStart && room.registrationOpen(),
        taken,
        capacity: map.maxSquadsPerStart,
        reason: st.reason,
        via: course?.via ?? [],
        courseKm: course ? Math.round(course.lengthM / 100) / 10 : 0,
      };
    });
  });
  app.post('/api/team/start-location', async (req) => {
    const s = await requirePlayer(req);
    await registration.setStartLocation(s.pid, ((req.body ?? {}) as { code?: unknown }).code);
    await room.broadcastRoster(s.tid);
    return { ok: true };
  });

  /* ---------- squad mechanics (M4) — role checks happen in SquadService ---------- */
  const actionLimiter = new RateLimiter(120, 60_000, now);
  const actor = async (req: FastifyRequest): Promise<Actor> => {
    const s = await requirePlayer(req);
    if (actionLimiter.hit(`act:${s.pid}`) > 0) throw new ApiError(429, 'RATE_LIMITED', 'Slow down');
    return { playerId: s.pid, teamId: s.tid, role: s.player.role };
  };
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
  const param = (req: FastifyRequest, k: string) => String((req.params as Record<string, string>)[k]);
  app.get('/api/squad/view', async (req) => {
    const a = await actor(req);
    return squad.viewFor(a.teamId, a.role, a.playerId);
  });
  app.post('/api/squad/coding/:qid', async (req) => squad.answerCoding(await actor(req), param(req, 'qid'), body(req).answer, body(req).idempotencyKey));
  app.post('/api/squad/fourkey/:id', async (req) => squad.submitFourKey(await actor(req), param(req, 'id'), body(req).answer, body(req).idempotencyKey));
  app.post('/api/squad/navigation/:id', async (req) => squad.answerNavigation(await actor(req), param(req, 'id'), body(req).answer, body(req).idempotencyKey));
  app.post('/api/squad/waypoint', async (req) => squad.setWaypoint(await actor(req), body(req).waypoint));
  app.post('/api/squad/powerup', async (req) => squad.deployPowerUp(await actor(req), body(req).kind));
  app.post('/api/squad/bluff/:id/entry', async (req) => squad.bluffEntry(await actor(req), param(req, 'id'), body(req).text));
  app.post('/api/squad/pit/plan', async (req) => pit.plan(await actor(req), body(req)));
  app.post('/api/squad/pit/diagnose', async (req) => pit.diagnose(await actor(req), body(req).answer));
  app.post('/api/squad/pit/verify', async (req) => pit.verify(await actor(req), body(req).index));
  app.post('/api/squad/pit/confirm', async (req) => pit.confirm(await actor(req)));
  app.post('/api/squad/rival/duel', async (req) => rival.duelAnswer(await actor(req), body(req).answer, body(req).key));
  app.post('/api/squad/rival/offer', async (req) => rival.offer(await actor(req), body(req).give, body(req).want, body(req).key));
  app.post('/api/squad/rival/respond', async (req) => rival.respond(await actor(req), body(req).offerId, body(req).accept));
  app.post('/api/squad/rival/depot', async (req) => rival.depot(await actor(req), body(req).option));
  app.post('/api/squad/gate/escort', async (req) => gate.requestEscort(await actor(req)));
  app.post('/api/squad/gate/debug', async (req) => gate.debug(await actor(req), body(req).answer));
  app.post('/api/squad/gate/auth', async (req) => gate.auth(await actor(req), body(req).index));
  app.post('/api/squad/gate/code', async (req) => gate.code(await actor(req), body(req).code));
  app.post('/api/squad/bluff/:id/vote', async (req) => squad.bluffVote(await actor(req), param(req, 'id'), body(req).choiceId));

  /* ---------- championship + offer letters (M7) ---------- */
  // Live standings, always derived from scoring_events rows (final at 58:00).
  app.get('/api/standings', async () => ({
    final: !!gate.standings,
    standings: gate.standings ?? (await computeStandings(db.db, event.id, String(event.seed), (t) => sim.cars.get(t)?.arrival?.mode ?? null)),
  }));
  app.get('/api/offer-letter', async (req, reply) => {
    const s = await requirePlayer(req);
    const [row] = await db.db
      .select({ letter: offerLetters, player: playersT, team: teamsT })
      .from(offerLetters)
      .innerJoin(playersT, eq(offerLetters.playerId, playersT.id))
      .innerJoin(teamsT, eq(playersT.teamId, teamsT.id))
      .where(eq(offerLetters.playerId, s.pid));
    if (!row) throw new ApiError(404, 'NOT_READY', 'Offer letters are issued at the championship reveal (58:00)');
    const car = sim.cars.get(row.team.id);
    const pdf = await buildOfferLetterPdf({
      participant: row.player.displayName,
      team: row.team.name,
      role: ROLE_LABEL[row.player.role],
      vehicle: car?.params.name ?? VEHICLES.vortex_gt.name,
      achievement: row.letter.achievement,
      finalScore: row.letter.finalScore,
      arrivalStatus: row.letter.arrivalStatus,
      eventName: event.name,
      date: row.letter.generatedAt.toISOString().slice(0, 10),
    });
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="code-redline-letter.pdf"`).send(Buffer.from(pdf));
  });
  app.get('/api/host/offer-letters', { preHandler: requireHost }, async () =>
    db.db.select({ playerId: offerLetters.playerId, achievement: offerLetters.achievement, finalScore: offerLetters.finalScore, arrivalStatus: offerLetters.arrivalStatus }).from(offerLetters),
  );

  /* ---------- host ---------- */
  app.get('/api/host/overview', { preHandler: requireHost }, async () => room.overview());
  app.post('/api/host/start', { preHandler: requireHost }, async (req) => {
    const force = ((req.body ?? {}) as { force?: unknown }).force === true;
    return { clock: await room.start({ force }) };
  });
  app.get('/api/host/world', { preHandler: requireHost }, async () => ({ ...room.worldStatus(), process: processStats() }));
  app.post('/api/host/warp', { preHandler: requireHost }, async (req) => {
    if (!config.allowTimeWarp) throw new ApiError(403, 'WARP_DISABLED', 'Time warp is disabled (rehearsal/test only)');
    const to = Number(((req.body ?? {}) as { toElapsedMs?: unknown }).toElapsedMs);
    if (!Number.isFinite(to) || to < 0) throw new ApiError(400, 'BAD_REQUEST', 'toElapsedMs required');
    return { clock: await room.warp(to) };
  });
  app.post('/api/host/pause', { preHandler: requireHost }, async () => ({ clock: await room.pause() }));
  app.post('/api/host/resume', { preHandler: requireHost }, async () => ({ clock: await room.resume() }));

  /* ---------- WebSocket gateway ---------- */
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
  const originAllowed = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    return !origin || config.publicWebOrigins.includes(origin) || config.publicWebOrigins.includes('*');
  };
  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws' || !originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  const send = (ws: WebSocket, m: ServerMessage) => room.send(ws, m);

  function onConnection(ws: WebSocket) {
    room.clients.set(ws, { kind: 'pending', connectedAt: now() });
    const helloTimeout = setTimeout(() => {
      if (room.clients.get(ws)?.kind === 'pending') ws.close(4001, 'hello timeout');
    }, 10_000);
    // Abuse limits use real wall time, not the (injectable) game clock.
    let windowStart = Date.now();
    let msgCount = 0;
    ws.on('message', async (raw) => {
      // Per-connection message rate limit (low-rate JSON channel).
      const t = Date.now();
      if (t - windowStart > 1000) {
        windowStart = t;
        msgCount = 0;
      }
      // Racers send 20 inputs/s + pings; 60/s is the hard ceiling (DESIGN §4).
      if (++msgCount > 60) return ws.close(4008, 'rate limited');
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { t: 'error', error: 'BAD_MESSAGE', message: 'Invalid JSON' });
      }
      try {
        const ctx = room.clients.get(ws);
        if (msg.t === 'ping') return send(ws, { t: 'pong', clientTime: Number(msg.clientTime) || 0, serverTime: now() });
        if (msg.t === 'input') {
          room.handleInput(ws, msg);
          return;
        }
        if (msg.t === 'reset') {
          room.handleReset(ws);
          return;
        }
        if (ctx?.kind !== 'pending') return;
        if (msg.t === 'hello') {
          const s = await registration.authenticate(msg.sessionToken);
          room.bindPlayer(ws, s.pid, s.tid, s.player.role);
          clearTimeout(helloTimeout);
          const team = await registration.getTeam(s.tid);
          send(ws, {
            t: 'welcome',
            kind: 'player',
            playerId: s.pid,
            roomId: room.roomId,
            roster: room.toRoster(team!),
            clock: room.clockState(),
            world: { seed: sim.opts.seed, mapVersion: sim.net.version, map: map.id },
          });
          room.sendSquadTo(ws);
          room.sendWorldStateTo(ws);
          room.sendFinaleTo(ws);
          await room.broadcastRoster(s.tid);
        } else if (msg.t === 'host_hello') {
          if (typeof msg.hostKey !== 'string' || !safeEqual(msg.hostKey, config.hostAdminKey)) {
            send(ws, { t: 'error', error: 'UNAUTHORIZED', message: 'Host key required' });
            return ws.close(4003, 'unauthorized');
          }
          room.bindHost(ws);
          clearTimeout(helloTimeout);
          send(ws, { t: 'welcome', kind: 'host', roomId: room.roomId, overview: await room.overview() });
          room.sendWorldStateTo(ws);
          room.sendFinaleTo(ws);
        }
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(500, 'INTERNAL', 'Internal error');
        if (!(e instanceof ApiError)) console.error('[ws]', e);
        send(ws, { t: 'error', error: err.code, message: err.message });
        if (err.status === 401) ws.close(4001, 'unauthorized');
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimeout);
      const teamId = room.unbind(ws);
      if (teamId) void room.broadcastRoster(teamId).catch(() => {});
    });
    ws.on('error', () => {});
  }

  if (opts.runDirector !== false) room.startLoop(config.directorIntervalMs);

  return {
    app,
    room,
    registration,
    eventId: event.id,
    async listen(port = config.port) {
      await app.listen({ port, host: config.host });
      const addr = app.server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      return `http://127.0.0.1:${p}`;
    },
    async close() {
      room.dispose();
      for (const c of wss.clients) c.terminate();
      wss.close();
      await app.close();
    },
  };
}

/* Process metrics for /api/host/world (host-only): CPU % of one core since the previous call, memory, event-loop delay. */
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
let lastCpu = process.cpuUsage();
let lastAt = performance.now();
function processStats() {
  const now = performance.now();
  const cpu = process.cpuUsage(lastCpu);
  const wallMs = Math.max(1, now - lastAt);
  lastCpu = process.cpuUsage();
  lastAt = now;
  const m = process.memoryUsage();
  const out = {
    cpuPctOneCore: Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 1000) / 10,
    rssMB: Math.round(m.rss / 1048576),
    heapUsedMB: Math.round(m.heapUsed / 1048576),
    eventLoopDelayP99Ms: Math.round(loopDelay.percentile(99) / 1e4) / 100,
    eventLoopDelayMaxMs: Math.round(loopDelay.max / 1e4) / 100,
    uptimeS: Math.round(process.uptime()),
  };
  loopDelay.reset();
  return out;
}
