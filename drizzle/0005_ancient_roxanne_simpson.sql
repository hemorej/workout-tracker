CREATE INDEX "workouts_user_id_tss_idx" ON "workouts" USING btree ("user_id","tss");--> statement-breakpoint
CREATE INDEX "workouts_user_id_distance_km_idx" ON "workouts" USING btree ("user_id","distance_km");--> statement-breakpoint
CREATE INDEX "workouts_user_id_duration_minutes_idx" ON "workouts" USING btree ("user_id","duration_minutes");--> statement-breakpoint
CREATE INDEX "workouts_user_id_ride_type_idx" ON "workouts" USING btree ("user_id","ride_type");