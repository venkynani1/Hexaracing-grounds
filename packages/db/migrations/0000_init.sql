CREATE TYPE "public"."actor_type" AS ENUM('system', 'host', 'player', 'director');--> statement-breakpoint
CREATE TYPE "public"."challenge_type" AS ENUM('coding', 'logic', 'truth', 'navigation', 'four_key', 'gate');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_LOCKED', 'COUNTDOWN', 'LIVE', 'PAUSED', 'RECOVERING', 'FINISHED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."player_role" AS ENUM('RACER', 'ENGINEER', 'DECEIVER', 'CAPTAIN');--> statement-breakpoint
CREATE TYPE "public"."scoring_category" AS ENUM('DRIVING', 'CODING', 'DECEPTION', 'CAPTAIN_STRATEGY', 'TEAM_ASSESSMENTS', 'FUEL_MANAGEMENT', 'HEXAWARE_GATE');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"payload" jsonb,
	"ip_hash" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bluff_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"fake_answer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bluff_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"true_answer_hash" text NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bluff_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"voter_team_id" uuid NOT NULL,
	"voter_player_id" uuid NOT NULL,
	"choice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "car_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"paint" text,
	"selected_by_player_id" uuid,
	"selected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenge_clues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"role" "player_role" NOT NULL,
	"clue_ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenge_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"answer" text NOT NULL,
	"correct" boolean NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "challenge_submissions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"code" text NOT NULL,
	"type" "challenge_type" NOT NULL,
	"phase" text NOT NULL,
	"payload" jsonb NOT NULL,
	"answer_hash" text NOT NULL,
	"max_points" integer NOT NULL,
	"category" "scoring_category" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"status" "event_status" NOT NULL,
	"phase" text,
	"director_tick" integer DEFAULT 0 NOT NULL,
	"elapsed_ms" bigint DEFAULT 0 NOT NULL,
	"transitioned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cause" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "event_status" DEFAULT 'REGISTRATION_OPEN' NOT NULL,
	"seed" bigint NOT NULL,
	"started_at" timestamp with time zone,
	"paused_ms" bigint DEFAULT 0 NOT NULL,
	"paused_at" timestamp with time zone,
	"host_key_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fuel_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"delta_fuel" double precision NOT NULL,
	"reason" text NOT NULL,
	"credits_delta" integer DEFAULT 0 NOT NULL,
	"at_tick" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fuel_transactions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "offer_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"achievement" text NOT NULL,
	"final_score" integer NOT NULL,
	"arrival_status" text NOT NULL,
	"pdf_url" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_letters_player_id_unique" UNIQUE("player_id")
);
--> statement-breakpoint
CREATE TABLE "pit_stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"station_id" text NOT NULL,
	"stage" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"slot" smallint NOT NULL,
	"role" "player_role" NOT NULL,
	"display_name" text NOT NULL,
	"rejoin_secret_hash" text NOT NULL,
	"connected_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_team_role_uq" UNIQUE("team_id","role")
);
--> statement-breakpoint
CREATE TABLE "recovery_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"tick" integer NOT NULL,
	"phase" text,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "road_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_version" text NOT NULL,
	"edge_id" integer NOT NULL,
	"from_node" integer NOT NULL,
	"to_node" integer NOT NULL,
	"length_m" double precision NOT NULL,
	"lanes" smallint NOT NULL,
	"speed_class" smallint NOT NULL,
	"cell_x" integer NOT NULL,
	"cell_z" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoring_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"category" "scoring_category" NOT NULL,
	"points" integer NOT NULL,
	"reason" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"tick" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"player_id" uuid,
	"is_host" boolean DEFAULT false NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "start_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"lat" double precision,
	"lon" double precision,
	"world_x" double precision,
	"world_z" double precision,
	"enabled" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"max_squads" integer DEFAULT 6 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "start_locations_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"join_code" char(6) NOT NULL,
	"vehicle_id" uuid,
	"start_location_id" uuid,
	"paint" text,
	"ready" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicle_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"checkpoint_id" text NOT NULL,
	"tick" integer NOT NULL,
	"elapsed_ms" integer NOT NULL,
	"speed" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"stats" jsonb NOT NULL,
	"balance_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "world_metadata" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"anchor_lat" double precision,
	"anchor_lon" double precision,
	"world_scale" double precision DEFAULT 8 NOT NULL,
	"map_version" text NOT NULL,
	"osm_attribution" text DEFAULT '© OpenStreetMap contributors, ODbL' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bluff_entries" ADD CONSTRAINT "bluff_entries_round_id_bluff_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."bluff_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bluff_entries" ADD CONSTRAINT "bluff_entries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bluff_entries" ADD CONSTRAINT "bluff_entries_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bluff_rounds" ADD CONSTRAINT "bluff_rounds_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bluff_votes" ADD CONSTRAINT "bluff_votes_round_id_bluff_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."bluff_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bluff_votes" ADD CONSTRAINT "bluff_votes_voter_team_id_teams_id_fk" FOREIGN KEY ("voter_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bluff_votes" ADD CONSTRAINT "bluff_votes_voter_player_id_players_id_fk" FOREIGN KEY ("voter_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "car_selections" ADD CONSTRAINT "car_selections_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "car_selections" ADD CONSTRAINT "car_selections_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "car_selections" ADD CONSTRAINT "car_selections_selected_by_player_id_players_id_fk" FOREIGN KEY ("selected_by_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_clues" ADD CONSTRAINT "challenge_clues_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_clues" ADD CONSTRAINT "challenge_clues_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_submissions" ADD CONSTRAINT "challenge_submissions_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_submissions" ADD CONSTRAINT "challenge_submissions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_submissions" ADD CONSTRAINT "challenge_submissions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_states" ADD CONSTRAINT "event_states_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_transactions" ADD CONSTRAINT "fuel_transactions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_letters" ADD CONSTRAINT "offer_letters_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pit_stops" ADD CONSTRAINT "pit_stops_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_snapshots" ADD CONSTRAINT "recovery_snapshots_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_events" ADD CONSTRAINT "scoring_events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_start_location_id_start_locations_id_fk" FOREIGN KEY ("start_location_id") REFERENCES "public"."start_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_checkpoints" ADD CONSTRAINT "vehicle_checkpoints_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_metadata" ADD CONSTRAINT "world_metadata_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_event_at_idx" ON "audit_logs" USING btree ("event_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "bluff_entries_round_team_uq" ON "bluff_entries" USING btree ("round_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bluff_votes_round_voter_uq" ON "bluff_votes" USING btree ("round_id","voter_player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "challenge_clues_uq" ON "challenge_clues" USING btree ("challenge_id","team_id","role");--> statement-breakpoint
CREATE INDEX "challenge_submissions_ct_idx" ON "challenge_submissions" USING btree ("challenge_id","team_id");--> statement-breakpoint
CREATE INDEX "event_states_event_idx" ON "event_states" USING btree ("event_id","transitioned_at");--> statement-breakpoint
CREATE UNIQUE INDEX "players_team_slot_uq" ON "players" USING btree ("team_id","slot");--> statement-breakpoint
CREATE INDEX "players_team_idx" ON "players" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "recovery_snapshots_event_idx" ON "recovery_snapshots" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "road_segments_version_edge_uq" ON "road_segments" USING btree ("map_version","edge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scoring_events_source_uq" ON "scoring_events" USING btree ("source_type","source_id","team_id");--> statement-breakpoint
CREATE INDEX "scoring_events_team_cat_idx" ON "scoring_events" USING btree ("team_id","category");--> statement-breakpoint
CREATE INDEX "sessions_player_idx" ON "sessions" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_event_code_uq" ON "teams" USING btree ("event_id","join_code");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_event_name_uq" ON "teams" USING btree ("event_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_checkpoints_team_cp_uq" ON "vehicle_checkpoints" USING btree ("team_id","checkpoint_id");