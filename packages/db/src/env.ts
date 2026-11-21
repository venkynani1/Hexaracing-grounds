import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Local development only: load the repo-root `.env.local` written by `neon deploy` / `neon env pull`
 * (DATABASE_URL = pooled, DATABASE_URL_UNPOOLED = direct). Variables already set in the environment win; production
 * (NODE_ENV=production, Fly secrets) never reads a file. `.env.local` is gitignored.
 */
export function loadLocalEnv(): void {
  if (process.env.NODE_ENV === 'production') return;
  const file = fileURLToPath(new URL('../../../.env.local', import.meta.url));
  if (existsSync(file)) process.loadEnvFile(file);
}
