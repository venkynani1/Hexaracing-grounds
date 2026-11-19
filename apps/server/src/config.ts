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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const sessionSecret = env.SESSION_SECRET ?? (production ? '' : 'dev-only-session-secret-change-me');
  const hostAdminKey = env.HOST_ADMIN_KEY ?? (production ? '' : 'dev-host-key');
  if (production) {
    if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be set (>= 32 chars) in production');
    if (hostAdminKey.length < 12) throw new Error('HOST_ADMIN_KEY must be set (>= 12 chars) in production');
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL must be set in production');
  }
  return {
    port: Number(env.PORT ?? 2567),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDir: env.PGLITE_DIR || undefined,
    sessionSecret,
    hostAdminKey,
    publicWebOrigins: (env.PUBLIC_WEB_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    eventSeed: env.EVENT_SEED ?? '20261119',
    eventName: env.EVENT_NAME ?? 'CODE REDLINE: ROAD TO HEXAWARE',
    joinAttemptsPerMinute: Number(env.JOIN_RATE_LIMIT ?? BALANCE.joinAttemptsPerMinute),
    trustProxy: env.TRUST_PROXY === 'true',
    directorIntervalMs: 250,
    countdownMs: Number(env.COUNTDOWN_MS ?? BALANCE.countdownMs),
    releaseAtMs: Number(env.RELEASE_AT_MS ?? BALANCE.releaseAtMs),
    trafficCount: Number(env.TRAFFIC_AGENTS ?? BALANCE.trafficAgents),
  };
}
