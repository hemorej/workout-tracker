CREATE TABLE "power_curve" (
	"id" serial PRIMARY KEY NOT NULL,
	"workout_id" integer NOT NULL,
	"duration" text NOT NULL,
	"watts" integer NOT NULL,
	CONSTRAINT "pc_watts_positive" CHECK ("power_curve"."watts" > 0)
);
--> statement-breakpoint
ALTER TABLE "power_curve" ADD CONSTRAINT "power_curve_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "power_curve_workout_id_duration_idx" ON "power_curve" USING btree ("workout_id","duration");