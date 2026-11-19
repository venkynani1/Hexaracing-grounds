-- Allow Captain-authorised role swaps (A<->B) inside one transaction: uniqueness is checked at COMMIT.
ALTER TABLE "players" DROP CONSTRAINT "players_team_role_uq";--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_team_role_uq" UNIQUE ("team_id", "role") DEFERRABLE INITIALLY DEFERRED;
