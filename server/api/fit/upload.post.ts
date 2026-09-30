/**
 * POST /api/fit/upload (multipart/form-data, field "file")
 *
 * Manual FIT upload for the "Mark as completed" flow's indoor/virtual branch
 * (see CLAUDE.md) — Wahoo never has a FIT file for Zwift rides
 * (fitness_app_id 1338, workout_summary.file always null), so the user
 * downloads the FIT file Zwift/their trainer app saved locally and uploads
 * it here directly, same parser as the Wahoo-sourced path.
 *
 * Unlike GET /api/wahoo/by-date, this does NOT write to `wahoo_power_bests`
 * — that table specifically tracks bests auto-detected from rides seen via
 * the Wahoo API; there's no Wahoo activity id to key a row on here. The
 * parsed bests still flow into the Add Workout form as an editable prefill,
 * and get saved normally via POST /api/workouts if the user keeps them.
 *
 * Returns:
 *   200 { tss, powerBests, durationSeconds, distanceMeters, fitData, laps }
 *   400 if no file was uploaded
 *   422 if the file has no record data or no power data
 */

import { parseFitFile } from '../../utils/fit'
import { getCurrentFtpWatts } from '../../utils/ftp'
import { useDB } from '../../db'
import { eq, and } from 'drizzle-orm'
import { workouts } from '../../db/schema'
import { metricsToWorkoutFields, withNewBestEffortsOnly } from '../../utils/fitWorkout'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const parts = await readMultipartFormData(event)
  const filePart = parts?.find((p) => p.name === 'file')
  if (!filePart?.data?.length) {
    throw createError({ statusCode: 400, statusMessage: 'No FIT file was uploaded.' })
  }

  const ftpWatts = await getCurrentFtpWatts(user.id)

  let metrics
  try {
    metrics = await parseFitFile(filePart.data, ftpWatts)
  }
  catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to parse FIT file.'
    getLogger('wahoo').warn('fit.upload_parse_failed', {
      requestId: event.context.requestId,
      err: message,
    })
    throw createError({ statusCode: 422, statusMessage: message })
  }

  getLogger('wahoo').info('fit.upload_parsed', {
    requestId: event.context.requestId,
    tss: metrics.tss,
    ftpWatts,
  })

  const fields = metricsToWorkoutFields(metrics, ftpWatts)

  // Optional "date" form field = the ride's day; bests are compared against
  // the 8 weeks before it. Without it the raw bests are returned unfiltered.
  const datePart = parts?.find((p) => p.name === 'date')?.data?.toString()
  if (!datePart || !/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return fields

  const db = useDB()
  const [existing] = await db
    .select({ id: workouts.id })
    .from(workouts)
    .where(and(eq(workouts.userId, user.id), eq(workouts.date, datePart)))
    .limit(1)
  return withNewBestEffortsOnly(db, user.id, datePart, fields, existing?.id)
})
