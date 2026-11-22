import { describe, expect, it } from 'vitest';
import { AreaIndex, nearestEdge, roadLabel } from '../src';
import { chennaiMap } from '../src/map/chennai';

describe('Chennai area names + route signs (OSM place nodes)', () => {
  const map = chennaiMap();

  it('attaches areas and signs generated for this exact graph version', () => {
    expect(map.areas).toBeDefined();
    expect(map.areas!.areas.length).toBeGreaterThan(100);
    expect(map.signs!.length).toBeGreaterThan(100);
  });

  it('names real places at known locations', () => {
    const at = (code: string) => {
      const s = map.starts.find((x) => x.code === code)!;
      return map.areas!.at(s.x, s.z)?.name;
    };
    expect(at('guindy')).toMatch(/Guindy|Little Mount|Alandur|Raj Bhavan/);
    expect(at('tambaram')).toMatch(/Tambaram/);
    expect(at('thiruvanmiyur')).toMatch(/Thiruvanmiyur|Kamraj/i);
    expect(map.areas!.at(map.destination.x, map.destination.z)?.name).toMatch(/Siruseri|Kazhipattur|Padur|Navalur/);
  });

  it('every course has place boards and a direction sign per checkpoint, all off the carriageway', () => {
    for (const [id, c] of Object.entries(map.courses)) {
      const signs = map.signs!.filter((s) => s.course === id);
      expect(signs.filter((s) => s.kind === 'place').length, id).toBeGreaterThanOrEqual(5);
      expect(signs.filter((s) => s.kind === 'direction').length, id).toBeGreaterThanOrEqual(c.checkpoints.length - 1);
      for (const s of signs) expect(nearestEdge(map.net, s.x, s.z, 60).clearance, `${id} ${s.title}`).toBeGreaterThan(1.5);
      // direction distances count down along the course
      const km = signs.filter((s) => s.kind === 'direction').map((s) => Number(/(\d+) km/.exec(s.title)?.[1] ?? 0));
      for (let i = 1; i < km.length; i++) expect(km[i]!).toBeLessThanOrEqual(km[i - 1]!);
    }
  });

  it('index lookup picks the closest relative place and returns null far from any', () => {
    const idx = new AreaIndex([
      { name: 'A', kind: 'suburb', x: 0, z: 0, r: 1000 },
      { name: 'B', kind: 'neighbourhood', x: 800, z: 0, r: 400 },
    ]);
    expect(idx.at(100, 0)?.name).toBe('A');
    expect(idx.at(790, 0)?.name).toBe('B');
    expect(idx.at(5000, 5000)).toBeNull();
    expect(roadLabel('Rajiv Gandhi Salai')).toMatch(/^OMR/);
    expect(roadLabel(undefined)).toBeNull();
  });
});
