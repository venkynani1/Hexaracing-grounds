import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { connectPglite, seedCatalogue, startLocations, vehicles } from '../src';

describe('db migrations', () => {
  it('apply cleanly to an empty Postgres (PGlite) and create all DESIGN §6 tables', async () => {
    const h = await connectPglite();
    const res = await h.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    const rows = (res as unknown as { rows: { table_name: string }[] }).rows;
    const names = rows.map((r) => r.table_name);
    for (const t of [
      'events', 'teams', 'players', 'sessions', 'vehicles', 'car_selections', 'start_locations', 'world_metadata',
      'road_segments', 'challenges', 'challenge_clues', 'challenge_submissions', 'bluff_rounds', 'bluff_entries',
      'bluff_votes', 'fuel_transactions', 'pit_stops', 'vehicle_checkpoints', 'scoring_events', 'event_states',
      'recovery_snapshots', 'offer_letters', 'audit_logs',
    ]) {
      expect(names).toContain(t);
    }
    expect(await h.ping()).toBe(true);
    await h.close();
  });

  it('seeds the catalogue idempotently; start locations stay disabled until verified', async () => {
    const h = await connectPglite();
    await seedCatalogue(h.db);
    await seedCatalogue(h.db);
    expect(await h.db.select().from(vehicles)).toHaveLength(4);
    const locs = await h.db.select().from(startLocations);
    expect(locs).toHaveLength(7);
    expect(locs.every((l) => !l.enabled && l.verifiedAt === null)).toBe(true);
    await h.close();
  });
});
