/**
 * Types and helpers for the public Wahoo webhook endpoint
 * (server/api/wahoo/webhook.post.ts).
 *
 * Wahoo POSTs a JSON body when a workout finishes syncing. Shape per the
 * "Webhooks → Workout Summary" section of https://cloud-api.wahooligan.com/:
 * a top-level `event_type` / `webhook_token` / `user`, and a `workout_summary`
 * object that itself nests both the FIT `file` and the `workout` (this is the
 * inverse of `GET /v1/workouts`, which nests the summary inside the workout —
 * see server/utils/wahoo.ts).
 */

import { timingSafeEqual } from 'node:crypto'

export interface WahooWebhookWorkout {
  id: number
  name?: string | null
  /** Start time, ISO-8601 e.g. "2015-08-12T09:00:00.000Z". */
  starts: string
  minutes?: number
  workout_type_id: number
  workout_token?: string
  /** Non-null ⇒ a SYSTM/RGT plan entry that was only ever scheduled, never ridden. */
  plan_id?: number | null
}

export interface WahooWebhookWorkoutSummary {
  id?: number
  /** Populated only for rides recorded by a native Wahoo device — absent for Zwift/virtual. */
  file?: { url: string } | null
  /** Meters, as a numeric string (Wahoo returns summary metrics as strings). */
  distance_accum?: string | null
  /** The workout this summary belongs to — nested here in webhook deliveries. */
  workout?: WahooWebhookWorkout | null
}

export interface WahooWebhookBody {
  event_type?: string
  /** Shared secret configured on the Wahoo webhook subscription. */
  webhook_token?: string
  user?: { id: number } | null
  workout_summary?: WahooWebhookWorkoutSummary | null
}

/** Constant-time string compare. False if either side is missing or lengths differ. */
export function secretMatches(provided?: string | null, expected?: string | null): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
