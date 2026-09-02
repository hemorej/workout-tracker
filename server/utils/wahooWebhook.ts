/**
 * Types and helpers for the public Wahoo webhook endpoint
 * (server/api/wahoo/webhook.post.ts).
 *
 * Wahoo POSTs a JSON body when a workout finishes syncing. The exact shape
 * isn't fully documented; these interfaces mirror the fields
 * server/utils/wahoo.ts already relies on (`WahooWorkout` /
 * `WahooWorkoutSummary`) plus the `webhook_token` Wahoo echoes back from the
 * subscription config. Confirm against a real delivery when wiring the
 * subscription up.
 */

import { timingSafeEqual } from 'node:crypto'

export interface WahooWebhookWorkoutSummary {
  id?: number
  /** Populated only for rides recorded by a native Wahoo device — null for Zwift/virtual. */
  file?: { url: string } | null
  /** Meters, as a numeric string (Wahoo returns summary metrics as strings). */
  distance_accum?: string | null
}

export interface WahooWebhookWorkout {
  id: number
  name?: string | null
  /** Local start time, ISO-ish "YYYY-MM-DDTHH:mm:ss". */
  starts: string
  minutes?: number
  workout_type_id: number
  /** Non-null ⇒ a SYSTM/RGT plan entry that was only ever scheduled, never ridden. */
  plan_id?: number | null
}

export interface WahooWebhookBody {
  event_type?: string
  /** Shared secret configured on the Wahoo webhook subscription. */
  webhook_token?: string
  workout_summary?: WahooWebhookWorkoutSummary | null
  workout?: WahooWebhookWorkout | null
}

/** Constant-time string compare. False if either side is missing or lengths differ. */
export function secretMatches(provided?: string | null, expected?: string | null): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
