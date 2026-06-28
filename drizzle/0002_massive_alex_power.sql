CREATE TABLE "power_bests" (
	"id" serial PRIMARY KEY NOT NULL,
	"workout_id" integer NOT NULL,
	"duration" text NOT NULL,
	"watts" integer NOT NULL,
	CONSTRAINT "pb_watts_positive" CHECK ("power_bests"."watts" > 0)
);
--> statement-breakpoint
ALTER TABLE "workouts" ADD COLUMN "ftp_watts" integer;--> statement-breakpoint
ALTER TABLE "power_bests" ADD CONSTRAINT "power_bests_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "power_bests_workout_id_duration_idx" ON "power_bests" USING btree ("workout_id","duration");