/**
 * Reference driver: follows a course with the SHARED vehicle model (no traffic, no signals, no collisions)
 * at each road class's reference speed, slowing for corners. Its time is the yardstick for route
 * normalisation and checkpoint splits (DESIGN §8). Deterministic.
 */
import { deStart, deStop, lanePoint, type RoadNetwork } from './road';
import { NEUTRAL_INPUT, VEHICLES, driveEnv, forwardSpeed, initialVehicleState, stepVehicle, wrapAngle, type VehicleParams } from './vehicle';

export interface PathPoint {
  x: number;
  z: number;
  /** cumulative distance along the path */
  d: number;
  speed: number;
  /** index of the directed edge in the course's `des` */
  k: number;
}

/** Sample a course (list of directed edges) as a lane-0 polyline every ~5 m. */
export function coursePolyline(net: RoadNetwork, des: number[], step = 5): PathPoint[] {
  const pts: PathPoint[] = [];
  let d = 0;
  des.forEach((de, k) => {
    const e = net.edges[de >> 1]!;
    const s0 = k === 0 ? 0 : deStart(net, de);
    const s1 = k === des.length - 1 ? e.length : deStop(net, de);
    const n = Math.max(1, Math.ceil((s1 - s0) / step));
    for (let i = 0; i <= n; i++) {
      const p = lanePoint(net, de, 0, s0 + ((s1 - s0) * i) / n);
      const prev = pts[pts.length - 1];
      if (prev) d += Math.hypot(p.x - prev.x, p.z - prev.z);
      if (!prev || Math.hypot(p.x - prev.x, p.z - prev.z) > 0.5) pts.push({ x: p.x, z: p.z, d, speed: e.speedLimit, k });
    }
  });
  return pts;
}

export interface ReferenceResult {
  timeS: number;
  completed: boolean;
  /** time (s) at which the car passed each path distance mark requested */
  splits: number[];
}

export function driveReference(
  net: RoadNetwork,
  des: number[],
  opts: { params?: VehicleParams; maxTimeS?: number; splitAtM?: number[]; dt?: number } = {},
): ReferenceResult {
  const params = opts.params ?? VEHICLES.vortex_gt;
  const dt = opts.dt ?? 0.05;
  const pts = coursePolyline(net, des);
  const total = pts[pts.length - 1]!.d;
  const env = driveEnv(true, false);
  const h0 = Math.atan2(pts[1]!.x - pts[0]!.x, pts[1]!.z - pts[0]!.z);
  let s = initialVehicleState(pts[0]!.x, pts[0]!.z, h0, 100);
  let i = 0;
  let t = 0;
  const marks = [...(opts.splitAtM ?? [])].sort((a, b) => a - b);
  const splits: number[] = [];
  const maxT = opts.maxTimeS ?? 4 * 3600;
  while (t < maxT) {
    // Advance the closest-point index (search a small window forward).
    let best = i;
    let bd = Infinity;
    for (let j = i; j < Math.min(pts.length, i + 40); j++) {
      const dd = (pts[j]!.x - s.x) ** 2 + (pts[j]!.z - s.z) ** 2;
      if (dd < bd) (bd = dd), (best = j);
    }
    i = best;
    const here = pts[i]!.d;
    while (marks.length && here >= marks[0]!) splits.push(t), marks.shift();
    if (here >= total - 8) break;
    const v = Math.max(0, forwardSpeed(s));
    // Pure pursuit target.
    const look = 6 + v * 0.6;
    let j = i;
    while (j < pts.length - 1 && pts[j]!.d - here < look) j++;
    const tgt = pts[j]!;
    const desired = Math.atan2(tgt.x - s.x, tgt.z - s.z);
    const steer = Math.max(-1, Math.min(1, wrapAngle(desired - s.heading) * 2.2));
    // Target speed: class reference speed, limited by upcoming curvature.
    let target = pts[i]!.speed;
    const horizon = here + Math.max(25, v * 3);
    for (let m = i + 1; m < pts.length - 1 && pts[m]!.d < horizon; m++) {
      const a = pts[m - 1]!;
      const b = pts[m]!;
      const c = pts[m + 1]!;
      const turn = Math.abs(wrapAngle(Math.atan2(c.x - b.x, c.z - b.z) - Math.atan2(b.x - a.x, b.z - a.z)));
      const seg = Math.max(1, c.d - a.d);
      if (turn > 0.02) {
        const radius = seg / turn;
        const vCorner = Math.sqrt(params.latLimit * 0.75 * radius);
        // allow braking distance
        const dist = b.d - here;
        target = Math.min(target, Math.sqrt(vCorner * vCorner + 2 * 6 * Math.max(0, dist)), pts[m]!.speed);
      } else target = Math.min(target, Math.sqrt(pts[m]!.speed ** 2 + 2 * 6 * Math.max(0, b.d - here)));
    }
    const throttle = Math.max(0, Math.min(1, (target - v) * 0.6));
    const brake = Math.max(0, Math.min(1, (v - target) * 0.35));
    s = stepVehicle(s, { ...NEUTRAL_INPUT, steer, throttle, brake: throttle > 0 ? 0 : brake }, params, env, dt);
    t += dt;
  }
  while (marks.length) splits.push(t), marks.shift();
  return { timeS: t, completed: t < maxT, splits };
}
