/**
 * Server-simulated traffic. One shared traffic state for the whole world: every client near a junction sees
 * the same queue. Deterministic given (network, seed, obstacle positions).
 */
import { createRng, type Rng } from '../rng';
import {
  deEnds,
  deHeading,
  deReverse,
  deStart,
  deStop,
  lanePoint,
  signalGroup,
  signalState,
  type RoadNetwork,
  type SignalColor,
} from './road';

export const TRAFFIC_TYPES = {
  car: { code: 0, length: 4.5, width: 1.8, speedMul: 1.0, accel: 2.5 },
  motorcycle: { code: 1, length: 2.2, width: 0.8, speedMul: 1.05, accel: 3.0 },
  bus: { code: 2, length: 11, width: 2.5, speedMul: 0.75, accel: 1.4 },
  truck: { code: 3, length: 9, width: 2.4, speedMul: 0.7, accel: 1.3 },
} as const;
export type TrafficType = keyof typeof TRAFFIC_TYPES;
export const TRAFFIC_TYPE_BY_CODE: TrafficType[] = ['car', 'motorcycle', 'bus', 'truck'];

export interface Connector {
  toDe: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  len: number;
}

export interface TrafficAgent {
  id: number;
  type: TrafficType;
  de: number;
  lane: number;
  /** Lateral lane position (fractional while changing lanes). */
  laneF: number;
  s: number;
  speed: number;
  /** Desired cruising factor (driver personality). */
  cruise: number;
  conn: Connector | null;
  /** Set when an obstacle forced a stop this tick (debug/telemetry). */
  blocked: boolean;
}

export interface TrafficPose {
  id: number;
  type: TrafficType;
  x: number;
  z: number;
  heading: number;
  speed: number;
}

export type SignalFn = (nodeId: number, heading: number, simMs: number) => SignalColor;

export interface TrafficOptions {
  seed: string | number;
  count: number;
  /** Directed edges where no traffic spawns initially (e.g. squad spawn grid). */
  excludeDe?: number[];
  /** If given, traffic only spawns on these directed edges (e.g. the course corridors of a large map). */
  spawnDe?: number[];
  signal?: SignalFn;
  /** Spawn only this vehicle type (visual vertical slice). Default: the seeded mix. */
  onlyType?: TrafficType;
}

const IDM = { minGap: 2.5, headway: 1.2, comfortDecel: 3, stopDecel: 4 };

export class TrafficSystem {
  readonly agents: TrafficAgent[] = [];
  private readonly rng: Rng;
  private readonly signal: SignalFn;

  constructor(
    private readonly net: RoadNetwork,
    opts: TrafficOptions,
  ) {
    this.rng = createRng(opts.seed, 'traffic');
    const seed = opts.seed;
    this.signal = opts.signal ?? ((node, heading, ms) => signalState(node, signalGroup(net, node, heading), ms, seed));
    this.exclude = new Set(opts.excludeDe ?? []);
    this.spawnPool = this.slots(opts.spawnDe);
    this.onlyType = opts.onlyType;
    this.spawn(opts.count);
  }

  private readonly exclude: Set<number>;
  private readonly onlyType: TrafficType | undefined;
  /** Closed edge ids (Route Lockdown): traffic never turns into them. */
  blockedEdges = new Set<number>();
  /** Per-edge speed multiplier (Traffic Shock). */
  edgeSpeedMul = new Map<number, number>();
  private readonly spawnPool: { de: number; lane: number; s: number }[];
  private nextId = 1;

  private slots(only?: number[]) {
    const net = this.net;
    const slots: { de: number; lane: number; s: number }[] = [];
    const des = only ?? [...Array(net.edges.length * 2).keys()];
    for (const de of des) {
      const e = net.edges[de >> 1]!;
      if (this.exclude.has(de) || (e.oneway && de & 1)) continue;
      const s0 = deStart(net, de);
      const s1 = deStop(net, de);
      for (let lane = 0; lane < e.lanes; lane++) for (let s = s0 + 6; s < s1 - 10; s += 24) slots.push({ de, lane, s });
    }
    return slots;
  }

  private spawn(count: number) {
    const slots = [...this.spawnPool];
    for (let i = slots.length - 1; i > 0; i--) {
      const j = this.rng.int(i + 1);
      [slots[i], slots[j]] = [slots[j]!, slots[i]!];
    }
    for (let i = 0; i < Math.min(count, slots.length); i++) {
      const r = this.rng.next();
      const type: TrafficType = this.onlyType ?? (r < 0.6 ? 'car' : r < 0.8 ? 'motorcycle' : r < 0.9 ? 'bus' : 'truck');
      const sl = slots[i]!;
      this.agents.push({ id: this.nextId++, type, de: sl.de, lane: sl.lane, laneF: sl.lane, s: sl.s, speed: 0, cruise: 0.85 + this.rng.next() * 0.2, conn: null, blocked: false });
    }
  }

  /** Move an agent that hit a sink (no legal exit) back to a free spawn slot. Deterministic. */
  private respawn(a: TrafficAgent) {
    for (let tries = 0; tries < 20 && this.spawnPool.length; tries++) {
      const sl = this.spawnPool[this.rng.int(this.spawnPool.length)]!;
      const clear = this.agents.every((b) => b === a || b.conn || b.de !== sl.de || b.lane !== sl.lane || Math.abs(b.s - sl.s) > 15);
      if (!clear) continue;
      Object.assign(a, { de: sl.de, lane: sl.lane, laneF: sl.lane, s: sl.s, speed: 0, conn: null });
      return;
    }
    a.speed = 0;
  }

  /** Seeded weighted choice of the next edge: major roads are preferred, no U-turns unless it's a dead end. */
  private chooseNext(a: TrafficAgent, toId: number): number | null {
    const net = this.net;
    const legal = net.out[toId]!;
    const open = legal.filter((d) => !this.blockedEdges.has(d >> 1));
    let options = open.filter((d) => d !== deReverse(a.de));
    if (!options.length) options = open.length ? open : legal;
    if (!options.length) return null;
    const w = options.map((d) => 1 / (1 + net.edges[d >> 1]!.cls));
    let r = this.rng.next() * w.reduce((x, y) => x + y, 0);
    for (let i = 0; i < options.length; i++) if ((r -= w[i]!) <= 0) return options[i]!;
    return options[options.length - 1]!;
  }

  pose(a: TrafficAgent): TrafficPose {
    if (a.conn) {
      const c = a.conn;
      const t = Math.min(1, a.s / c.len);
      return { id: a.id, type: a.type, x: c.ax + (c.bx - c.ax) * t, z: c.az + (c.bz - c.az) * t, heading: Math.atan2(c.bx - c.ax, c.bz - c.az), speed: a.speed };
    }
    const p = lanePoint(this.net, a.de, a.laneF, a.s);
    return { id: a.id, type: a.type, x: p.x, z: p.z, heading: p.heading, speed: a.speed };
  }

  poses(): TrafficPose[] {
    return this.agents.map((a) => this.pose(a));
  }

  /** Gap (m) to the nearest blocking thing ahead of `a`, and the speed of that thing. */
  private gapAhead(
    a: TrafficAgent,
    simMs: number,
    obstacles: readonly { x: number; z: number }[],
    poses: Map<number, TrafficPose>,
    byDe: Map<number, TrafficAgent[]>,
    onConn: TrafficAgent[],
  ) {
    const net = this.net;
    const me = TRAFFIC_TYPES[a.type];
    let gap = Infinity;
    let leadSpeed = 0;
    const consider = (g: number, v: number) => {
      if (g < gap) (gap = g), (leadSpeed = v);
    };
    if (!a.conn) {
      const stopS = deStop(net, a.de);
      // Leaders on the same directed edge, same (or target) lane.
      for (const b of byDe.get(a.de) ?? []) {
        if (b === a || b.s <= a.s) continue;
        if (Math.abs(b.laneF - a.laneF) > 0.6 && Math.abs(b.lane - a.lane) > 0) continue;
        consider(b.s - a.s - (me.length + TRAFFIC_TYPES[b.type].length) / 2, b.speed);
      }
      // Traffic signal at the end of this edge.
      const { to } = deEnds(net, a.de);
      if (to.signal) {
        const col = this.signal(to.id, deHeading(net, a.de), simMs);
        const dist = stopS - a.s - me.length / 2;
        const canStop = (a.speed * a.speed) / (2 * IDM.stopDecel) <= dist + 1;
        if (col === 'R' || (col === 'A' && canStop)) consider(dist, 0);
      }
      // Agents on junction connectors just ahead (junction box occupied).
      if (a.s > stopS - 60) for (const b of onConn) {
        if (b === a) continue;
        const p = poses.get(b.id)!;
        const ahead = this.along(a, poses.get(a.id)!, p);
        if (ahead && ahead.lat < 2.2 && ahead.d > 0) consider(ahead.d - (me.length + TRAFFIC_TYPES[b.type].length) / 2, b.speed);
      }
    } else {
      for (const b of onConn) {
        if (b === a) continue;
        const p = poses.get(b.id)!;
        const ahead = this.along(a, poses.get(a.id)!, p);
        if (ahead && ahead.lat < 2.2 && ahead.d > 0 && ahead.d < 30) consider(ahead.d - (me.length + TRAFFIC_TYPES[b.type].length) / 2, b.speed);
      }
    }
    // Squad cars (and any other dynamic obstacle) in our path.
    const pa = poses.get(a.id)!;
    for (const o of obstacles) {
      const ahead = this.along(a, pa, o);
      // Squad car ≈ 2 m wide: block until there is ≥ 1.1 m of side clearance.
      if (ahead && ahead.d > -1 && ahead.d < 45 && ahead.lat < me.width / 2 + 2.1) consider(Math.max(0, ahead.d) - me.length / 2 - 2.2, 0);
    }
    return { gap, leadSpeed };
  }

  private along(_a: TrafficAgent, pa: TrafficPose, p: { x: number; z: number }) {
    const fx = Math.sin(pa.heading);
    const fz = Math.cos(pa.heading);
    const dx = p.x - pa.x;
    const dz = p.z - pa.z;
    const d = dx * fx + dz * fz;
    if (d <= -1 || d > 60) return null;
    return { d, lat: Math.abs(dx * fz - dz * fx) };
  }

  step(dt: number, simMs: number, obstacles: readonly { x: number; z: number }[] = []) {
    const net = this.net;
    const poses = new Map<number, TrafficPose>();
    const byDe = new Map<number, TrafficAgent[]>();
    const onConn: TrafficAgent[] = [];
    for (const a of this.agents) {
      poses.set(a.id, this.pose(a));
      if (a.conn) onConn.push(a);
      else {
        let list = byDe.get(a.de);
        if (!list) byDe.set(a.de, (list = []));
        list.push(a);
      }
    }
    const accels = this.agents.map((a) => {
      const t = TRAFFIC_TYPES[a.type];
      const limit = (a.conn ? net.edges[a.conn.toDe >> 1]! : net.edges[a.de >> 1]!).speedLimit;
      const v0 = limit * t.speedMul * a.cruise * (a.conn ? 0.6 : 1) * (this.edgeSpeedMul.get((a.conn ? a.conn.toDe : a.de) >> 1) ?? 1);
      const { gap, leadSpeed } = this.gapAhead(a, simMs, obstacles, poses, byDe, onConn);
      const v = a.speed;
      let acc = t.accel * (1 - Math.pow(v / v0, 4));
      a.blocked = false;
      if (gap < Infinity) {
        const dv = v - leadSpeed;
        const sStar = IDM.minGap + v * IDM.headway + (v * dv) / (2 * Math.sqrt(t.accel * IDM.comfortDecel));
        acc -= t.accel * Math.pow(Math.max(sStar, 0) / Math.max(gap, 0.1), 2);
        if (gap < 1) a.blocked = true;
      }
      return Math.max(-9, acc);
    });

    this.agents.forEach((a, i) => {
      a.speed = Math.max(0, a.speed + accels[i]! * dt);
      if (a.blocked && a.speed < 0.5) a.speed = 0;
      let move = a.speed * dt;
      if (a.conn) {
        a.s += move;
        if (a.s >= a.conn.len) {
          const over = a.s - a.conn.len;
          a.de = a.conn.toDe;
          a.conn = null;
          a.s = deStart(net, a.de) + over;
        }
        return;
      }
      const stopS = deStop(net, a.de);
      // Lane change toward the target lane.
      if (a.laneF !== a.lane) {
        const dir = Math.sign(a.lane - a.laneF);
        a.laneF += dir * Math.min(Math.abs(a.lane - a.laneF), 0.8 * dt);
      } else if (a.s < stopS - 60 && a.speed < 6 && this.rng.next() < 0.02) {
        this.tryLaneChange(a);
      }
      a.s += move;
      if (a.s >= stopS) {
        // Enter the junction: pick an outgoing edge (no U-turn), seeded.
        const { to } = deEnds(net, a.de);
        const toDe = this.chooseNext(a, to.id);
        if (toDe === null) return this.respawn(a);
        const lane = Math.min(a.lane, net.edges[toDe >> 1]!.lanes - 1);
        const from = lanePoint(net, a.de, a.laneF, stopS);
        const dest = lanePoint(net, toDe, lane, deStart(net, toDe));
        a.lane = lane;
        a.laneF = lane;
        a.conn = { toDe, ax: from.x, az: from.z, bx: dest.x, bz: dest.z, len: Math.max(1, Math.hypot(dest.x - from.x, dest.z - from.z)) };
        a.s = a.s - stopS;
      }
    });
  }

  private tryLaneChange(a: TrafficAgent) {
    const lanes = this.net.edges[a.de >> 1]!.lanes;
    if (lanes < 2) return;
    const target = a.lane === 0 ? 1 : a.lane - 1;
    if (target < 0 || target >= lanes) return;
    const clear = this.agents.every((b) => b === a || b.conn || b.de !== a.de || b.lane !== target || Math.abs(b.s - a.s) > 14);
    if (clear) a.lane = target;
  }
}
