/**
 * Chennai map — derived from OpenStreetMap data, © OpenStreetMap contributors, ODbL 1.0
 * (see packages/shared/src/map/CHENNAI_DATA_LICENSE.md). Separate entry point so the lobby bundle never loads it.
 */
import data from './chennai.map.json';
import places from './chennai.places.json';
import { AreaIndex, type PlacesJson } from './areas';
import { decodeMap, type MapJson, type WorldMap } from './types';

let cached: WorldMap | null = null;
export function chennaiMap(): WorldMap {
  if (cached) return cached;
  const m = decodeMap(data as unknown as MapJson);
  const p = places as unknown as PlacesJson;
  // area names/signs are only valid for the graph they were generated from
  if (p.mapVersion === m.version) {
    m.areas = new AreaIndex(p.areas);
    m.signs = p.signs;
  }
  return (cached = m);
}
