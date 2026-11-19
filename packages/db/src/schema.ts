/**
 * Neon PostgreSQL schema (DESIGN §6). Live simulation state lives in server memory;
 * these tables hold registration, checkpoints, scoring events, snapshots and audit.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { EVENT_STATUSES, ROLES, SCORING_CATEGORIES } from '@redline/shared';

export const eventStatusEnum = pgEnum('event_status', EVENT_STATUSES);
export const roleEnum = pgEnum('player_role', ROLES);
export const scoringCategoryEnum = pgEnum('scoring_category', SCORING_CATEGORIES);
export const challengeTypeEnum = pgEnum('challenge_type', ['coding', 'logic', 'truth', 'navigation', 'four_key', 'gate']);
export const actorTypeEnum = pgEnum('actor_type', ['system', 'host', 'player', 'director']);

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const events = pgTable('events', {
  id: id(),
  name: text('name').notNull(),
  status: eventStatusEnum('status').notNull().default('REGISTRATION_OPEN'),
  seed: bigint('seed', { mode: 'bigint' }).notNull(),
  /** Wall time START was pressed (clock origin, before countdown). */
  startedAt: ts('started_at'),
  /** Total paused ms accumulated so far (excluding a pause in progress). */
  pausedMs: bigint('paused_ms', { mode: 'number' }).notNull().default(0),
  /** Set while paused. */
  pausedAt: ts('paused_at'),
  hostKeyHash: text('host_key_hash'),
  createdAt: createdAt(),
});

export const vehicles = pgTable('vehicles', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  stats: jsonb('stats').notNull(),
  balanceVersion: integer('balance_version').notNull().default(1),
  createdAt: createdAt(),
});

export const startLocations = pgTable('start_locations', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  lat: doublePrecision('lat'),
  lon: doublePrecision('lon'),
  worldX: doublePrecision('world_x'),
  worldZ: doublePrecision('world_z'),
  /** Only selectable once coordinates and route are verified (M5). */
  enabled: boolean('enabled').notNull().default(false),
  verifiedAt: ts('verified_at'),
  maxSquads: integer('max_squads').notNull().default(6),
  createdAt: createdAt(),
});

export const teams = pgTable(
  'teams',
  {
    id: id(),
    eventId: uuid('event_id').notNull().references(() => events.id),
    name: text('name').notNull(),
    joinCode: char('join_code', { length: 6 }).notNull(),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id),
    startLocationId: uuid('start_location_id').references(() => startLocations.id),
    paint: text('paint'),
    ready: boolean('ready').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('teams_event_code_uq').on(t.eventId, t.joinCode),
    uniqueIndex('teams_event_name_uq').on(t.eventId, sql`lower(${t.name})`),
  ],
);

export const players = pgTable(
  'players',
  {
    id: id(),
    teamId: uuid('team_id').notNull().references(() => teams.id),
    slot: smallint('slot').notNull(),
    role: roleEnum('role').notNull(),
    displayName: text('display_name').notNull(),
    rejoinSecretHash: text('rejoin_secret_hash').notNull(),
    connectedAt: ts('connected_at'),
    lastSeenAt: ts('last_seen_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('players_team_slot_uq').on(t.teamId, t.slot),
    // Made DEFERRABLE INITIALLY DEFERRED in migration 0001 so role swaps can run in one transaction.
    unique('players_team_role_uq').on(t.teamId, t.role),
    index('players_team_idx').on(t.teamId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    eventId: uuid('event_id').notNull().references(() => events.id),
    playerId: uuid('player_id').references(() => players.id),
    isHost: boolean('is_host').notNull().default(false),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_player_idx').on(t.playerId)],
);

export const carSelections = pgTable('car_selections', {
  id: id(),
  teamId: uuid('team_id').notNull().references(() => teams.id),
  vehicleId: uuid('vehicle_id').notNull().references(() => vehicles.id),
  paint: text('paint'),
  selectedByPlayerId: uuid('selected_by_player_id').references(() => players.id),
  selectedAt: ts('selected_at').notNull().defaultNow(),
  createdAt: createdAt(),
});

export const worldMetadata = pgTable('world_metadata', {
  id: id(),
  eventId: uuid('event_id').notNull().references(() => events.id),
  anchorLat: doublePrecision('anchor_lat'),
  anchorLon: doublePrecision('anchor_lon'),
  worldScale: doublePrecision('world_scale').notNull().default(8),
  mapVersion: text('map_version').notNull(),
  osmAttribution: text('osm_attribution').notNull().default('© OpenStreetMap contributors, ODbL'),
  createdAt: createdAt(),
});

export const roadSegments = pgTable(
  'road_segments',
  {
    id: id(),
    mapVersion: text('map_version').notNull(),
    edgeId: integer('edge_id').notNull(),
    fromNode: integer('from_node').notNull(),
    toNode: integer('to_node').notNull(),
    lengthM: doublePrecision('length_m').notNull(),
    lanes: smallint('lanes').notNull(),
    speedClass: smallint('speed_class').notNull(),
    cellX: integer('cell_x').notNull(),
    cellZ: integer('cell_z').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('road_segments_version_edge_uq').on(t.mapVersion, t.edgeId)],
);

export const challenges = pgTable('challenges', {
  id: id(),
  eventId: uuid('event_id').notNull().references(() => events.id),
  code: text('code').notNull(),
  type: challengeTypeEnum('type').notNull(),
  phase: text('phase').notNull(),
  /** Public payload only — never answers. */
  payload: jsonb('payload').notNull(),
  answerHash: text('answer_hash').notNull(),
  maxPoints: integer('max_points').notNull(),
  category: scoringCategoryEnum('category').notNull(),
  createdAt: createdAt(),
});

export const challengeClues = pgTable(
  'challenge_clues',
  {
    id: id(),
    challengeId: uuid('challenge_id').notNull().references(() => challenges.id),
    teamId: uuid('team_id').notNull().references(() => teams.id),
    role: roleEnum('role').notNull(),
    clueCiphertext: text('clue_ciphertext').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('challenge_clues_uq').on(t.challengeId, t.teamId, t.role)],
);

/** Per-squad variant of a challenge (seeded parameters): public prompt + hashed answer. */
export const challengeVariants = pgTable(
  'challenge_variants',
  {
    id: id(),
    challengeId: uuid('challenge_id').notNull().references(() => challenges.id),
    teamId: uuid('team_id').notNull().references(() => teams.id),
    payload: jsonb('payload').notNull(),
    answerHash: text('answer_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('challenge_variants_uq').on(t.challengeId, t.teamId)],
);

export const challengeSubmissions = pgTable(
  'challenge_submissions',
  {
    id: id(),
    challengeId: uuid('challenge_id').notNull().references(() => challenges.id),
    teamId: uuid('team_id').notNull().references(() => teams.id),
    playerId: uuid('player_id').notNull().references(() => players.id),
    answer: text('answer').notNull(),
    correct: boolean('correct').notNull(),
    points: integer('points').notNull().default(0),
    submittedAt: ts('submitted_at').notNull().defaultNow(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [index('challenge_submissions_ct_idx').on(t.challengeId, t.teamId)],
);

export const bluffRounds = pgTable('bluff_rounds', {
  id: id(),
  eventId: uuid('event_id').notNull().references(() => events.id),
  prompt: text('prompt').notNull(),
  trueAnswerHash: text('true_answer_hash').notNull(),
  opensAt: ts('opens_at').notNull(),
  closesAt: ts('closes_at').notNull(),
  status: text('status').notNull().default('scheduled'),
  createdAt: createdAt(),
});

export const bluffEntries = pgTable(
  'bluff_entries',
  {
    id: id(),
    roundId: uuid('round_id').notNull().references(() => bluffRounds.id),
    teamId: uuid('team_id').notNull().references(() => teams.id),
    playerId: uuid('player_id').notNull().references(() => players.id),
    fakeAnswer: text('fake_answer').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('bluff_entries_round_team_uq').on(t.roundId, t.teamId)],
);

export const bluffVotes = pgTable(
  'bluff_votes',
  {
    id: id(),
    roundId: uuid('round_id').notNull().references(() => bluffRounds.id),
    voterTeamId: uuid('voter_team_id').notNull().references(() => teams.id),
    voterPlayerId: uuid('voter_player_id').notNull().references(() => players.id),
    /** bluff_entries.id, or null for the true answer. */
    choiceId: uuid('choice_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('bluff_votes_round_voter_uq').on(t.roundId, t.voterPlayerId)],
);

export const fuelTransactions = pgTable('fuel_transactions', {
  id: id(),
  teamId: uuid('team_id').notNull().references(() => teams.id),
  deltaFuel: doublePrecision('delta_fuel').notNull(),
  reason: text('reason').notNull(),
  creditsDelta: integer('credits_delta').notNull().default(0),
  atTick: integer('at_tick').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  createdAt: createdAt(),
});

export const pitStops = pgTable('pit_stops', {
  id: id(),
  teamId: uuid('team_id').notNull().references(() => teams.id),
  stationId: text('station_id').notNull(),
  stage: text('stage').notNull(),
  startedAt: ts('started_at').notNull(),
  completedAt: ts('completed_at'),
  outcome: jsonb('outcome'),
  createdAt: createdAt(),
});

export const vehicleCheckpoints = pgTable(
  'vehicle_checkpoints',
  {
    id: id(),
    teamId: uuid('team_id').notNull().references(() => teams.id),
    checkpointId: text('checkpoint_id').notNull(),
    tick: integer('tick').notNull(),
    elapsedMs: integer('elapsed_ms').notNull(),
    speed: doublePrecision('speed').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('vehicle_checkpoints_team_cp_uq').on(t.teamId, t.checkpointId)],
);

export const scoringEvents = pgTable(
  'scoring_events',
  {
    id: id(),
    teamId: uuid('team_id').notNull().references(() => teams.id),
    category: scoringCategoryEnum('category').notNull(),
    points: integer('points').notNull(),
    reason: text('reason').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    tick: integer('tick').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('scoring_events_source_uq').on(t.sourceType, t.sourceId, t.teamId),
    index('scoring_events_team_cat_idx').on(t.teamId, t.category),
  ],
);

export const eventStates = pgTable(
  'event_states',
  {
    id: id(),
    eventId: uuid('event_id').notNull().references(() => events.id),
    status: eventStatusEnum('status').notNull(),
    phase: text('phase'),
    directorTick: integer('director_tick').notNull().default(0),
    elapsedMs: bigint('elapsed_ms', { mode: 'number' }).notNull().default(0),
    transitionedAt: ts('transitioned_at').notNull().defaultNow(),
    cause: text('cause').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('event_states_event_idx').on(t.eventId, t.transitionedAt)],
);

export const recoverySnapshots = pgTable(
  'recovery_snapshots',
  {
    id: id(),
    eventId: uuid('event_id').notNull().references(() => events.id),
    tick: integer('tick').notNull(),
    phase: text('phase'),
    state: jsonb('state').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('recovery_snapshots_event_idx').on(t.eventId, t.createdAt)],
);

export const offerLetters = pgTable('offer_letters', {
  id: id(),
  playerId: uuid('player_id').notNull().references(() => players.id).unique(),
  achievement: text('achievement').notNull(),
  finalScore: integer('final_score').notNull(),
  arrivalStatus: text('arrival_status').notNull(),
  pdfUrl: text('pdf_url'),
  generatedAt: ts('generated_at').notNull().defaultNow(),
  createdAt: createdAt(),
});

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    eventId: uuid('event_id').notNull().references(() => events.id),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    payload: jsonb('payload'),
    ipHash: text('ip_hash'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('audit_logs_event_at_idx').on(t.eventId, t.at)],
);
