import type { EventStatus, Role } from './enums';
import type { PhaseId } from './timeline';
import type { BuffKind, SquadView } from './squad';

/* ---------------- HTTP DTOs ---------------- */

export interface CreateSquadRequest {
  squadName: string;
  displayName: string;
}
export interface JoinSquadRequest {
  code: string;
  displayName: string;
  role: Role;
}
export interface SessionResponse {
  /** Short-lived signed session token (Authorization: Bearer / WS hello). */
  sessionToken: string;
  /** Long-lived signed rejoin credential, kept in localStorage. */
  rejoinToken: string;
  playerId: string;
  teamId: string;
  joinCode: string;
  role: Role;
  slot: number;
}
export interface SquadPreview {
  joinCode: string;
  name: string;
  freeRoles: Role[];
  full: boolean;
}
export interface RoleAssignment {
  playerId: string;
  role: Role;
}

export interface RosterPlayer {
  playerId: string;
  slot: number;
  role: Role;
  displayName: string;
  connected: boolean;
}
export interface Roster {
  teamId: string;
  name: string;
  joinCode: string;
  startLocation: string | null;
  players: RosterPlayer[];
  full: boolean;
}

export interface ClockState {
  status: EventStatus;
  /** Server wall time when this state was computed. */
  serverTime: number;
  /** Remaining countdown ms (only meaningful in COUNTDOWN, or PAUSED-from-countdown). */
  countdownRemainingMs: number;
  /** LIVE elapsed ms (0 before LIVE). */
  elapsedMs: number;
  phase: PhaseId | null;
  paused: boolean;
}

export interface HostOverview {
  eventId: string;
  eventName: string;
  clock: ClockState;
  squads: (Roster & { ready: boolean })[];
  squadCount: number;
  playerCount: number;
  connectedCount: number;
  maxSquads: number;
  canStart: boolean;
  startBlockers: string[];
  health: { db: boolean; tickHz: number; tickP99Ms: number; uptimeS: number };
}

export interface ApiError {
  error: string;
  message: string;
}

/* ---------------- WebSocket messages (JSON, low-rate) ---------------- */

/** [seq, steer, throttle, brake, flags(bit0 nitro, bit1 handbrake)] */
export type InputTuple = [number, number, number, number, number];

/**
 * Racer input for one 50 ms simulation step. seq must strictly increase (replays are dropped).
 * `r` repeats the previous few inputs so a single lost packet doesn't lose a step (DESIGN §4).
 */
export interface InputMessage {
  t: 'input';
  seq: number;
  st: number;
  th: number;
  br: number;
  ni?: boolean;
  hb?: boolean;
  r?: InputTuple[];
}

export type ClientMessage =
  | { t: 'hello'; sessionToken: string }
  | { t: 'host_hello'; hostKey: string }
  | { t: 'ping'; clientTime: number }
  | { t: 'reset' }
  | InputMessage;

/** Full state of a squad car (own car / role telemetry). Positions rounded to 1 cm. */
export interface NetCar {
  /** Compact car id (1..30), stable for the event. */
  cid: number;
  id: string;
  n: string;
  vc: string;
  x: number;
  z: number;
  h: number;
  vx: number;
  vz: number;
  f: number;
  hp: number;
  tr: number;
  ni: number;
  /** braking (for brake lights) */
  br: boolean;
  /** ghosted (anti-ramming): visible, non-collidable */
  g: boolean;
  /** a safe reset is available (stuck, or victim of ramming) */
  rs: boolean;
  /** active buffs [kind, remaining ms] — client prediction applies the same modifiers */
  bf: [BuffKind, number][];
  /** course code (start location) and index of the next checkpoint (== count passed) */
  cs: string;
  cp: number;
}

export const CAR_FLAG_BRAKING = 1;
export const CAR_FLAG_GHOST = 2;
/** Near/mid tier entry: [cid, x, z, heading, speed, flags] — names come from the map channel. */
export type NetCarLite = [number, number, number, number, number, number];
/** Global map channel entry (every squad, always): [cid, teamId, squadName, x, z, heading] */
export type MapCar = [number, string, string, number, number, number];
/** [id, typeCode, x, z, heading] */
export type NetTraffic = [number, number, number, number, number];

export interface Snapshot {
  t: 'snap';
  tick: number;
  simMs: number;
  serverTime: number;
  rain: boolean;
  released: boolean;
  /** Last input seq applied to `me` (for client reconciliation). */
  ack: number;
  me: NetCar | null;
  /** Near tier every tick, mid tier every 4th tick (DESIGN §5). */
  cars: NetCarLite[];
  traffic: NetTraffic[];
}

export interface MapMessage {
  t: 'map';
  tick: number;
  serverTime: number;
  cars: MapCar[];
}

export interface WorldInfo {
  seed: string;
  mapVersion: string;
  map: 'test' | 'chennai';
}

export interface StartLocationInfo {
  code: string;
  name: string;
  verified: boolean;
  /** selectable = verified AND enabled AND below capacity */
  selectable: boolean;
  taken: number;
  capacity: number;
  reason?: string;
  via: string[];
  courseKm: number;
}

export interface WorldStatus {
  tick: number;
  simMs: number;
  released: boolean;
  rain: boolean;
  tickHz: number;
  tickP99Ms: number;
  trafficCount: number;
  cars: { cid: number; teamId: string; name: string; x: number; z: number; heading: number; speed: number; fuel: number; health: number; ghost: boolean }[];
  penalties: { teamId: string; victimTeamId: string; tick: number; reason: string }[];
}

export type ServerMessage =
  | { t: 'welcome'; kind: 'player'; playerId: string; roomId: string; roster: Roster; clock: ClockState; world: WorldInfo }
  | { t: 'welcome'; kind: 'host'; roomId: string; overview: HostOverview }
  | { t: 'roster'; roster: Roster }
  | { t: 'overview'; overview: HostOverview }
  | { t: 'clock'; clock: ClockState }
  | { t: 'pong'; clientTime: number; serverTime: number }
  | Snapshot
  | { t: 'car'; tick: number; car: NetCar; released: boolean }
  | MapMessage
  | { t: 'squad'; view: SquadView }
  | { t: 'error'; error: string; message: string };
