import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export interface DbHandle {
  db: Db;
  kind: 'postgres' | 'pglite';
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Neon / any Postgres. Runtime traffic uses the Neon *pooler* URL (`-pooler` host, `sslmode=require`); migrations can use
 * the direct (unpooled) URL via `migrationUrl` (DDL + migration bookkeeping outside PgBouncer transaction mode).
 * Neon autosuspend / pooler restarts close idle connections: the pool drops them (`error` handler — without it Node
 * crashes on an idle-client error), recycles idle clients before Neon's 5-min suspend, and reconnects on next use.
 */
export async function connectPostgres(url: string, opts: { migrate?: boolean; max?: number; migrationUrl?: string } = {}): Promise<DbHandle> {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 15_000, // a suspended Neon compute takes ~0.5–2 s to wake
    keepAlive: true,
  });
  pool.on('error', (err) => console.warn(`[db] idle connection dropped (${(err as Error).message}) — will reconnect on next query`));
  const db = drizzlePg(pool, { schema }) as unknown as Db;
  if (opts.migrate) {
    const mp = opts.migrationUrl ? new pg.Pool({ connectionString: opts.migrationUrl, max: 1, connectionTimeoutMillis: 15_000 }) : pool;
    if (mp !== pool) mp.on('error', () => undefined);
    try {
      await migratePg(drizzlePg(mp, { schema }), { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      if (mp !== pool) await mp.end();
    }
  }
  return {
    db,
    kind: 'postgres',
    ping: async () => {
      try {
        await pool.query('select 1');
        return true;
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
  };
}

/** Embedded Postgres (PGlite) — tests and local dev without Neon. `dataDir` undefined = in-memory. */
export async function connectPglite(dataDir?: string, opts: { migrate?: boolean } = { migrate: true }): Promise<DbHandle> {
  const client = new PGlite(dataDir);
  const d = drizzlePglite(client, { schema });
  if (opts.migrate !== false) await migratePglite(d, { migrationsFolder: MIGRATIONS_DIR });
  return {
    db: d as unknown as Db,
    kind: 'pglite',
    ping: async () => {
      try {
        await client.query('select 1');
        return true;
      } catch {
        return false;
      }
    },
    close: () => client.close(),
  };
}
