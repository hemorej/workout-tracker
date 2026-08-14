/**
 * GET /api/strava/recent-rides
 *
 * Returns the 3 most recent Strava rides (outdoor "Ride" or indoor
 * "VirtualRide", e.g. Zwift) for the (single) connected Strava account. Used
 * by the "Mark as completed" flow to let the user pick which ride
 * corresponds to a planned workout.
 *
 * Returns:
 *   200 { activities: StravaRideSummary[] }
 *   502 if the Strava API call fails (token refresh failure, network error, etc.)
 */

import { fetchRecentStravaRides } from '../../utils/strava'

export default defineEventHandler(async (event) => {
  await requireUserSession(event)

  try {
    const activities = await fetchRecentStravaRides(3)
    return { activities }
  }
  catch (err: unknown) {
    const e = err as Record<string, any>
    getLogger('strava').error('strava.fetch_recent_rides_failed', {
      requestId: event.context.requestId,
      status: e?.status ?? e?.response?.status,
      err: e?.message,
    })
    throw createError({ statusCode: 502, statusMessage: 'Failed to fetch recent rides from Strava.' })
  }
})
