ALTER TABLE "strava_power_bests" RENAME TO "wahoo_power_bests";--> statement-breakpoint
ALTER TABLE "wahoo_power_bests" RENAME CONSTRAINT "strava_pb_watts_positive" TO "wahoo_pb_watts_positive";--> statement-breakpoint
ALTER TABLE "wahoo_power_bests" RENAME CONSTRAINT "strava_pb_duration_valid" TO "wahoo_pb_duration_valid";--> statement-breakpoint
ALTER INDEX "strava_power_bests_activity_id_duration_idx" RENAME TO "wahoo_power_bests_activity_id_duration_idx";--> statement-breakpoint
ALTER INDEX "strava_power_bests_duration_watts_idx" RENAME TO "wahoo_power_bests_duration_watts_idx";--> statement-breakpoint
ALTER INDEX "strava_power_bests_duration_achieved_at_idx" RENAME TO "wahoo_power_bests_duration_achieved_at_idx";--> statement-breakpoint
DROP TABLE "strava_synced_activities";
