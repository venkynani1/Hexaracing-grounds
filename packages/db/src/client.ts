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

/** Neon / any Postgres via a pooled connection. Use the Neon *pooler* URL in production. */
export async function connectPostgres(url: string, opts: { migrate?: boolean; max?: number } = {}): Promise<DbHandle> {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10 });
  const db = drizzlePg(pool, { schema }) as unknown as Db;
  if (opts.migrate) await migratePg(drizzlePg(pool, { schema }), { migrationsFolder: MIGRATIONS_DIR });
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
