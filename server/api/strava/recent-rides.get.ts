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

import { fetchRecentRides } from '../../utils/strava'

export default defineEventHandler(async (event) => {
  await requireUserSession(event)

  try {
    const activities = await fetchRecentRides(3)
    return { activities }
  }
  catch {
    throw createError({ statusCode: 502, statusMessage: 'Failed to fetch recent rides from Strava.' })
  }
})
