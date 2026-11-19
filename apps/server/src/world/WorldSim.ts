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
const MAX_QUEUE = 4;

export interface SimCar {
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
      });
    });
  }

  /** Queue a racer input. Rejects replayed / out-of-order seq. Returns false when rejected. */
  pushInput(teamId: string, seq: number, input: VehicleInput): boolean {
    const car = this.cars.get(teamId);
    if (!car || !Number.isSafeInteger(seq) || seq <= car.lastSeq) return false;
    car.lastSeq = seq;
    car.queue.push({ seq, input });
    if (car.queue.length > MAX_QUEUE) car.queue.splice(0, car.queue.length - MAX_QUEUE);
    return true;
  }

  step() {
    const dt = SIM_DT;
    for (const car of this.cars.values()) {
      const entry = car.queue.shift();
      let input: VehicleInput;
      if (entry) {
        car.ackSeq = entry.seq;
        car.lastInput = entry.input;
        car.ticksSinceInput = 0;
        input = entry.input;
      } else {
        car.ticksSinceInput++;
        input = car.ticksSinceInput > STALE_INPUT_TICKS ? { ...NEUTRAL_INPUT, brake: 0.4 } : car.lastInput;
      }
      if (!this.released) input = NEUTRAL_INPUT;
      const env = driveEnv(isOnRoad(this.net, car.state.x, car.state.z), this.rain);
      let s = stepVehicle(car.state, input, car.params, env, dt);
      const hit = resolveStatic(s, this.buildings, this.net.bounds);
      s = hit.impact > 0 ? applyImpact(hit.state, hit.impact, car.params) : hit.state;
      car.state = s;
      car.braking = input.brake > 0.1 && forwardSpeed(s) > 0.5;
    }
    this.resolveCarCollisions();
    const poses = this.traffic.poses();
    this.resolveTrafficCollisions(poses);
    const obstacles = [...this.cars.values()].map((c) => c.state);
    this.traffic.step(dt, this.simMs, obstacles);
    this.tick++;
  }

  /** Squad car vs squad car: equal-mass, symmetric, server-resolved. Anti-ramming arrives in M3. */
  private resolveCarCollisions() {
    const list = [...this.cars.values()];
    const R2 = 2 * CAR_RADIUS;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const dx = b.state.x - a.state.x;
        const dz = b.state.z - a.state.z;
        const d = Math.hypot(dx, dz);
        if (d >= R2 || d < 1e-6) continue;
        const nx = dx / d;
        const nz = dz / d;
        const push = (R2 - d) / 2;
        const rv = (b.state.vx - a.state.vx) * nx + (b.state.vz - a.state.vz) * nz;
        const imp = rv < 0 ? -rv * 0.65 : 0;
        a.state = { ...a.state, x: a.state.x - nx * push, z: a.state.z - nz * push, vx: a.state.vx - nx * imp, vz: a.state.vz - nz * imp };
        b.state = { ...b.state, x: b.state.x + nx * push, z: b.state.z + nz * push, vx: b.state.vx + nx * imp, vz: b.state.vz + nz * imp };
        if (rv < 0) {
          a.state = applyImpact(a.state, -rv, a.params);
          b.state = applyImpact(b.state, -rv, b.params);
        }
      }
  }

  /** Squad car vs traffic: traffic is kinematic (it yields via its own logic); the car bounces. */
  private resolveTrafficCollisions(poses: { x: number; z: number; type: keyof typeof TRAFFIC_TYPES; heading: number; speed: number }[]) {
    for (const car of this.cars.values()) {
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
