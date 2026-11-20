/**
 * Chennai map — derived from OpenStreetMap data, © OpenStreetMap contributors, ODbL 1.0
 * (see packages/shared/src/map/CHENNAI_DATA_LICENSE.md). Separate entry point so the lobby bundle never loads it.
 */
import data from './chennai.map.json';
import { decodeMap, type MapJson, type WorldMap } from './types';

let cached: WorldMap | null = null;
export function chennaiMap(): WorldMap {
  return (cached ??= decodeMap(data as unknown as MapJson));
}
