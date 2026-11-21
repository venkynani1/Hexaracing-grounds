import { connectPglite, connectPostgres, loadLocalEnv } from '@redline/db';
import { buildServer } from './app';
import { loadConfig } from './config';

loadLocalEnv(); // dev: DATABASE_URL from .env.local (neon env pull); production uses Fly secrets
const config = loadConfig();
const db = config.databaseUrl
  ? await connectPostgres(config.databaseUrl, { migrate: true, migrationUrl: process.env.DATABASE_URL_UNPOOLED || undefined })
  : await connectPglite(config.pgliteDir, { migrate: true });
if (!config.databaseUrl) console.warn(`[server] DATABASE_URL not set — using embedded PGlite (${config.pgliteDir ?? 'in-memory'}). Dev/test deployments only — NOT for the event.`);

console.log(`[server] database: ${db.kind === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : 'embedded PGlite'}`);
const server = await buildServer({ config, db });
const url = await server.listen();
console.log(`[server] CODE REDLINE world ${server.room.roomId} (event ${server.eventId}) listening on ${url}`);

const shutdown = async (sig: string) => {
  console.log(`[server] ${sig} — shutting down`);
  await server.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
