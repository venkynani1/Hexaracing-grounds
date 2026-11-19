import {
  BALANCE,
  CAR_RADIUS,
  NEUTRAL_INPUT,
  SPAWN_DE,
  TRAFFIC_TYPES,
  TrafficSystem,
  VEHICLES,
  applyImpact,
  createTestNetwork,
  driveEnv,
  forwardSpeed,
  generateBuildings,
  initialVehicleState,
  isOnRoad,
  lanePoint,
  deHeading,
  wrapAngle,
  resolveStatic,
  spawnSlots,
  stepVehicle,
  type Building,
  type RoadNetwork,
  type VehicleCode,
  type VehicleInput,
  type VehicleParams,
  type VehicleState,
} from '@redline/shared';

export const SIM_DT = 0.05;
export const SIM_DT_MS = 50;
/** Inputs older than this many ticks → the car is treated as disconnected and AI-brakes (DESIGN §4). */
const STALE_INPUT_TICKS = 20;
const MAX_QUEUE = 6;
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
  readonly net: RoadNetwork;
  readonly buildings: Building[];
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

  constructor(readonly opts: { seed: string; trafficCount?: number }) {
    this.net = createTestNetwork();
    this.buildings = generateBuildings(this.net, opts.seed);
    this.traffic = new TrafficSystem(this.net, {
      seed: opts.seed,
      count: opts.trafficCount ?? BALANCE.trafficAgents,
      excludeDe: [SPAWN_DE],
    });
  }

  get simMs() {
    return this.tick * SIM_DT_MS;
  }

  /** Place squad cars on the spawn grid in registration order (deterministic). Idempotent per team. */
  spawn(teams: { teamId: string; name: string; vehicle?: VehicleCode | null }[]) {
    const slots = spawnSlots(this.net, BALANCE.maxSquads, SPAWN_DE);
    teams.forEach((t, i) => {
      if (this.cars.has(t.teamId)) return;
      const slot = slots[i % slots.length]!;
      const params = VEHICLES[t.vehicle ?? 'vortex_gt'];
      this.cars.set(t.teamId, {
        cid: this.cars.size + 1,
        teamId: t.teamId,
        name: t.name,
        params,
        state: initialVehicleState(slot.x, slot.z, slot.heading, BALANCE.startFuelPct),
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
      });
    });
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
    let best = { de: 0, s: 0, d: Infinity };
    for (const e of net.edges) {
      const a = net.nodes[e.a]!;
      const b = net.nodes[e.b]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((car.state.x - a.x) * dx + (car.state.z - a.z) * dz) / (dx * dx + dz * dz)));
      const d = Math.hypot(car.state.x - (a.x + dx * t), car.state.z - (a.z + dz * t));
      if (d < best.d) {
        const fwd = Math.abs(wrapAngle(deHeading(net, e.id * 2) - car.state.heading)) <= Math.PI / 2;
        best = { de: fwd ? e.id * 2 : e.id * 2 + 1, s: fwd ? t * e.length : (1 - t) * e.length, d };
      }
    }
    const len = net.edges[best.de >> 1]!.length;
    let s = Math.max(net.junctionRadius + 3, Math.min(len - net.junctionRadius - 3, best.s));
    let p = lanePoint(net, best.de, 0, s);
    for (let i = 0; i < 12; i++) {
      const clear = [...this.cars.values()].every((o) => o === car || Math.hypot(o.state.x - p.x, o.state.z - p.z) > 6);
      if (clear) break;
      s = Math.min(len - net.junctionRadius - 3, s + 8);
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
    const obstacles = [...this.cars.values()].map((c) => c.state);
    this.traffic.step(dt, this.simMs, obstacles);
    this.tick++;
  }

  /** One physics step of one car (shared model + static collisions + stuck detection). */
  private drive(car: SimCar, raw: VehicleInput, dt: number) {
    const input = this.released ? raw : NEUTRAL_INPUT;
    const env = driveEnv(isOnRoad(this.net, car.state.x, car.state.z), this.rain);
    let s = stepVehicle(car.state, input, car.params, env, dt);
    const hit = resolveStatic(s, this.buildings, this.net.bounds);
    s = hit.impact > 0 ? applyImpact(hit.state, hit.impact, car.params) : hit.state;
    car.state = s;
    car.braking = input.brake > 0.1 && forwardSpeed(s) > 0.5;
    const v = Math.hypot(s.vx, s.vz);
    if (this.released && input.throttle > 0.5 && v < STUCK.speed) car.stuckMs += SIM_DT_MS;
    else if (v >= STUCK.speed) car.stuckMs = 0;
    if (car.stuckMs >= STUCK.autoMs) this.resetCar(car.teamId, 'auto');
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
      if (this.isGhost(car)) continue;
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
