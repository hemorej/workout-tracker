/**
 * GET /api/wahoo/recent-rides
 *
 * Returns the 3 most recent Wahoo biking workouts for the (single) connected
 * Wahoo account. Used by the "Mark as completed" flow to let the user pick
 * which ride corresponds to a planned workout. List only — no FIT download,
 * see GET /api/wahoo/activities/[id] for that.
 *
 * Returns:
 *   200 { activities: WahooRideSummary[] }
 *   502 if the Wahoo API call fails (token refresh failure, network error, etc.)
 */

import { fetchRecentRides } from '../../utils/wahoo'

export default defineEventHandler(async (event) => {
  await requireUserSession(event)

  try {
    const activities = await fetchRecentRides(3)
    return { activities }
  }
  catch (err: unknown) {
    const e = err as Record<string, any>
    getLogger('wahoo').error('wahoo.fetch_recent_rides_failed', {
      requestId: event.context.requestId,
      status: e?.status ?? e?.response?.status,
      err: e?.message,
    })
    throw createError({ statusCode: 502, statusMessage: 'Failed to fetch recent rides from Wahoo.' })
  }
})
