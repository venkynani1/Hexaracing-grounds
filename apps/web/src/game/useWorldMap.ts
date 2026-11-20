import { useEffect, useState } from 'react';
import { testMap, type WorldMap } from '@redline/shared';

/** Load the map the server announced. Chennai (~0.9 MB of ODbL-derived data) is a lazy chunk. */
export function useWorldMap(id: 'test' | 'chennai' | undefined): WorldMap | null {
  const [map, setMap] = useState<WorldMap | null>(id === 'test' ? testMap() : null);
  useEffect(() => {
    let alive = true;
    if (id === 'test') setMap(testMap());
    else if (id === 'chennai') void import('@redline/shared/map/chennai').then((m) => alive && setMap(m.chennaiMap()));
    return () => {
      alive = false;
    };
  }, [id]);
  return map;
}
