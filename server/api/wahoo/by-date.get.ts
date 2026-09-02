/**
 * GET /api/wahoo/by-date?date=YYYY-MM-DD
 *
 * Finds the Wahoo biking workout that started on the given calendar day,
 * downloads its FIT file, and parses it for TSS/power-curve bests/duration/
 * distance — the outdoor-ride half of the "Mark as completed" flow (see
 * CLAUDE.md). The picker itself now lists Strava activities (Wahoo has no
 * FIT file for Zwift/virtual rides), so lookup here is by date rather than
 * by Wahoo workout id: the user only logs one ride per day, so same-day is a
 * reliable match. The indoor/virtual half uses POST /api/fit/upload instead,
 * since there's no Wahoo FIT file to fetch at all.
 *
 * Ride duration/distance in the response come from the parsed FIT file, not
 * from Wahoo's own workout summary — the caller is expected to take the
 * activity *name* from Strava and everything else from here.
 *
 * As a side effect, upserts the computed bests into `wahoo_power_bests` and
 * prunes it back down to the all-time top-3 / trailing-8-week retention
 * window per duration (same as the old activities/[id] endpoint this
 * replaces).
 *
 * Returns:
 *   200 { ride: WahooRideSummary, tss, powerBests, durationSeconds, distanceMeters, fitData, laps }
 *   400 for a missing/invalid date
 *   404 if no Wahoo workout matches that date
 *   422 if the matched workout has no FIT file yet, or the file has no power data
 *   502 if the Wahoo API call fails
 */

import { useDB } from '../../db'
import { findRideByDate, fetchAndParseActivity } from '../../utils/wahoo'
import { getCurrentFtpWatts } from '../../utils/ftp'
import { metricsToWorkoutFields, upsertWahooPowerBests } from '../../utils/fitWorkout'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const date = getQuery(event).date
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    throw createError({ statusCode: 400, statusMessage: 'A date query param (YYYY-MM-DD) is required.' })
  }

  const db = useDB()
  const ftpWatts = await getCurrentFtpWatts(user.id)

  let match
  try {
    match = await findRideByDate(date)
  }
  catch (err: unknown) {
    const e = err as Record<string, any>
    getLogger('wahoo').error('wahoo.find_ride_by_date_failed', {
      requestId: event.context.requestId,
      date,
      status: e?.status ?? e?.response?.status,
      err: e?.message,
    })
    throw createError({ statusCode: 502, statusMessage: 'Failed to fetch recent rides from Wahoo.' })
  }

  if (!match) {
    throw createError({ statusCode: 404, statusMessage: 'No matching Wahoo activity found for that date.' })
  }

  let ride, metrics
  try {
    ({ ride, metrics } = await fetchAndParseActivity(match.id, ftpWatts))
  }
  catch (err: unknown) {
    if ((err as { statusCode?: number })?.statusCode) throw err // already a createError (e.g. no FIT file)

    const e = err as Record<string, any>
    getLogger('wahoo').error('wahoo.fetch_activity_failed', {
      requestId: event.context.requestId,
      workoutId: match.id,
      status: e?.status ?? e?.response?.status,
      err: e?.message,
    })
    if (e?.message?.includes('No power data')) {
      throw createError({ statusCode: 422, statusMessage: 'This ride has no power data.' })
    }
    throw createError({ statusCode: 502, statusMessage: 'Failed to fetch activity from Wahoo.' })
  }

  const fields = metricsToWorkoutFields(metrics, ftpWatts)
  const achievedAt = ride.startDateLocal.slice(0, 10)

  await upsertWahooPowerBests(db, match.id, fields.powerBests, achievedAt)

  getLogger('wahoo').info('wahoo.activity_parsed', {
    requestId: event.context.requestId,
    workoutId: match.id,
    tss: metrics.tss,
    ftpWatts,
  })

  return { ride, ...fields }
})
