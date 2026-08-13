CREATE TABLE "wahoo_tokens" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"refresh_token" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
