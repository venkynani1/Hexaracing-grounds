/**
 * Deterministic arcade vehicle model shared by the server (authoritative) and the client (prediction).
 * Pure: (state, input, params, env, dt) → new state. No randomness, no wall-clock.
 *
 * Frame: x = east, z = north (metres). heading 0 = north, increases clockwise (towards east).
 * forward = (sin h, cos h), right = (cos h, −sin h).
 */
import type { VehicleCode } from '../enums';

export interface VehicleParams {
  code: VehicleCode;
  name: string;
  /** Top speed on dry road, m/s. Identical for all cars: they differ in feel, not ceiling (DESIGN §8). */
  maxSpeed: number;
  /** Peak engine acceleration, m/s². */
  engineAccel: number;
  brakeDecel: number;
  reverseMax: number;
  /** Max yaw rate at low speed, rad/s. */
  steerRate: number;
  /** Lateral grip: how fast sideways slip is killed, 1/s. */
  grip: number;
  /** Max lateral acceleration before sliding, m/s². */
  latLimit: number;
  /** Damage divisor: higher = more durable. */
  durability: number;
}

export interface VehicleState {
  x: number;
  z: number;
  heading: number;
  vx: number;
  vz: number;
  /** 0–100 */
  fuel: number;
  health: number;
  tires: number;
  nitro: number;
}

export interface VehicleInput {
  /** −1 (left) … 1 (right) */
  steer: number;
  /** 0 … 1 */
  throttle: number;
  /** 0 … 1 (also reverse when stopped) */
  brake: number;
  nitro: boolean;
  handbrake: boolean;
}

export interface DriveEnv {
  /** Surface × weather grip multiplier (road 1.0, off-road 0.6; rain ×0.8). */
  gripMul: number;
  /** Extra rolling drag off-road. */
  dragMul: number;
}

export const NEUTRAL_INPUT: VehicleInput = { steer: 0, throttle: 0, brake: 0, nitro: false, handbrake: false };

export const VEHICLE_TUNING = {
  dragCoef: 0.0004,
  rolling: 0.35,
  nitroAccel: 6,
  nitroSpeedMul: 1.2,
  nitroBurnPerS: 18,
  nitroRegenPerS: 1.5,
  /** Fuel % per world metre at full throttle: a 30-min course needs ~1 pit stop from the 75% start. */
  fuelPerMetre: 0.003,
  fuelIdlePerS: 0.002,
  /** When the tank is empty the car limps (no elimination; roadside recovery is M6). */
  limpThrottle: 0.15,
  tireWearPerSlip: 0.0045,
  maxDamagePerHit: 15,
  minHealth: 5,
  rainGrip: 0.8,
  offroadGrip: 0.6,
  offroadDrag: 3,
} as const;

const base = { maxSpeed: 44, brakeDecel: 14, reverseMax: 8, latLimit: 9 };

/** Four cars, one performance envelope (provisional; calibrated by simulation in M5). */
export const VEHICLES: Record<VehicleCode, VehicleParams> = {
  vortex_gt: { ...base, code: 'vortex_gt', name: 'Vortex GT', engineAccel: 8.5, steerRate: 1.9, grip: 6, durability: 1.0 },
  thunder_rs: { ...base, code: 'thunder_rs', name: 'Thunder RS', engineAccel: 9.6, steerRate: 1.75, grip: 5.4, durability: 0.95 },
  phantom_x: { ...base, code: 'phantom_x', name: 'Phantom X', engineAccel: 8.0, steerRate: 2.1, grip: 7, latLimit: 10, durability: 0.85 },
  titan_xr: { ...base, code: 'titan_xr', name: 'Titan XR', engineAccel: 7.8, steerRate: 1.8, grip: 6, durability: 1.35 },
};

export function initialVehicleState(x: number, z: number, heading: number, fuel = 75): VehicleState {
  return { x, z, heading, vx: 0, vz: 0, fuel, health: 100, tires: 100, nitro: 100 };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function sanitizeInput(i: Partial<VehicleInput> | undefined): VehicleInput {
  const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : 0);
  return {
    steer: num(i?.steer, -1, 1),
    throttle: num(i?.throttle, 0, 1),
    brake: num(i?.brake, 0, 1),
    nitro: i?.nitro === true,
    handbrake: i?.handbrake === true,
  };
}

export function forwardSpeed(s: VehicleState): number {
  return s.vx * Math.sin(s.heading) + s.vz * Math.cos(s.heading);
}

export function stepVehicle(s: VehicleState, input: VehicleInput, p: VehicleParams, env: DriveEnv, dt: number): VehicleState {
  const T = VEHICLE_TUNING;
  const sinH = Math.sin(s.heading);
  const cosH = Math.cos(s.heading);
  let vf = s.vx * sinH + s.vz * cosH;
  let vr = s.vx * cosH - s.vz * sinH;

  const healthFactor = s.health < 30 ? 0.75 : 1;
  const tireFactor = 0.7 + 0.3 * (s.tires / 100);
  const grip = env.gripMul * tireFactor;
  let throttle = input.throttle;
  if (s.fuel <= 0) throttle = Math.min(throttle, T.limpThrottle);
  const useNitro = input.nitro && s.nitro > 0 && throttle > 0.1 && vf > 1;
  const vmax = p.maxSpeed * healthFactor * (useNitro ? T.nitroSpeedMul : 1);

  // Longitudinal
  let a = 0;
  if (throttle > 0 && vf >= -0.5) a += p.engineAccel * throttle * Math.max(0, 1 - vf / vmax) + (useNitro ? T.nitroAccel : 0);
  if (input.brake > 0) {
    if (vf > 0.3) a -= p.brakeDecel * input.brake * Math.min(1, 0.4 + 0.6 * grip);
    else if (throttle === 0) a -= (vf > -p.reverseMax ? 5 : 0) * input.brake;
  }
  if (input.handbrake && vf > 0) a -= 4;
  const drag = T.dragCoef * vf * Math.abs(vf) + Math.sign(vf) * T.rolling * env.dragMul;
  a -= drag;
  const vfNew = vf + a * dt;
  // Braking must not flip direction within one step.
  vf = input.brake > 0 && vf > 0.3 && vfNew < 0 ? 0 : Math.abs(vfNew) < 0.05 && throttle === 0 ? 0 : vfNew;
  vf = clamp(vf, -p.reverseMax, vmax + 2);

  // Steering (yaw), limited by available lateral grip.
  const speed = Math.abs(vf);
  const lowSpeed = Math.min(1, speed / 4);
  let yaw = input.steer * p.steerRate * lowSpeed / (1 + speed / 30);
  const latMax = (p.latLimit * grip) / Math.max(speed, 1);
  if (!input.handbrake) yaw = clamp(yaw, -latMax, latMax);
  else yaw *= 1.35;
  if (vf < 0) yaw = -yaw;
  const heading = s.heading + yaw * dt;

  // Velocity keeps its world direction while the body rotates; the sideways part (slip) is then
  // bled off by tyre grip. Low grip (rain, off-road, handbrake) → more slip → wider line / drift.
  const wx = vf * sinH + vr * cosH;
  const wz = vf * cosH - vr * sinH;
  const sh = Math.sin(heading);
  const ch = Math.cos(heading);
  const vf2 = wx * sh + wz * ch;
  let vr2 = wx * ch - wz * sh;
  const k = p.grip * grip * (input.handbrake ? 0.15 : 1);
  vr2 = vr2 * Math.max(0, 1 - k * dt);
  vr = vr2;
  const vx = vf2 * sh + vr2 * ch;
  const vz = vf2 * ch - vr2 * sh;

  const dist = Math.hypot(vx, vz) * dt;
  const fuel = Math.max(0, s.fuel - T.fuelIdlePerS * dt - T.fuelPerMetre * dist * (0.35 + 0.65 * throttle));
  const tires = Math.max(0, s.tires - T.tireWearPerSlip * Math.abs(vr) * dt);
  const nitro = useNitro ? Math.max(0, s.nitro - T.nitroBurnPerS * dt) : Math.min(100, s.nitro + T.nitroRegenPerS * dt);

  return { x: s.x + vx * dt, z: s.z + vz * dt, heading: wrapAngle(heading), vx, vz, fuel, health: s.health, tires, nitro };
}

export function wrapAngle(a: number): number {
  const TAU = Math.PI * 2;
  a = a % TAU;
  return a > Math.PI ? a - TAU : a < -Math.PI ? a + TAU : a;
}

/** Bounded collision damage. Health never reaches 0: no elimination. */
export function applyImpact(s: VehicleState, impactSpeed: number, p: VehicleParams): VehicleState {
  const T = VEHICLE_TUNING;
  const dmg = Math.min(T.maxDamagePerHit, (Math.max(0, impactSpeed - 2) * 1.2) / p.durability);
  return { ...s, health: Math.max(T.minHealth, s.health - dmg) };
}

export function driveEnv(onRoad: boolean, rain: boolean): DriveEnv {
  const T = VEHICLE_TUNING;
  return { gripMul: (onRoad ? 1 : T.offroadGrip) * (rain ? T.rainGrip : 1), dragMul: onRoad ? 1 : T.offroadDrag };
}
