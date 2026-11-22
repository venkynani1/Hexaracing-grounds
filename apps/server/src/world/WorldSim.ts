import {
  BALANCE,
  CAR_RADIUS,
  NEUTRAL_INPUT,
  TRAFFIC_TYPES,
  TrafficSystem,
  VEHICLES,
  applyImpact,
  driveEnv,
  forwardSpeed,
  generateBuildings,
  ProceduralBuildings,
  deStart,
  deStop,
  testMap,
  stationExclusions,
  type Closure,
  type WorldMap,
  type CourseDef,
  initialVehicleState,
  isOnRoad,
  lanePoint,
  nearestEdge,
  deHeading,
  wrapAngle,
  resolveStatic,
  stepVehicle,
  type Building,
  type RoadNetwork,
  type VehicleCode,
  type VehicleInput,
  type VehicleParams,
  type VehicleState,
  BUFFS,
  applyBuffs,
  type BuffKind,
} from '@redline/shared';

export const SIM_DT = 0.05;
export const SIM_DT_MS = 50;
/** Inputs older than this many ticks → the car is treated as disconnected and AI-brakes (DESIGN §4). */
const STALE_INPUT_TICKS = 20;
const MAX_QUEUE = 6;
export const CHECKPOINT_RADIUS = 25;
/** Input budget (anti speed-hack): +1 per tick, capped. A car can never apply more inputs than ticks elapsed + cap. */
export const INPUT_BUDGET_MAX = 10;
/** Max inputs applied per tick when catching up after jitter. */
const MAX_STEPS_PER_TICK = 2;
/** Jitter buffer: how long a car waits for a late input before extrapolating. */
const HOLD_TICKS = 3;

/** Anti-ramming (DESIGN §8): ≥3 high-impulse hits by the same aggressor on the same squad within 10 s. */
export const RAMMING = {
  minClosingSpeed: 5,
  /** Aggressor's closing component must exceed the victim's by this factor. */
  dominance: 1.25,
  windowMs: 10_000,
  hits: 3,
  ghostMs: 5_000,
} as const;
export const STUCK = { speed: 1, offerMs: 3_000, autoMs: 6_000 } as const;

export interface SimCar {
  /** Compact id 1..N for snapshots. */
  cid: number;
  teamId: string;
  name: string;
  params: VehicleParams;
  state: VehicleState;
  queue: { seq: number; input: VehicleInput }[];
  lastInput: VehicleInput;
  /** Highest seq received (replay guard). */
  lastSeq: number;
  /** Seq of the last input applied in a step. */
  ackSeq: number;
  ticksSinceInput: number;
  braking: boolean;
  /** simMs until which the car is ghosted (non-collidable, visible, labelled). */
  ghostUntil: number;
  /** Victim of ramming: one free reset. */
  freeReset: boolean;
  stuckMs: number;
  inputBudget: number;
  /** Course (start location code) and next checkpoint index on the shared map. */
  course: string;
  nextCp: number;
  /** Active buffs: kind → simMs expiry. Effects are applied in the shared model (client predicts them too). */
  buffs: Map<BuffKind, number>;
  /** Held by the server (pit bay / queue, roadside recovery): no driving; inputs are still acknowledged. */
  held: { x: number; z: number; heading: number; reason: 'pit' | 'recovery' | 'safe'; until?: number } | null;
  /** Server-driven movement along a real-road path (disclosed escort, Welcome Convoy). */
  auto: { kind: 'escort' | 'convoy'; path: { x: number; z: number; d: number }[]; s: number; speed: number; startAtSimMs: number } | null;
  /** How the car reached the gate (null = not yet). */
  arrival: { mode: 'driven' | 'escort' | 'assisted'; tick: number } | null;
  /** Tick of the last checkpoint pass (for the clean-driving bonus). */
  lastPassTick: number;
}

export interface CheckpointPass {
  teamId: string;
  checkpointId: string;
  index: number;
  tick: number;
  speed: number;
  /** passed during the disclosed escort → scores 0 */
  escorted: boolean;
  /** no ramming penalty since the previous checkpoint */
  clean: boolean;
}

export interface Penalty {
  teamId: string;
  victimTeamId: string;
  tick: number;
  reason: 'ramming';
}

export interface Contact {
  tick: number;
  a: string;
  b: string;
  /** Δv applied to a and b along the contact normal (equal and opposite). */
  dvA: [number, number];
  dvB: [number, number];
  closing: number;
  aggressor: string | null;
}

/**
 * The single authoritative world simulation: squad cars + traffic on one road network, one clock (tick),
 * one weather state. Fixed 20 Hz step. No I/O here — WorldRoom drives it and streams snapshots.
 */
export class WorldSim {
  readonly map: WorldMap;
  readonly net: RoadNetwork;
  /** Static obstacles near a point (test grid: fixed list; real maps: procedural per cell). */
  readonly buildingsNear: (x: number, z: number) => Building[];
  /** Test grid only (kept for tests that inspect buildings directly). */
  readonly buildings: Building[];
  /** Checkpoint passes since the last drain (WorldRoom persists them). */
  checkpointPasses: CheckpointPass[] = [];
  /** Cars that reached the gate (GateService drains these). */
  arrivals: { teamId: string; mode: 'driven' | 'escort'; tick: number }[] = [];
  /** Cars that pulled into a station zone (PitService drains these). */
  pitArrivals: { teamId: string; stationId: string }[] = [];
  /** Completed roadside recoveries (PitService charges credits). */
  recoveries: { teamId: string; tick: number }[] = [];
  /** Active road closures and their barrier obstacles (Director). */
  closures: Closure[] = [];
  private barriers: Building[] = [];
  readonly traffic: TrafficSystem;
  readonly cars = new Map<string, SimCar>();
  tick = 0;
  rain = false;
  released = false;
  readonly penalties: Penalty[] = [];
  /** Contacts resolved in the most recent step (for tests / telemetry). */
  contacts: Contact[] = [];
  private readonly ramLog = new Map<string, number[]>();
  /** Called when a car is ghosted (WorldRoom audit-logs it). */
  onPenalty: ((p: Penalty) => void) | null = null;

  constructor(readonly opts: { seed: string; trafficCount?: number; map?: WorldMap }) {
    this.map = opts.map ?? testMap();
    this.net = this.map.net;
    const ex = stationExclusions(this.map);
    if (this.map.id === 'test') {
      this.buildings = generateBuildings(this.net, opts.seed, ex);
      this.buildingsNear = () => (this.barriers.length ? [...this.buildings, ...this.barriers] : this.buildings);
    } else {
      const pb = new ProceduralBuildings(this.net, opts.seed, ex, 20_000);
      this.procedural = pb;
      this.buildings = [];
      this.buildingsNear = (x, z) => (this.barriers.length ? [...pb.near(x, z, 40), ...this.barriers] : pb.near(x, z, 40));
    }
    // Traffic lives on the course corridors of a real map (one shared traffic state for everyone).
    const courses = Object.values(this.map.courses);
    const corridor = courses.length ? [...new Set(courses.flatMap((c) => c.des.flatMap((de) => [de, de ^ 1])))] : undefined;
    const spawnEdges = courses.flatMap((c) => c.des.slice(0, 4));
    this.traffic = new TrafficSystem(this.net, {
      seed: opts.seed,
      count: opts.trafficCount ?? BALANCE.trafficAgents,
      excludeDe: this.map.id === 'test' ? [0] : spawnEdges,
      spawnDe: corridor,
    });
  }

  /** Recovery snapshot of every squad car (traffic is re-seeded on restore — documented). */
  snapshot() {
    return {
      tick: this.tick,
      rain: this.rain,
      released: this.released,
      penalties: [...this.penalties],
      cars: [...this.cars.values()].map((c) => ({
        teamId: c.teamId,
        cid: c.cid,
        name: c.name,
        vc: c.params.code,
        state: c.state,
        course: c.course,
        nextCp: c.nextCp,
        arrival: c.arrival,
        buffs: [...c.buffs],
        held: c.held,
        auto: c.auto,
        freeReset: c.freeReset,
        ghostUntil: c.ghostUntil,
        lastPassTick: c.lastPassTick,
        lastSeq: c.lastSeq,
        ackSeq: c.ackSeq,
      })),
    };
  }

  restore(snap: ReturnType<WorldSim['snapshot']>) {
    this.tick = snap.tick;
    this.rain = snap.rain;
    this.released = snap.released;
    this.penalties.splice(0, this.penalties.length, ...snap.penalties);
    this.cars.clear();
    for (const c of snap.cars) {
      this.cars.set(c.teamId, {
        cid: c.cid,
        teamId: c.teamId,
        name: c.name,
        params: VEHICLES[c.vc],
        state: c.state,
        queue: [],
        lastInput: NEUTRAL_INPUT,
        lastSeq: c.lastSeq,
        ackSeq: c.ackSeq,
        ticksSinceInput: 0,
        braking: false,
        ghostUntil: c.ghostUntil,
        freeReset: c.freeReset,
        stuckMs: 0,
        inputBudget: INPUT_BUDGET_MAX,
        buffs: new Map(c.buffs),
        held: c.held,
        auto: c.auto,
        arrival: c.arrival,
        lastPassTick: c.lastPassTick,
        course: c.course,
        nextCp: c.nextCp,
      });
    }
  }

  private procedural: ProceduralBuildings | null = null;

  /**
   * Boot-time warm-up (never inside a tick): generate every procedural building cell along all course corridors,
   * build the road spatial index, and JIT-warm the step. Cars that wander off-course still generate lazily.
   */
  prewarm(): { cells: number; ms: number } {
    const t0 = Date.now();
    isOnRoad(this.net, 0, 0);
    let cells = 0;
    if (this.procedural) {
      const seen = new Set<string>();
      for (const c of Object.values(this.map.courses))
        for (const de of c.des) {
          const e = this.net.edges[de >> 1]!;
          const a = this.net.nodes[e.a]!;
          const b = this.net.nodes[e.b]!;
          const n = Math.max(1, Math.ceil(e.length / 100));
          for (let i = 0; i <= n; i++) {
            const x = a.x + ((b.x - a.x) * i) / n;
            const z = a.z + ((b.z - a.z) * i) / n;
            const k = `${Math.floor(x / 200)},${Math.floor(z / 200)}`;
            if (seen.has(k)) continue;
            seen.add(k);
            this.procedural.near(x, z, 220);
            cells++;
          }
        }
      for (const st of this.map.stations) this.procedural.near(st.x, st.z, 220);
    }
    return { cells, ms: Date.now() - t0 };
  }

  /**
   * JIT warm-up on a THROWAWAY simulation (separate instance, never the event's world): compiles the hot step code
   * before players connect so the first real ticks aren't cold.
   */
  static warmJit(map: WorldMap, steps = 300): number {
    const t0 = Date.now();
    const w = new WorldSim({ seed: 'jit-warmup', trafficCount: 120, map });
    const starts = map.starts.filter((s) => s.verified);
    w.spawn(Array.from({ length: 12 }, (_, i) => ({ teamId: `warm-${i}`, name: `warm-${i}`, start: starts[i % starts.length]?.code })));
    w.released = true;
    for (let i = 1; i <= steps; i++) {
      for (const c of w.cars.values()) w.pushInput(c.teamId, i, { ...NEUTRAL_INPUT, throttle: 1, steer: Math.sin(i / 20) * 0.3 });
      w.step();
    }
    return Date.now() - t0;
  }

  courseOf(car: SimCar): CourseDef | undefined {
    return this.map.courses[car.course];
  }

  get simMs() {
    return this.tick * SIM_DT_MS;
  }

  /**
   * Place squad cars on their start location's spawn grid, in registration order (deterministic).
   * Idempotent per team. `start` defaults to the map's first verified start.
   */
  spawn(teams: { teamId: string; name: string; vehicle?: VehicleCode | null; start?: string | null }[]) {
    const used = new Map<string, number>();
    for (const c of this.cars.values()) used.set(c.course, (used.get(c.course) ?? 0) + 1);
    const fallback = this.map.starts.find((s) => s.verified)!;
    teams.forEach((t) => {
      if (this.cars.has(t.teamId)) return;
      const start = this.map.starts.find((s) => s.code === t.start && s.verified) ?? fallback;
      const n = used.get(start.code) ?? 0;
      used.set(start.code, n + 1);
      const slot = start.spawn[n % start.spawn.length]!;
      const params = VEHICLES[t.vehicle ?? 'vortex_gt'];
      this.cars.set(t.teamId, {
        cid: this.cars.size + 1,
        teamId: t.teamId,
        name: t.name,
        params,
        state: initialVehicleState(slot.x, slot.z, slot.heading, BALANCE.startFuelPct),
        course: start.code,
        nextCp: 0,
        queue: [],
        lastInput: NEUTRAL_INPUT,
        lastSeq: 0,
        ackSeq: 0,
        ticksSinceInput: 0,
        braking: false,
        ghostUntil: 0,
        freeReset: false,
        stuckMs: 0,
        inputBudget: INPUT_BUDGET_MAX,
        buffs: new Map(),
        held: null,
        auto: null,
        arrival: null,
        lastPassTick: 0,
      });
    });
  }

  /** A (re)connected Racer starts a fresh input stream (its predictor restarts at seq 1). Replays within a stream stay rejected. */
  resetInputStream(teamId: string) {
    const car = this.cars.get(teamId);
    if (!car) return;
    car.lastSeq = 0;
    car.ackSeq = 0;
    car.queue = [];
  }

  /** Queue a racer input. Rejects replayed / out-of-order seq. Returns false when rejected. */
  pushInput(teamId: string, seq: number, input: VehicleInput): boolean {
    const car = this.cars.get(teamId);
    if (!car || !Number.isSafeInteger(seq) || seq <= car.lastSeq) return false;
    if (car.inputBudget <= 0) return false;
    car.inputBudget--;
    car.lastSeq = seq;
    car.queue.push({ seq, input });
    if (car.queue.length > MAX_QUEUE) car.queue.splice(0, car.queue.length - MAX_QUEUE);
    return true;
  }

  /* ---------- holds (pit / recovery), stations, closures ---------- */

  /** Start server-driven movement along `path` from distance s0 (escort: from where the car is; convoy: its slot). */
  startAuto(teamId: string, kind: 'escort' | 'convoy', path: { x: number; z: number; d: number }[], s0: number, speed: number, startAtSimMs = this.simMs) {
    const car = this.cars.get(teamId);
    if (!car) return;
    car.held = null;
    car.auto = { kind, path, s: s0, speed, startAtSimMs };
    this.placeOnPath(car);
  }

  stopAuto(teamId: string) {
    const car = this.cars.get(teamId);
    if (car) car.auto = null;
  }

  private placeOnPath(car: SimCar) {
    const a = car.auto!;
    const p = a.path;
    let i = 1;
    while (i < p.length - 1 && p[i]!.d < a.s) i++;
    const A = p[i - 1]!;
    const B = p[i]!;
    const t = Math.max(0, Math.min(1, (a.s - A.d) / Math.max(1e-6, B.d - A.d)));
    const heading = Math.atan2(B.x - A.x, B.z - A.z);
    const moving = this.simMs >= a.startAtSimMs && a.s < p[p.length - 1]!.d;
    car.state = {
      ...car.state,
      x: A.x + (B.x - A.x) * t,
      z: A.z + (B.z - A.z) * t,
      heading,
      vx: moving ? Math.sin(heading) * a.speed : 0,
      vz: moving ? Math.cos(heading) * a.speed : 0,
    };
  }

  hold(teamId: string, at: { x: number; z: number; heading: number }, reason: 'pit' | 'recovery' | 'safe', until?: number) {
    const car = this.cars.get(teamId);
    if (!car) return;
    car.held = { ...at, reason, until };
    car.state = { ...car.state, x: at.x, z: at.z, heading: at.heading, vx: 0, vz: 0 };
  }

  release(teamId: string, at?: { x: number; z: number; heading: number }) {
    const car = this.cars.get(teamId);
    if (!car) return;
    car.held = null;
    if (at) car.state = { ...car.state, x: at.x, z: at.z, heading: at.heading, vx: 0, vz: 0 };
    car.stuckMs = 0;
  }

  /** Station whose zone contains the point (cars there are non-collidable so nobody can block service). */
  stationAt(x: number, z: number, pad = 0) {
    for (const st of this.map.stations) if (Math.hypot(st.x - x, st.z - z) <= st.radius + pad) return st;
    return null;
  }

  setClosures(closures: Closure[]) {
    this.closures = closures;
    this.barriers = closures.flatMap((c) => c.barriers.map((b) => ({ x: b.x, z: b.z, w: b.width, d: 1.2, h: 1.1, tone: 0, rot: b.heading })));
    this.traffic.blockedEdges = new Set(closures.flatMap((c) => c.edges));
  }

  get barrierObstacles() {
    return this.barriers;
  }

  isGhost(c: SimCar) {
    return c.ghostUntil > this.simMs;
  }

  canReset(c: SimCar) {
    return c.freeReset || c.stuckMs >= STUCK.offerMs;
  }

  /**
   * Safe reset (DESIGN §8): place the car stopped on the nearest lane centre, facing the lane direction
   * closest to its heading, away from other cars. Disclosed to the player; no score effect.
   */
  resetCar(teamId: string, reason: 'player' | 'auto'): boolean {
    const car = this.cars.get(teamId);
    if (!car) return false;
    if (reason === 'player') {
      if (car.stuckMs >= STUCK.offerMs) {
        /* stuck allowance: unlimited */
      } else if (car.freeReset) car.freeReset = false;
      else return false;
    }
    const net = this.net;
    const ne = nearestEdge(net, car.state.x, car.state.z, 400);
    const e0 = net.edges[Math.max(0, ne.edge)]!;
    const fwd = !e0.oneway ? Math.abs(wrapAngle(deHeading(net, e0.id * 2) - car.state.heading)) <= Math.PI / 2 : true;
    const best = { de: fwd ? e0.id * 2 : e0.id * 2 + 1, s: fwd ? ne.t * e0.length : (1 - ne.t) * e0.length };
    const len = net.edges[best.de >> 1]!.length;
    const lo = Math.min(deStart(net, best.de) + 3, len / 2);
    const hi = Math.max(deStop(net, best.de) - 3, len / 2);
    let s = Math.max(lo, Math.min(hi, best.s));
    let p = lanePoint(net, best.de, 0, s);
    for (let i = 0; i < 12; i++) {
      const clear = [...this.cars.values()].every((o) => o === car || Math.hypot(o.state.x - p.x, o.state.z - p.z) > 6);
      if (clear) break;
      s = Math.min(hi, s + 8);
      p = lanePoint(net, best.de, i % 2, s);
    }
    car.state = { ...car.state, x: p.x, z: p.z, heading: p.heading, vx: 0, vz: 0 };
    car.stuckMs = 0;
    return true;
  }

  /** Queue a racer input plus redundant earlier inputs (only those not seen yet). */
  pushInputs(teamId: string, inputs: { seq: number; input: VehicleInput }[]): number {
    let accepted = 0;
    for (const i of [...inputs].sort((a, b) => a.seq - b.seq)) if (this.pushInput(teamId, i.seq, i.input)) accepted++;
    return accepted;
  }

  step() {
    const dt = SIM_DT;
    this.contacts = [];
    for (const car of this.cars.values()) {
      car.inputBudget = Math.min(INPUT_BUDGET_MAX, car.inputBudget + 1);
      if (car.auto) {
        while (car.queue.length) {
          const e = car.queue.shift()!;
          car.ackSeq = e.seq;
          car.lastInput = e.input;
        }
        car.ticksSinceInput = 0;
        const a = car.auto;
        const end = a.path[a.path.length - 1]!.d;
        if (this.simMs >= a.startAtSimMs) a.s = Math.min(end, a.s + a.speed * dt);
        this.placeOnPath(car);
        this.checkCheckpoint(car);
        if (a.kind === 'escort' && a.s >= end) {
          car.auto = null;
          car.state = { ...car.state, vx: 0, vz: 0 };
          if (!car.arrival) {
            car.arrival = { mode: 'escort', tick: this.tick };
            this.arrivals.push({ teamId: car.teamId, mode: 'escort', tick: this.tick });
          }
        }
        continue;
      }
      if (car.held) {
        // Held cars don't drive; their inputs are acknowledged (client knows via `hd`) so prediction stays exact.
        while (car.queue.length) {
          const e = car.queue.shift()!;
          car.ackSeq = e.seq;
          car.lastInput = e.input;
        }
        car.ticksSinceInput = 0;
        car.state = { ...car.state, x: car.held.x, z: car.held.z, heading: car.held.heading, vx: 0, vz: 0 };
        car.braking = false;
        if (car.held.reason === 'safe' && car.held.until !== undefined && this.simMs >= car.held.until) {
          car.held = null; // Driver safe-hold expires on its own (bounded)
          continue;
        }
        if (car.held.reason === 'recovery' && car.held.until !== undefined && this.simMs >= car.held.until) {
          car.state = { ...car.state, fuel: car.state.fuel + BALANCE.recovery.fuelPct };
          car.held = null;
          this.recoveries.push({ teamId: car.teamId, tick: this.tick });
        }
        continue;
      }
      // Every received input is applied exactly once, in order — this is what makes client prediction exact.
      // Empty queue (jitter): the car waits for its input. Backlog: catch up by at most 2 inputs per tick.
      const n = car.queue.length >= 3 ? MAX_STEPS_PER_TICK : car.queue.length;
      if (n === 0) {
        car.ticksSinceInput++;
        // Connection gone > 1 s: server AI brakes the car (not acknowledged; disclosed in DESIGN §4).
        // ≤ 3 ticks: hold (jitter buffer). Then extrapolate with the last input (connection trouble; the
        // client will be corrected). > 1 s: connection gone, server AI brakes (DESIGN §4). Neither is acked.
        if (car.ticksSinceInput > STALE_INPUT_TICKS) this.drive(car, { ...NEUTRAL_INPUT, brake: 0.4 }, dt);
        else if (car.ticksSinceInput > HOLD_TICKS) this.drive(car, car.lastInput, dt);
        continue;
      }
      for (let k = 0; k < n; k++) {
        const entry = car.queue.shift()!;
        car.ackSeq = entry.seq;
        car.lastInput = entry.input;
        car.ticksSinceInput = 0;
        this.drive(car, entry.input, dt);
      }
    }
    this.resolveCarCollisions();
    const poses = this.traffic.poses();
    this.resolveTrafficCollisions(poses);
    const obstacles: { x: number; z: number }[] = [...this.cars.values()].map((c) => c.state);
    for (const b of this.barriers) obstacles.push(b);
    this.traffic.step(dt, this.simMs, obstacles);
    this.tick++;
  }

  /* ---------- squad effects on the real car (M4) ---------- */

  addBuff(teamId: string, kind: BuffKind) {
    const car = this.cars.get(teamId);
    if (car) car.buffs.set(kind, Math.max(car.buffs.get(kind) ?? 0, this.simMs) + BUFFS[kind].durationMs);
  }

  activeBuffs(teamId: string): { kind: BuffKind; remainingMs: number }[] {
    const car = this.cars.get(teamId);
    if (!car) return [];
    const out: { kind: BuffKind; remainingMs: number }[] = [];
    for (const [kind, until] of car.buffs) if (until > this.simMs) out.push({ kind, remainingMs: until - this.simMs });
    return out;
  }

  refillNitro(teamId: string) {
    const car = this.cars.get(teamId);
    if (car) car.state = { ...car.state, nitro: 100 };
  }

  patch(teamId: string, amount: number) {
    const car = this.cars.get(teamId);
    if (car) car.state = { ...car.state, health: Math.min(100, car.state.health + amount) };
  }

  private effectiveParams(car: SimCar) {
    if (!car.buffs.size) return car.params;
    const active: BuffKind[] = [];
    for (const [k, until] of car.buffs) if (until > this.simMs) active.push(k);
    return applyBuffs(car.params, active.sort());
  }

  /** One physics step of one car (shared model + static collisions + stuck detection). */
  private drive(car: SimCar, raw: VehicleInput, dt: number) {
    const input = this.released ? raw : NEUTRAL_INPUT;
    const env = driveEnv(isOnRoad(this.net, car.state.x, car.state.z), this.rain);
    let s = stepVehicle(car.state, input, this.effectiveParams(car), env, dt);
    const hit = resolveStatic(s, this.buildingsNear(s.x, s.z), this.net.bounds);
    s = hit.impact > 0 ? applyImpact(hit.state, hit.impact, car.params) : hit.state;
    car.state = s;
    car.braking = input.brake > 0.1 && forwardSpeed(s) > 0.5;
    const v = Math.hypot(s.vx, s.vz);
    if (this.released && input.throttle > 0.5 && v < STUCK.speed) car.stuckMs += SIM_DT_MS;
    else if (v >= STUCK.speed) car.stuckMs = 0;
    if (car.stuckMs >= STUCK.autoMs) this.resetCar(car.teamId, 'auto');
    this.checkCheckpoint(car);
    // Fuel exhaustion → disclosed roadside recovery (never elimination).
    if (car.state.fuel <= 0 && this.released) {
      this.hold(car.teamId, { x: car.state.x, z: car.state.z, heading: car.state.heading }, 'recovery', this.simMs + BALANCE.recovery.delayMs);
      return;
    }
    // Pulling into a service station: slow, inside the zone.
    if (Math.hypot(car.state.vx, car.state.vz) < BALANCE.pit.maxEntrySpeed) {
      const st = this.stationAt(car.state.x, car.state.z);
      if (st) this.pitArrivals.push({ teamId: car.teamId, stationId: st.id });
    }
  }

  /** Checkpoints must be passed in order (gate radius 25 m). Passes are queued for persistence. */
  private checkCheckpoint(car: SimCar) {
    const course = this.courseOf(car);
    const cp = course?.checkpoints[car.nextCp];
    if (!cp) return;
    if (Math.hypot(car.state.x - cp.x, car.state.z - cp.z) > CHECKPOINT_RADIUS) return;
    const escorted = car.auto?.kind === 'escort';
    const clean = !this.penalties.some((p) => p.teamId === car.teamId && p.tick > car.lastPassTick);
    this.checkpointPasses.push({ teamId: car.teamId, checkpointId: cp.id, index: car.nextCp, tick: this.tick, speed: Math.hypot(car.state.vx, car.state.vz), escorted, clean });
    car.lastPassTick = this.tick;
    car.nextCp++;
    // Final checkpoint = the Hexaware gate.
    if (car.nextCp === course!.checkpoints.length && !car.arrival && !escorted) {
      car.arrival = { mode: 'driven', tick: this.tick };
      this.arrivals.push({ teamId: car.teamId, mode: 'driven', tick: this.tick });
    }
  }

  /** Squad car vs squad car: equal-mass, symmetric, server-resolved. Anti-ramming arrives in M3. */
  private resolveCarCollisions() {
    const list = [...this.cars.values()];
    const R2 = 2 * CAR_RADIUS;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (this.isGhost(a) || this.isGhost(b)) continue;
        // Cars inside a station (or held / server-driven) never collide: service and the convoy can't be blocked.
        if (a.held || b.held || a.auto || b.auto || this.stationAt(a.state.x, a.state.z, 6) || this.stationAt(b.state.x, b.state.z, 6)) continue;
        const dx = b.state.x - a.state.x;
        const dz = b.state.z - a.state.z;
        const d = Math.hypot(dx, dz);
        if (d >= R2 || d < 1e-6) continue;
        const nx = dx / d;
        const nz = dz / d;
        const push = (R2 - d) / 2;
        const rv = (b.state.vx - a.state.vx) * nx + (b.state.vz - a.state.vz) * nz;
        const imp = rv < 0 ? -rv * 0.65 : 0;
        // Closing components: how fast each car was moving INTO the other.
        const va = a.state.vx * nx + a.state.vz * nz;
        const vb = -(b.state.vx * nx + b.state.vz * nz);
        a.state = { ...a.state, x: a.state.x - nx * push, z: a.state.z - nz * push, vx: a.state.vx - nx * imp, vz: a.state.vz - nz * imp };
        b.state = { ...b.state, x: b.state.x + nx * push, z: b.state.z + nz * push, vx: b.state.vx + nx * imp, vz: b.state.vz + nz * imp };
        let aggressor: SimCar | null = null;
        if (rv < 0) {
          a.state = applyImpact(a.state, -rv, a.params);
          b.state = applyImpact(b.state, -rv, b.params);
          if (-rv >= RAMMING.minClosingSpeed) {
            if (va > vb * RAMMING.dominance && va > 0) aggressor = a;
            else if (vb > va * RAMMING.dominance && vb > 0) aggressor = b;
          }
        }
        this.contacts.push({
          tick: this.tick,
          a: a.teamId,
          b: b.teamId,
          dvA: [-nx * imp, -nz * imp],
          dvB: [nx * imp, nz * imp],
          closing: Math.max(0, -rv),
          aggressor: aggressor?.teamId ?? null,
        });
        if (aggressor) this.recordRam(aggressor, aggressor === a ? b : a);
      }
  }

  private recordRam(agg: SimCar, victim: SimCar) {
    const key = `${agg.teamId}>${victim.teamId}`;
    const now = this.simMs;
    const hits = (this.ramLog.get(key) ?? []).filter((t) => now - t <= RAMMING.windowMs);
    hits.push(now);
    this.ramLog.set(key, hits);
    if (hits.length >= RAMMING.hits) {
      agg.ghostUntil = now + RAMMING.ghostMs;
      victim.freeReset = true;
      this.ramLog.delete(key);
      const p: Penalty = { teamId: agg.teamId, victimTeamId: victim.teamId, tick: this.tick, reason: 'ramming' };
      this.penalties.push(p);
      this.onPenalty?.(p);
    }
  }

  /** Squad car vs traffic: traffic is kinematic (it yields via its own logic); the car bounces. */
  private resolveTrafficCollisions(poses: { x: number; z: number; type: keyof typeof TRAFFIC_TYPES; heading: number; speed: number }[]) {
    for (const car of this.cars.values()) {
      if (this.isGhost(car) || car.held || car.auto) continue;
      for (const p of poses) {
        const r = TRAFFIC_TYPES[p.type].length / 2;
        const dx = car.state.x - p.x;
        const dz = car.state.z - p.z;
        const d = Math.hypot(dx, dz);
        const min = CAR_RADIUS + Math.min(r, 2.5);
        if (d >= min || d < 1e-6) continue;
        const nx = dx / d;
        const nz = dz / d;
        const tvx = Math.sin(p.heading) * p.speed;
        const tvz = Math.cos(p.heading) * p.speed;
        const rv = (car.state.vx - tvx) * nx + (car.state.vz - tvz) * nz;
        let s = { ...car.state, x: p.x + nx * min, z: p.z + nz * min };
        if (rv < 0) {
          s = { ...s, vx: s.vx - 1.5 * rv * nx, vz: s.vz - 1.5 * rv * nz };
          s = applyImpact(s, -rv, car.params);
        }
        car.state = s;
      }
    }
  }
}
