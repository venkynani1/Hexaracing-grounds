import type { Executor } from './client';
import { startLocations, vehicles } from './schema';

/**
 * Vehicle catalogue. Stats are provisional feel parameters; M2/M5 balance them by simulation so that
 * reference route times are within ±2% (DESIGN §8). They must never change the score ceiling.
 */
export const VEHICLE_CATALOGUE = [
  { code: 'vortex_gt', name: 'Vortex GT', stats: { archetype: 'balanced', accel: 3, handling: 3, durability: 3 } },
  { code: 'thunder_rs', name: 'Thunder RS', stats: { archetype: 'acceleration', accel: 4, handling: 2, durability: 3 } },
  { code: 'phantom_x', name: 'Phantom X', stats: { archetype: 'handling', accel: 3, handling: 4, durability: 2 } },
  { code: 'titan_xr', name: 'Titan XR', stats: { archetype: 'durability', accel: 2, handling: 3, durability: 4 } },
] as const;

/**
 * Candidate start areas (SPEC 2.1). Coordinates are intentionally NOT filled in and every location is
 * disabled until verified against licensed map data in M5 (lat/lon, route, radius) — see verified_at.
 */
export const START_LOCATION_CANDIDATES = [
  { code: 'chennai_central', name: 'Chennai Central' },
  { code: 'guindy', name: 'Guindy' },
  { code: 'velachery', name: 'Velachery' },
  { code: 'tambaram', name: 'Tambaram' },
  { code: 'thiruvanmiyur', name: 'Thiruvanmiyur' },
  { code: 'kelambakkam', name: 'Kelambakkam' },
  { code: 'mahabalipuram', name: 'Mahabalipuram' },
] as const;

/** Idempotent catalogue seed. */
export async function seedCatalogue(db: Executor): Promise<void> {
  await db
    .insert(vehicles)
    .values(VEHICLE_CATALOGUE.map((v) => ({ code: v.code, name: v.name, stats: v.stats })))
    .onConflictDoNothing({ target: vehicles.code });
  await db
    .insert(startLocations)
    .values(START_LOCATION_CANDIDATES.map((s) => ({ code: s.code, name: s.name, enabled: false })))
    .onConflictDoNothing({ target: startLocations.code });
}
