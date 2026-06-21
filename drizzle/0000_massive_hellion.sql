CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"initial_ctl" integer DEFAULT 0 NOT NULL,
	"initial_atl" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "workouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"tss" integer NOT NULL,
	"rpe" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rpe_range" CHECK ("workouts"."rpe" IS NULL OR ("workouts"."rpe" >= 1 AND "workouts"."rpe" <= 10)),
	CONSTRAINT "duration_positive" CHECK ("workouts"."duration_minutes" > 0),
	CONSTRAINT "tss_non_negative" CHECK ("workouts"."tss" >= 0)
);
--> statement-breakpoint
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workouts_user_id_date_idx" ON "workouts" USING btree ("user_id","date");