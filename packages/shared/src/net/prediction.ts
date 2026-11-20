import type { VehicleCode } from '../enums';
import type { InputMessage, InputTuple, NetCar, Snapshot } from '../protocol';
import { applyImpact, driveEnv, NEUTRAL_INPUT, stepVehicle, VEHICLES, wrapAngle, type VehicleInput, type VehicleState } from '../sim/vehicle';
import { isOnRoad, resolveStatic, type Building, type RoadNetwork } from '../sim/road';
import { applyBuffs, type BuffKind } from '../squad';

const DT = 0.05;

/**
 * Own-car client prediction + server reconciliation (DESIGN §4): the client runs the same shared model,
 * keeps unacknowledged inputs, and on every snapshot rewinds to the authoritative state and replays them.
 * Visual corrections are smoothed (snap if > 5 m).
 */
export class Predictor {
  state: VehicleState | null = null;
  prev: VehicleState | null = null;
  private pending: { seq: number; input: VehicleInput }[] = [];
  seq = 0;
  released = false;
  rain = false;
  /** Visual offset blended out over ~150 ms after a correction. */
  errX = 0;
  errZ = 0;
  errH = 0;
  lastCorrection = 0;
  braking = false;
  /** Server is holding the car (pit / roadside recovery): no movement is predicted. */
  held = false;
  private baseParams = VEHICLES.vortex_gt;
  private params = VEHICLES.vortex_gt;
  private buffKey = '';
  /** Recent inputs, repeated in each message for loss tolerance. */
  private history: InputTuple[] = [];

  private readonly staticNear: (x: number, z: number) => readonly Building[];

  /** `buildings`: a fixed list (test grid) or a lookup of obstacles near a point (procedural cells on real maps). */
  constructor(
    private readonly net: RoadNetwork,
    buildings: readonly Building[] | ((x: number, z: number) => readonly Building[]),
  ) {
    this.staticNear = typeof buildings === 'function' ? buildings : () => buildings;
  }

  private simulate(s: VehicleState, input: VehicleInput): VehicleState {
    if (this.held) return s;
    const env = driveEnv(isOnRoad(this.net, s.x, s.z), this.rain);
    const next = stepVehicle(s, this.released ? input : NEUTRAL_INPUT, this.params, env, DT);
    const hit = resolveStatic(next, this.staticNear(next.x, next.z), this.net.bounds);
    return hit.impact > 0 ? applyImpact(hit.state, hit.impact, this.params) : hit.state;
  }

  /** Advance one fixed step with a fresh input; returns the message to send (with redundancy). */
  stepMessage(input: VehicleInput, redundancy = 3): InputMessage {
    const seq = this.step(input);
    const msg: InputMessage = { t: 'input', seq, st: input.steer, th: input.throttle, br: input.brake, ni: input.nitro, hb: input.handbrake };
    if (redundancy > 0 && this.history.length) msg.r = this.history.slice(-redundancy);
    this.history.push([seq, input.steer, input.throttle, input.brake, (input.nitro ? 1 : 0) | (input.handbrake ? 2 : 0)]);
    if (this.history.length > 8) this.history.shift();
    return msg;
  }

  /** Advance one fixed step with a fresh input; returns the seq. */
  step(input: VehicleInput): number {
    const seq = ++this.seq;
    this.braking = input.brake > 0.1;
    if (!this.state) return seq;
    this.pending.push({ seq, input });
    if (this.pending.length > 100) this.pending.shift();
    this.prev = this.state;
    this.state = this.simulate(this.state, input);
    return seq;
  }

  onSnapshot(snap: Snapshot) {
    this.released = snap.released;
    this.rain = snap.rain;
    if (!snap.me) return;
    const vc = snap.me.vc as VehicleCode;
    const buffs = (snap.me.bf ?? []).map(([k]) => k as BuffKind).sort();
    const key = `${vc}:${buffs.join(',')}`;
    if (key !== this.buffKey && VEHICLES[vc]) {
      this.buffKey = key;
      this.baseParams = VEHICLES[vc];
      this.params = applyBuffs(this.baseParams, buffs);
    }
    const auth = fromNet(snap.me);
    this.held = snap.me.hd === true;
    if (!this.state) {
      this.state = auth;
      this.prev = auth;
      return;
    }
    this.pending = this.pending.filter((p) => p.seq > snap.ack);
    let s = auth;
    for (const p of this.pending) s = this.simulate(s, p.input);
    const dx = this.state.x - s.x;
    const dz = this.state.z - s.z;
    const err = Math.hypot(dx, dz);
    this.lastCorrection = err;
    if (err > 5) {
      this.errX = this.errZ = this.errH = 0;
      this.prev = s;
    } else {
      this.errX += dx;
      this.errZ += dz;
      this.errH += wrapAngle(this.state.heading - s.heading);
    }
    this.state = s;
  }

  /** Render pose: interpolate between the last two predicted steps, plus decaying correction offset. */
  renderPose(alpha: number, frameDt: number) {
    if (!this.state) return null;
    const p = this.prev ?? this.state;
    const k = Math.exp(-frameDt / 0.08);
    this.errX *= k;
    this.errZ *= k;
    this.errH *= k;
    return {
      x: p.x + (this.state.x - p.x) * alpha + this.errX,
      z: p.z + (this.state.z - p.z) * alpha + this.errZ,
      heading: p.heading + wrapAngle(this.state.heading - p.heading) * alpha + this.errH,
      state: this.state,
    };
  }
}

export function fromNet(c: NetCar): VehicleState {
  return { x: c.x, z: c.z, heading: c.h, vx: c.vx, vz: c.vz, fuel: c.f, health: c.hp, tires: c.tr, nitro: c.ni };
}

export interface RemotePose {
  x: number;
  z: number;
  heading: number;
}

/** Interpolation buffer for remote entities (other squad cars, traffic): render ~100 ms in the past. */
export class Interpolator<T extends RemotePose & { id: string | number }> {
  private frames: { t: number; items: Map<string | number, T> }[] = [];
  constructor(private readonly delayMs = 100) {}

  push(serverTime: number, items: T[]) {
    this.frames.push({ t: serverTime, items: new Map(items.map((i) => [i.id, i])) });
    while (this.frames.length > 30) this.frames.shift();
  }

  /** Latest raw frame (no interpolation). */
  latest(): T[] {
    const f = this.frames[this.frames.length - 1];
    return f ? [...f.items.values()] : [];
  }

  sample(serverNow: number): T[] {
    const rt = serverNow - this.delayMs;
    const f = this.frames;
    if (!f.length) return [];
    let i = f.length - 1;
    while (i > 0 && f[i]!.t > rt) i--;
    const a = f[i]!;
    const b = f[i + 1];
    if (!b) return [...a.items.values()];
    const alpha = Math.max(0, Math.min(1, (rt - a.t) / Math.max(1, b.t - a.t)));
    const out: T[] = [];
    for (const [id, nb] of b.items) {
      const na = a.items.get(id);
      if (!na) {
        out.push(nb);
        continue;
      }
      out.push({ ...nb, x: na.x + (nb.x - na.x) * alpha, z: na.z + (nb.z - na.z) * alpha, heading: na.heading + wrapAngle(nb.heading - na.heading) * alpha });
    }
    return out;
  }
}
