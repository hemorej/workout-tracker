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

  const powerBests = Object.entries(metrics.bests).map(([duration, watts]) => ({ duration, watts: watts! }))

  getLogger('wahoo').info('fit.upload_parsed', {
    requestId: event.context.requestId,
    tss: metrics.tss,
    ftpWatts,
  })

  return {
    tss: metrics.tss,
    powerBests,
    durationSeconds: metrics.durationSeconds,
    distanceMeters: metrics.distanceMeters,
    fitData: {
      avgPower: metrics.avgPower,
      maxPower: metrics.maxPower,
      normalizedPower: metrics.normalizedPower,
      intensityFactor: metrics.intensityFactor,
      avgHr: metrics.avgHr,
      maxHr: metrics.maxHr,
      avgCadence: metrics.avgCadence,
      maxCadence: metrics.maxCadence,
      zoneBuckets: metrics.zoneBuckets,
    },
    laps: metrics.laps.length >= 2 ? metrics.laps : null,
  }
})
