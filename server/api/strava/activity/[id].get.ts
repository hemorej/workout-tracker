/**
 * GET /api/strava/activity/:id
 *
 * Returns name/distance/duration/route for a single Strava activity, used
 * by the photo-overlay page (app/pages/overlay/[activityId].vue) to draw
 * the route line and stat row over a user-uploaded photo.
 *
 * Returns:
 *   200 { name, distanceMeters, movingTimeSeconds, points, avgWatts, elevationGainMeters,
 *         avgSpeedMetersPerSecond, startDateLocal, altitudeStream, distanceStream,
 *         normalizedPowerWatts }
 *     `points` is an empty array if the activity has no route (e.g.
 *     manually entered, no GPS) — the overlay page still gets name/distance/
 *     duration and simply skips drawing a route line. `avgWatts` and
 *     `avgSpeedMetersPerSecond` are null if the activity has no such data.
 *     `altitudeStream` / `distanceStream` are downsampled, paired arrays for
 *     the elevation-profile overlay, empty if the activity has no altitude
 *     stream. `normalizedPowerWatts` is NP from the matching logged workout's
 *     parsed FIT file (Strava's own payload has no NP) — null when no logged
 *     workout matches or it has no FIT data.
 *   502 if the Strava API call fails (token refresh failure, network error, etc.)
 */

import { and, eq, or } from 'drizzle-orm'
import { fetchStravaActivityOverlayData } from '../../../utils/strava'
import { workouts } from '../../../db/schema'
import { useDB } from '../../../db'

/**
 * NP is FIT-derived — it lives in workouts.fitData, not on the Strava
 * activity payload. Find the user's logged workout for this activity: by
 * stravaActivityId when it was created via "Mark as completed", else by
 * calendar day (one ride per day, so same-day is a reliable match — the
 * same join the completed-workout picker uses).
 */
async function findNormalizedPower(userId: number, activityId: number, startDateLocal: string): Promise<number | null> {
  const rideDate = startDateLocal.slice(0, 10)
  const rows = await useDB()
    .select({ fitData: workouts.fitData, stravaActivityId: workouts.stravaActivityId })
    .from(workouts)
    .where(and(
      eq(workouts.userId, userId),
      or(eq(workouts.stravaActivityId, activityId), eq(workouts.date, rideDate)),
    ))
    .limit(2)

  if (rows.length === 0) return null
  // Prefer an exact activity-id match over the same-day fallback.
  const row = rows.find((r) => r.stravaActivityId === activityId) ?? rows[0]!
  const np = row.fitData?.normalizedPower
  return typeof np === 'number' && np > 0 ? Math.round(np) : null
}

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const activityId = Number(getRouterParam(event, 'id'))
  if (!Number.isFinite(activityId)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid activity id.' })
  }

  let data
  try {
    data = await fetchStravaActivityOverlayData(activityId)
  }
  catch (err: unknown) {
    const e = err as Record<string, any>
    getLogger('strava').error('strava.fetch_activity_detail_failed', {
      requestId: event.context.requestId,
      activityId,
      status: e?.status ?? e?.response?.status,
      err: e?.message,
    })
    throw createError({ statusCode: 502, statusMessage: 'Failed to fetch activity from Strava.' })
  }

  let normalizedPowerWatts: number | null = null
  try {
    normalizedPowerWatts = await findNormalizedPower(user.id, activityId, data.startDateLocal)
  }
  catch (err: unknown) {
    // A DB hiccup here shouldn't sink the overlay — just ship without NP.
    getLogger('strava').warn('strava.activity_np_lookup_failed', {
      requestId: event.context.requestId,
      activityId,
      err: (err as Error)?.message,
    })
  }

  getLogger('strava').info('strava.activity_detail_fetched', {
    requestId: event.context.requestId,
    activityId,
    pointCount: data.points.length,
    hasNormalizedPower: normalizedPowerWatts != null,
  })

  return { ...data, normalizedPowerWatts }
})
