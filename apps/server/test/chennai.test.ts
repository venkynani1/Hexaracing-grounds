/**
 * M5 acceptance: Chennai geography (OSM-derived map, verified start locations, route normalisation).
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { performance } from 'node:perf_hooks';
import { startLocations, vehicleCheckpoints, worldMetadata } from '@redline/db';
import { BALANCE, NEUTRAL_INPUT, coursePolyline, driveReference, isOnRoad } from '@redline/shared';
import { chennaiMap } from '@redline/shared/map/chennai';
import { WorldSim } from '../src/world/WorldSim';
import { HOST_KEY, fullSquad, get, makeServer, post } from './helpers';

const map = chennaiMap();
const net = map.net;
const deFrom = (de: number) => (de & 1 ? net.edges[de >> 1]!.b : net.edges[de >> 1]!.a);
const deTo = (de: number) => (de & 1 ? net.edges[de >> 1]!.a : net.edges[de >> 1]!.b);
const haversineKm = (a: number, b: number, c: number, d: number) => {
  const R = 6371.0088;
  const r = Math.PI / 180;
  const h = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

describe('M5: map graph', () => {
  it('is a real OSM-derived Chennai graph with attribution', () => {
    expect(map.id).toBe('chennai');
    expect(net.nodes.length).toBeGreaterThan(10_000);
    expect(map.attribution).toMatch(/OpenStreetMap contributors/);
    expect(map.attribution).toMatch(/ODbL/);
    expect(map.anchor.osm).toBe('n6572344272'); // "Hexaware Technologies" office node in OSM
    expect(map.scale).toBeGreaterThan(0.5);
    expect(map.scale).toBeLessThanOrEqual(1);
  });

  it('every enabled start location has a path to Hexaware (graph search, one-way rules respected)', () => {
    const reach = (from: number) => {
      const seen = new Uint8Array(net.nodes.length);
      const q = [from];
      seen[from] = 1;
      while (q.length) {
        const v = q.pop()!;
        for (const de of net.out[v]!) {
          const w = deTo(de);
          if (!seen[w]) (seen[w] = 1), q.push(w);
        }
      }
      return seen;
    };
    const enabled = map.starts.filter((s) => s.verified);
    expect(enabled).toHaveLength(7);
    for (const s of enabled) expect(reach(s.node)[map.destination.node], s.code).toBe(1);
    // …and the convoy can come back out: destination reaches every start.
    const back = reach(map.destination.node);
    for (const s of enabled) expect(back[s.node], s.code).toBe(1);
  });

  it('each course is a contiguous legal drive from its start to Hexaware', () => {
    for (const s of map.starts.filter((x) => x.verified)) {
      const c = map.courses[s.code]!;
      expect(deFrom(c.des[0]!)).toBe(s.node);
      expect(deTo(c.des.at(-1)!)).toBe(map.destination.node);
      for (let i = 1; i < c.des.length; i++) expect(deFrom(c.des[i]!)).toBe(deTo(c.des[i - 1]!));
      for (const de of c.des) if (de & 1) expect(net.edges[de >> 1]!.oneway, `${s.code} drives a one-way road backwards`).toBe(false);
    }
  });
});

describe('M5: verified start locations', () => {
  it('coordinates come from OSM, lie within 60 km of Hexaware, and the spawn grid is on real road', () => {
    for (const s of map.starts) {
      expect(s.verified).toBe(true);
      expect(s.osm).toMatch(/^[nw]\d+$/);
      expect(haversineKm(s.lat!, s.lon!, map.destination.lat, map.destination.lon)).toBeLessThan(60);
      expect(s.spawn.length).toBeGreaterThanOrEqual(6);
      for (const p of s.spawn) expect(isOnRoad(net, p.x, p.z), `${s.code} spawn off-road`).toBe(true);
      // Slots don't overlap (≥ 4 m apart).
      for (let i = 0; i < s.spawn.length; i++)
        for (let j = i + 1; j < s.spawn.length; j++) expect(Math.hypot(s.spawn[i]!.x - s.spawn[j]!.x, s.spawn[i]!.z - s.spawn[j]!.z)).toBeGreaterThan(2 * 2.0 + 0.5); // CAR_RADIUS × 2 + margin
    }
  });

  it('DB holds coordinates + verified_at; Captain picks; disabled/full/locked starts are not selectable; cars spawn there', async () => {
    const s = await makeServer({ map: 'chennai', trafficCount: 50 });
    try {
      const rows = await s.db.db.select().from(startLocations);
      for (const st of map.starts) {
        const r = rows.find((x) => x.code === st.code)!;
        expect(r.enabled).toBe(true);
        expect(r.verifiedAt).toBeInstanceOf(Date);
        expect(r.lat).toBeCloseTo(st.lat!, 6);
        expect(r.worldX).toBeCloseTo(st.x, 1);
      }
      const [meta] = await s.db.db.select().from(worldMetadata).where(eq(worldMetadata.eventId, s.eventId));
      expect(meta!.osmAttribution).toMatch(/OpenStreetMap/);
      expect(meta!.worldScale).toBeCloseTo(map.scale);

      // A disabled (unverified) location is listed but not selectable.
      await s.db.db.insert(startLocations).values({ code: 'atlantis', name: 'Atlantis', enabled: false });
      const list = await get(s, '/api/start-locations');
      expect(list.body.find((x: { code: string }) => x.code === 'kelambakkam').selectable).toBe(true);
      const sq = await fullSquad(s, 'Pickers');
      const cap = { authorization: `Bearer ${sq.captain.sessionToken}` };
      expect((await post(s, '/api/team/start-location', { code: 'atlantis' }, cap)).body.error).toBe('START_DISABLED');
      expect((await post(s, '/api/team/start-location', { code: 'kelambakkam' }, { authorization: `Bearer ${sq.others[0].sessionToken}` })).status).toBe(403);
      expect((await post(s, '/api/team/start-location', { code: 'kelambakkam' }, cap)).status).toBe(200);
      // Capacity: 6 squads per location.
      for (let i = 0; i < 5; i++) {
        const o = await fullSquad(s, `K${i}`);
        expect((await post(s, '/api/team/start-location', { code: 'kelambakkam' }, { authorization: `Bearer ${o.captain.sessionToken}` })).status).toBe(200);
      }
      const late = await fullSquad(s, 'Late');
      expect((await post(s, '/api/team/start-location', { code: 'kelambakkam' }, { authorization: `Bearer ${late.captain.sessionToken}` })).body.error).toBe('START_FULL');
      expect((await get(s, '/api/start-locations')).body.find((x: { code: string }) => x.code === 'kelambakkam').selectable).toBe(false);

      // START: 'Late' (no choice) is auto-assigned to the least-used location; every car spawns on its grid.
      expect((await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY })).status).toBe(200);
      expect((await post(s, '/api/team/start-location', { code: 'guindy' }, cap)).body.error).toBe('EVENT_STARTED');
      const kel = map.starts.find((x) => x.code === 'kelambakkam')!;
      const cars = [...s.room.sim.cars.values()];
      expect(cars).toHaveLength(7);
      const atKel = cars.filter((c) => c.course === 'kelambakkam');
      expect(atKel).toHaveLength(6);
      for (const c of atKel) expect(kel.spawn.some((p) => Math.hypot(p.x - c.state.x, p.z - c.state.z) < 0.01)).toBe(true);
      const lateCar = s.room.sim.cars.get(late.captain.teamId)!;
      expect(lateCar.course).not.toBe('kelambakkam');
      expect(lateCar.course).toBe(map.starts.find((x) => x.code !== 'kelambakkam')!.code); // least-used, list order
    } finally {
      await s.dispose();
    }
  }, 60_000);
});

describe('M5: route normalisation', () => {
  it('reference-car time (shared vehicle model) for every course is within ±10% of the target', () => {
    const T = BALANCE.courseTargetS;
    const times: Record<string, number> = {};
    for (const s of map.starts.filter((x) => x.verified)) {
      const c = map.courses[s.code]!;
      const r = driveReference(net, c.des);
      expect(r.completed).toBe(true);
      times[s.code] = r.timeS;
      expect(Math.abs(r.timeS - T) / T, `${s.code}: ${(r.timeS / 60).toFixed(1)} min`).toBeLessThanOrEqual(BALANCE.courseTolerance);
      // Shorter natural routes are extended openly (via list), never shortcut.
      if (c.naturalTimeS < T * 0.95) expect(c.via.length).toBeGreaterThan(0);
      expect(c.refTimeS).toBeGreaterThanOrEqual(c.naturalTimeS - 1);
    }
    const v = Object.values(times);
    console.log(`[M5] course reference times (min): ${Object.entries(times).map(([k, t]) => `${k} ${(t / 60).toFixed(1)}`).join(', ')}`);
    expect(Math.max(...v) / Math.min(...v)).toBeLessThan(1.2);
  }, 60_000);

  it('10 checkpoints per course at equal fractions of reference time, in order, last at Hexaware', () => {
    for (const s of map.starts.filter((x) => x.verified)) {
      const c = map.courses[s.code]!;
      expect(c.checkpoints).toHaveLength(BALANCE.checkpointsPerCourse);
      const pts = coursePolyline(net, c.des);
      const dist = (x: number, z: number) => pts.reduce((b, p) => (Math.hypot(p.x - x, p.z - z) < b.e ? { d: p.d, e: Math.hypot(p.x - x, p.z - z) } : b), { d: 0, e: Infinity }).d;
      const ds = c.checkpoints.map((cp) => dist(cp.x, cp.z));
      for (let i = 1; i < ds.length; i++) expect(ds[i]!).toBeGreaterThan(ds[i - 1]!);
      const last = c.checkpoints.at(-1)!;
      const gate = net.nodes[map.destination.node]!;
      expect(Math.hypot(last.x - gate.x, last.z - gate.z)).toBeLessThan(30);
      // The gate node is the road access to the OSM "Hexaware Technologies" node (< 1.5 km real).
      expect(Math.hypot(gate.x - map.destination.x, gate.z - map.destination.z) / map.scale).toBeLessThan(1500);
      // Equal time fractions: the reference car reaches checkpoint k at ≈ k/10 of its course time.
      const r = driveReference(net, c.des, { splitAtM: ds });
      for (let k = 0; k < ds.length - 1; k++) expect(Math.abs(r.splits[k]! / r.timeS - c.checkpoints[k]!.frac), `${s.code} cp${k + 1}`).toBeLessThan(0.03);
    }
  }, 60_000);

  it('checkpoints are detected in order on the server and persisted idempotently', async () => {
    const s = await makeServer({ map: 'chennai', trafficCount: 0, releaseAtMs: 0, countdownMs: 0 }, { manualClock: true });
    try {
      const sq = await fullSquad(s, 'Gate');
      await post(s, '/api/team/start-location', { code: 'chennai_central' }, { authorization: `Bearer ${sq.captain.sessionToken}` });
      await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY });
      await s.room.tick();
      const car = s.room.sim.cars.get(sq.captain.teamId)!;
      const course = map.courses.chennai_central!;
      // Teleport past checkpoint 2 first: out of order → not counted.
      let seq = 0;
      const stepAt = (x: number, z: number) => {
        car.state = { ...car.state, x, z, vx: 0, vz: 0 };
        s.room.sim.pushInput(car.teamId, ++seq, NEUTRAL_INPUT);
        s.room.worldLoop(1);
      };
      stepAt(course.checkpoints[1]!.x, course.checkpoints[1]!.z);
      expect(car.nextCp).toBe(0);
      stepAt(course.checkpoints[0]!.x, course.checkpoints[0]!.z);
      expect(car.nextCp).toBe(1);
      stepAt(course.checkpoints[0]!.x, course.checkpoints[0]!.z); // again: no double count
      stepAt(course.checkpoints[1]!.x, course.checkpoints[1]!.z);
      expect(car.nextCp).toBe(2);
      await new Promise((r) => setTimeout(r, 100));
      const rows = await s.db.db.select().from(vehicleCheckpoints).where(eq(vehicleCheckpoints.teamId, car.teamId));
      expect(rows.map((r) => r.checkpointId).sort()).toEqual(['chennai_central-cp1', 'chennai_central-cp2']);
    } finally {
      await s.dispose();
    }
  }, 60_000);
});

