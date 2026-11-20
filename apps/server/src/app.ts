import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { WebSocketServer, type WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { eq as eqOp } from 'drizzle-orm';
import { events, seedCatalogue, startLocations, worldMetadata, type DbHandle } from '@redline/db';
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
  const sim = new WorldSim({ seed: String(event.seed), trafficCount: config.trafficCount, map });
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
  if (clock.started) {
    await room.spawnCars();
    await squad.activate([...sim.cars.keys()]);
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
  app.get('/api/event', async () => ({ eventName: room.eventName, clock: room.clockState(), registrationOpen: room.registrationOpen(), map: map.id }));

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
  app.post('/api/squad/bluff/:id/vote', async (req) => squad.bluffVote(await actor(req), param(req, 'id'), body(req).choiceId));

  /* ---------- host ---------- */
  app.get('/api/host/overview', { preHandler: requireHost }, async () => room.overview());
  app.post('/api/host/start', { preHandler: requireHost }, async (req) => {
    const force = ((req.body ?? {}) as { force?: unknown }).force === true;
    return { clock: await room.start({ force }) };
  });
  app.get('/api/host/world', { preHandler: requireHost }, async () => room.worldStatus());
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
          await room.broadcastRoster(s.tid);
        } else if (msg.t === 'host_hello') {
          if (typeof msg.hostKey !== 'string' || !safeEqual(msg.hostKey, config.hostAdminKey)) {
            send(ws, { t: 'error', error: 'UNAUTHORIZED', message: 'Host key required' });
            return ws.close(4003, 'unauthorized');
          }
          room.bindHost(ws);
          clearTimeout(helloTimeout);
          send(ws, { t: 'welcome', kind: 'host', roomId: room.roomId, overview: await room.overview() });
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
