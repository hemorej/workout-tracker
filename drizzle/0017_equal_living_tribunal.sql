CREATE TABLE "zwift_workout_drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"workout_id" integer NOT NULL,
	"base_hash" text NOT NULL,
	"xml" text NOT NULL,
	"model_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zwift_workouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"xml" text NOT NULL,
	"content_hash" text NOT NULL,
	"model_hash" text NOT NULL,
	"duration_sec" integer NOT NULL,
	"tss" integer NOT NULL,
	"zone" text,
	"editable" boolean DEFAULT true NOT NULL,
	"unsupported" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_mtime" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "zwift_workout_drafts" ADD CONSTRAINT "zwift_workout_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zwift_workout_drafts" ADD CONSTRAINT "zwift_workout_drafts_workout_id_zwift_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."zwift_workouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zwift_workouts" ADD CONSTRAINT "zwift_workouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "zwift_workout_drafts_user_workout_idx" ON "zwift_workout_drafts" USING btree ("user_id","workout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "zwift_workouts_user_path_idx" ON "zwift_workouts" USING btree ("user_id","path");--> statement-breakpoint
CREATE INDEX "zwift_workouts_user_deleted_idx" ON "zwift_workouts" USING btree ("user_id","deleted_at");