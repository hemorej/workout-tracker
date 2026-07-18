CREATE TABLE "strava_power_bests" (
	"id" serial PRIMARY KEY NOT NULL,
	"activity_id" bigint NOT NULL,
	"duration" text NOT NULL,
	"watts" integer NOT NULL,
	"achieved_at" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strava_pb_watts_positive" CHECK ("strava_power_bests"."watts" > 0),
	CONSTRAINT "strava_pb_duration_valid" CHECK ("strava_power_bests"."duration" IN ('5sec', '15sec', '30sec', '1min', '2min', '3min', '5min', '8min', '10min', '15min', '20min', '30min', '45min', '1h'))
);
--> statement-breakpoint
CREATE TABLE "strava_synced_activities" (
	"activity_id" bigint PRIMARY KEY NOT NULL,
	"had_power" boolean NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "strava_power_bests_activity_id_duration_idx" ON "strava_power_bests" USING btree ("activity_id","duration");--> statement-breakpoint
CREATE INDEX "strava_power_bests_duration_watts_idx" ON "strava_power_bests" USING btree ("duration","watts");--> statement-breakpoint
CREATE INDEX "strava_power_bests_duration_achieved_at_idx" ON "strava_power_bests" USING btree ("duration","achieved_at");