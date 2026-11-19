/** Squad roles. Slot numbers are the *initial* slot for a role (P1..P4). */
export const ROLES = ['RACER', 'ENGINEER', 'DECEIVER', 'CAPTAIN'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_DEFAULT_SLOT: Record<Role, 1 | 2 | 3 | 4> = {
  RACER: 1,
  ENGINEER: 2,
  DECEIVER: 3,
  CAPTAIN: 4,
};

export const ROLE_LABEL: Record<Role, string> = {
  RACER: 'P1 — Racer',
  ENGINEER: 'P2 — Engineer',
  DECEIVER: 'P3 — Deceiver',
  CAPTAIN: 'P4 — Captain',
};

export function isRole(x: unknown): x is Role {
  return typeof x === 'string' && (ROLES as readonly string[]).includes(x);
}

/** Event lifecycle (DESIGN §7). */
export const EVENT_STATUSES = [
  'DRAFT',
  'REGISTRATION_OPEN',
  'REGISTRATION_LOCKED',
  'COUNTDOWN',
  'LIVE',
  'PAUSED',
  'RECOVERING',
  'FINISHED',
  'ARCHIVED',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const SCORING_CATEGORIES = [
  'DRIVING',
  'CODING',
  'DECEPTION',
  'CAPTAIN_STRATEGY',
  'TEAM_ASSESSMENTS',
  'FUEL_MANAGEMENT',
  'HEXAWARE_GATE',
] as const;
export type ScoringCategory = (typeof SCORING_CATEGORIES)[number];

export const VEHICLE_CODES = ['vortex_gt', 'thunder_rs', 'phantom_x', 'titan_xr'] as const;
export type VehicleCode = (typeof VEHICLE_CODES)[number];
