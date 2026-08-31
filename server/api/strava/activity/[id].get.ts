/**
 * GET /api/strava/activity/:id
 *
 * Returns name/distance/duration/route for a single Strava activity, used
 * by the photo-overlay page (app/pages/overlay/[activityId].vue) to draw
 * the route line and stat row over a user-uploaded photo.
 *
 * Returns:
 *   200 { name, distanceMeters, movingTimeSeconds, points, avgWatts, elevationGainMeters,
 *         avgSpeedMetersPerSecond, startDateLocal, altitudeStream, distanceStream }
 *     `points` is an empty array if the activity has no route (e.g.
 *     manually entered, no GPS) — the overlay page still gets name/distance/
 *     duration and simply skips drawing a route line. `avgWatts` and
 *     `avgSpeedMetersPerSecond` are null if the activity has no such data.
 *     `altitudeStream` / `distanceStream` are downsampled, paired arrays for
 *     the elevation-profile overlay, empty if the activity has no altitude
 *     stream.
 *   502 if the Strava API call fails (token refresh failure, network error, etc.)
 */

import { fetchStravaActivityOverlayData } from '../../../utils/strava'

export default defineEventHandler(async (event) => {
  await requireUserSession(event)

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

  getLogger('strava').info('strava.activity_detail_fetched', {
    requestId: event.context.requestId,
    activityId,
    pointCount: data.points.length,
  })

  return data
})
