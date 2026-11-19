import type { EventStatus, Role } from './enums';
import type { PhaseId } from './timeline';

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

/** Racer input for one 50 ms simulation step. seq must strictly increase (replays are dropped). */
export interface InputMessage {
  t: 'input';
  seq: number;
  st: number;
  th: number;
  br: number;
  ni?: boolean;
  hb?: boolean;
}

export type ClientMessage =
  | { t: 'hello'; sessionToken: string }
  | { t: 'host_hello'; hostKey: string }
  | { t: 'ping'; clientTime: number }
  | InputMessage;

/** Full state of a squad car (own car / role telemetry). Positions rounded to 1 cm. */
export interface NetCar {
  id: string;
  n: string;
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
}
/** [teamId, squadName, x, z, heading, speed, braking 0|1] */
export type NetCarLite = [string, string, number, number, number, number, number];
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
  cars: NetCarLite[];
  traffic: NetTraffic[];
}

export interface WorldInfo {
  seed: string;
  mapVersion: string;
}

export interface WorldStatus {
  tick: number;
  simMs: number;
  released: boolean;
  rain: boolean;
  tickHz: number;
  tickP99Ms: number;
  trafficCount: number;
  cars: { teamId: string; name: string; x: number; z: number; heading: number; speed: number; fuel: number; health: number }[];
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
  | { t: 'cars'; tick: number; cars: NetCarLite[] }
  | { t: 'error'; error: string; message: string };
