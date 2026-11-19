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
  health: { db: boolean; tickHz: number; uptimeS: number };
}

export interface ApiError {
  error: string;
  message: string;
}

/* ---------------- WebSocket messages (JSON, low-rate) ---------------- */

export type ClientMessage =
  | { t: 'hello'; sessionToken: string }
  | { t: 'host_hello'; hostKey: string }
  | { t: 'ping'; clientTime: number };

export type ServerMessage =
  | { t: 'welcome'; kind: 'player'; playerId: string; roomId: string; roster: Roster; clock: ClockState }
  | { t: 'welcome'; kind: 'host'; roomId: string; overview: HostOverview }
  | { t: 'roster'; roster: Roster }
  | { t: 'overview'; overview: HostOverview }
  | { t: 'clock'; clock: ClockState }
  | { t: 'pong'; clientTime: number; serverTime: number }
  | { t: 'error'; error: string; message: string };
