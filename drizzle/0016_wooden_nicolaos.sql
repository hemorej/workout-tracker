CREATE TABLE "segment_efforts" (
	"id" bigint PRIMARY KEY NOT NULL,
	"segment_id" bigint NOT NULL,
	"user_id" integer NOT NULL,
	"strava_activity_id" bigint NOT NULL,
	"elapsed_time" integer NOT NULL,
	"moving_time" integer,
	"distance_meters" real,
	"start_date" timestamp with time zone NOT NULL,
	"average_watts" real,
	"device_watts" boolean,
	"average_heartrate" real,
	"max_heartrate" real,
	"average_cadence" real,
	"pr_rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_segments" (
	"id" bigint PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"distance_meters" real NOT NULL,
	"average_grade" real,
	"climb_category" integer,
	"total_elevation_gain" real,
	"city" text,
	"state" text,
	"country" text,
	"starred" boolean DEFAULT true NOT NULL,
	"strava_effort_count" integer,
	"pr_elapsed_time" integer,
	"pr_date" date,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_segments_distance_positive" CHECK ("tracked_segments"."distance_meters" > 0)
);
--> statement-breakpoint
ALTER TABLE "segment_efforts" ADD CONSTRAINT "segment_efforts_segment_id_tracked_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."tracked_segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_efforts" ADD CONSTRAINT "segment_efforts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_segments" ADD CONSTRAINT "tracked_segments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "segment_efforts_segment_id_elapsed_time_idx" ON "segment_efforts" USING btree ("segment_id","elapsed_time");--> statement-breakpoint
CREATE INDEX "segment_efforts_user_id_idx" ON "segment_efforts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tracked_segments_user_id_idx" ON "tracked_segments" USING btree ("user_id");