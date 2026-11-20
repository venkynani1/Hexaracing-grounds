import { SPAWN_DE, createTestNetwork, deHeading, spawnSlots } from '../sim/road';
import type { WorldMap } from './types';

let cached: WorldMap | null = null;

/** Synthetic 4×4 grid used by unit tests and as a fallback. Not Chennai; never shown as real geography. */
export function testMap(): WorldMap {
  if (cached) return cached;
  const net = createTestNetwork();
  const dest = net.nodes[15]!;
  const spawn = spawnSlots(net, 30, SPAWN_DE);
  cached = {
    id: 'test',
    version: net.version,
    net,
    scale: 1,
    anchor: { lat: 0, lon: 0, name: 'Test grid origin', osm: 'synthetic' },
    attribution: 'Synthetic test grid',
    source: 'synthetic',
    verifiedAt: null,
    destination: { name: 'Test destination', osm: 'synthetic', lat: 0, lon: 0, x: dest.x, z: dest.z, node: 15 },
    starts: [
      {
        code: 'test_grid',
        name: 'Test Grid',
        osm: 'synthetic',
        lat: null,
        lon: null,
        x: spawn[0]!.x,
        z: spawn[0]!.z,
        node: 1,
        verified: true,
        spawn: spawn.map((s) => ({ x: s.x, z: s.z, heading: deHeading(net, SPAWN_DE) })),
      },
    ],
    waypoints: [
      { id: 'north_gate', label: 'North Gate', node: 13 },
      { id: 'east_flyover', label: 'East Flyover', node: 11 },
      { id: 'central_junction', label: 'Central Junction', node: 5 },
      { id: 'south_market', label: 'South Market', node: 2 },
      { id: 'west_depot', label: 'West Depot', node: 4 },
    ],
    courses: {},
    maxSquadsPerStart: 30,
  };
  return cached;
}
