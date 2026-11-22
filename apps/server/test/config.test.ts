import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const prod = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), HOST_ADMIN_KEY: 'k'.repeat(16), EVENT_SEED: '8812734409126' };

describe('production config guards', () => {
  it('refuses to start without DATABASE_URL', () => {
    expect(() => loadConfig({ ...prod })).toThrow(/DATABASE_URL must be set/);
  });
  it('allows embedded PGlite only with the explicit ALLOW_EMBEDDED_DB=true opt-in', () => {
    const c = loadConfig({ ...prod, ALLOW_EMBEDDED_DB: 'true', PGLITE_DIR: '/data/pglite' });
    expect(c.databaseUrl).toBeUndefined();
    expect(c.pgliteDir).toBe('/data/pglite');
    expect(() => loadConfig({ ...prod, ALLOW_EMBEDDED_DB: '1' })).toThrow(/DATABASE_URL/);
  });
  it('requires a private EVENT_SEED (answers derive from it; the default is public in the repo)', () => {
    const base = { ...prod, ALLOW_EMBEDDED_DB: 'true' };
    expect(() => loadConfig({ ...base, EVENT_SEED: undefined })).toThrow(/EVENT_SEED/);
    expect(() => loadConfig({ ...base, EVENT_SEED: '20261119' })).toThrow(/EVENT_SEED/);
    expect(() => loadConfig({ ...base, EVENT_SEED: '1234' })).toThrow(/EVENT_SEED/);
    expect(loadConfig(base).eventSeed).toBe('8812734409126');
  });
  it('still requires strong secrets with the opt-in', () => {
    expect(() => loadConfig({ ...prod, SESSION_SECRET: 'short', ALLOW_EMBEDDED_DB: 'true' })).toThrow(/SESSION_SECRET/);
  });
});
