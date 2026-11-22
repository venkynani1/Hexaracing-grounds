import { BALANCE } from '@redline/shared';

export interface ServerConfig {
  port: number;
  host: string;
  databaseUrl: string | undefined;
  /** PGlite data dir when DATABASE_URL is unset (dev only). undefined → in-memory. */
  pgliteDir: string | undefined;
  sessionSecret: string;
  hostAdminKey: string;
  publicWebOrigins: string[];
  eventSeed: string;
  eventName: string;
  joinAttemptsPerMinute: number;
  trustProxy: boolean;
  directorIntervalMs: number;
  countdownMs: number;
  releaseAtMs: number;
  trafficCount: number;
  /** Rehearsal/test only: allow POST /api/host/warp. Never enable on event day. */
  allowTimeWarp: boolean;
  /** 'chennai' (OSM-derived, default) or 'test' (synthetic grid for unit tests). */
  map: 'chennai' | 'test';
}

/** Dev/test default — public in the repository, so never valid for a production event. */
export const PUBLIC_DEFAULT_SEED = '20261119';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const sessionSecret = env.SESSION_SECRET ?? (production ? '' : 'dev-only-session-secret-change-me');
  const hostAdminKey = env.HOST_ADMIN_KEY ?? (production ? '' : 'dev-host-key');
  if (production) {
    if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be set (>= 32 chars) in production');
    if (hostAdminKey.length < 12) throw new Error('HOST_ADMIN_KEY must be set (>= 12 chars) in production');
    // Embedded PGlite in production only with an explicit, logged opt-in (phone/test deployments). Data lives in
    // PGLITE_DIR (put it on a persistent volume) and is lost if that disk is. Never for the real event.
    // The event seed drives every secret answer; the default is public in the source code.
    if (!env.EVENT_SEED || env.EVENT_SEED === PUBLIC_DEFAULT_SEED || env.EVENT_SEED.replace(/\D/g, '').length < 8)
      throw new Error('EVENT_SEED must be set in production (>= 8 digits, not the public default)');
    if (!env.DATABASE_URL && env.ALLOW_EMBEDDED_DB !== 'true') throw new Error('DATABASE_URL must be set in production (or ALLOW_EMBEDDED_DB=true for a test deployment)');
  }
  return {
    port: Number(env.PORT ?? 2567),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDir: env.PGLITE_DIR || undefined,
    sessionSecret,
    hostAdminKey,
    publicWebOrigins: (env.PUBLIC_WEB_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    eventSeed: env.EVENT_SEED ?? PUBLIC_DEFAULT_SEED,
    eventName: env.EVENT_NAME ?? 'CODE REDLINE: ROAD TO HEXAWARE',
    joinAttemptsPerMinute: Number(env.JOIN_RATE_LIMIT ?? BALANCE.joinAttemptsPerMinute),
    trustProxy: env.TRUST_PROXY === 'true',
    directorIntervalMs: 250,
    countdownMs: Number(env.COUNTDOWN_MS ?? BALANCE.countdownMs),
    releaseAtMs: Number(env.RELEASE_AT_MS ?? BALANCE.releaseAtMs),
    trafficCount: Number(env.TRAFFIC_AGENTS ?? (env.MAP === 'test' ? BALANCE.trafficAgents : BALANCE.trafficAgentsChennai)),
    allowTimeWarp: env.ALLOW_TIME_WARP === 'true',
    map: env.MAP === 'test' ? 'test' : 'chennai',
  };
}
