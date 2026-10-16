/**
 * Title (and Strava link) for a ride built from a FIT file — shared by every
 * auto-ingest path (Wahoo webhook, Zwift activity upload). FIT files carry no
 * activity name; the title Zwift/Strava shows is generated server-side by
 * Strava, so Strava is the only source for it.
 *
 * Resolution order: matching Strava activity → that day's planned workout →
 * the caller's fallback. "Matching" is strict (see shared/utils/rideMatch.ts):
 * same calendar day and, when known, same ride type. There is deliberately NO
 * "newest ride" fallback — that used to title a ride with the previous day's
 * Strava activity whenever Strava hadn't received the new ride yet.
 *
 * Strava often lags the ride by a minute or more, so callers may ask for a few
 * spaced retries before falling through.
 */

import { and, eq } from 'drizzle-orm'
import { plannedWorkouts } from '../db/schema'
import { useDB } from '../db'
import { fetchRecentStravaRides } from './strava'
import { pickStravaRide } from '../../shared/utils/rideMatch'

const log = getLogger('workouts')

export type RideNameSource = 'strava' | 'planned' | 'fallback'

export interface ResolvedRideName {
  name: string
  source: RideNameSource
  stravaActivityId: number | null
  /** Ride type per the matched Strava activity, if any. */
  stravaRideType: 'trainer' | 'outdoor' | null
}

export interface ResolveRideNameInput {
  userId: number
  /** Local calendar day of the ride, YYYY-MM-DD. */
  rideDate: string
  /** Ride type when the source knows it; narrows the Strava match. */
  rideType?: 'trainer' | 'outdoor'
  durationSeconds?: number
  fallbackName: string
  /** Strava lookups to try (default 1) and the pause between them. */
  attempts?: number
  delayMs?: number
  requestId?: string
}

export async function resolveRideName(input: ResolveRideNameInput): Promise<ResolvedRideName> {
  const { userId, rideDate, rideType, durationSeconds, requestId } = input
  const attempts = Math.max(1, input.attempts ?? 1)

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const rides = await fetchRecentStravaRides(10)
      const match = pickStravaRide(rides, { rideDate, rideType, durationSeconds })
      if (match) {
        return { name: match.name, source: 'strava', stravaActivityId: match.id, stravaRideType: match.rideType }
      }
    }
    catch (err: unknown) {
      log.warn('workouts.strava_lookup_failed', { requestId, attempt, err: (err as Error)?.message })
    }
    if (attempt < attempts) await new Promise(r => setTimeout(r, input.delayMs ?? 0))
  }

  const [planned] = await useDB()
    .select({ name: plannedWorkouts.name })
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, userId), eq(plannedWorkouts.date, rideDate)))
    .limit(1)
  if (planned?.name) {
    return { name: planned.name, source: 'planned', stravaActivityId: null, stravaRideType: null }
  }
  return { name: input.fallbackName, source: 'fallback', stravaActivityId: null, stravaRideType: null }
}
