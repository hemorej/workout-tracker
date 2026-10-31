/**
 * PATCH /api/workouts/:id
 *
 * Updates an existing workout entry for the authenticated user — used by the
 * "Refresh ride data" flow (see CLAUDE.md's Completed-workout picker), which
 * re-parses a FIT file for an already-logged workout and reopens the Add
 * Workout modal (in edit mode) so the user can review before saving.
 *
 * Only the workout's owner can update it — same id+userId filter as DELETE.
 *
 * Body (JSON): same shape as POST /api/workouts — and the update is a full
 * replace of the editable columns, not a partial patch: `date`, `name`,
 * `durationMinutes`, `distanceKm`, `tss`, `rpe`, `notes`, `ftpWatts` and `rideType`
 * are overwritten, with omitted optional fields stored as null. `fitData` and
 * `laps` are the exception: omitted ⇒ the stored values are kept (the list API
 * doesn't return them, so a manual edit can't echo them back); send `null` to clear. `stravaActivityId` is
 * not updatable here. A date already used by a different workout is a 409.
 *
 * powerBests, if provided, fully replaces the workout's existing PR rows
 * (delete + reinsert); as on POST only entries strictly above the trailing
 * 8-week max are kept — see filterNewBestEfforts. powerCurve, if provided,
 * fully replaces the stored full curve (power_curve); omitted ⇒ untouched
 * (a plain manual edit never sends it).
 *
 * Returns:
 *   200 { workout }  on success
 *   400 for validation errors
 *   404 if the workout doesn't exist or belongs to a different user
 *   409 if another workout is already logged on the (new) date
 */

import { eq, and, ne } from 'drizzle-orm'
import { workouts, type WorkoutFitData, type WorkoutLap } from '../../db/schema'
import { useDB } from '../../db'
import { invalidateMetrics } from '../../utils/metricsCache'
import { syncActivitySegmentEfforts } from '../../utils/stravaSegments'
import { parsePowerEntries, recordRidePowerBests } from '../../utils/powerBests'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid workout ID.' })
  }

  const body = await readBody(event)

  // ── Validation ────────────────────────────────────────────────────────────

  if (!body?.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Workout name is required.' })
  }

  const durationMinutes = Number(body.durationMinutes)
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Duration must be a positive integer (minutes).' })
  }

  const tss = Number(body.tss)
  if (!Number.isInteger(tss) || tss < 0) {
    throw createError({ statusCode: 400, statusMessage: 'TSS must be a non-negative integer.' })
  }

  let distanceKm: number | null = null
  if (body.distanceKm !== undefined && body.distanceKm !== null && body.distanceKm !== '') {
    distanceKm = Number(body.distanceKm)
    if (!Number.isFinite(distanceKm) || distanceKm < 0) {
      throw createError({ statusCode: 400, statusMessage: 'Distance must be a non-negative number.' })
    }
  }

  let rpe: number | null = null
  if (body.rpe !== undefined && body.rpe !== null && body.rpe !== '') {
    rpe = Number(body.rpe)
    if (!Number.isInteger(rpe) || rpe < 1 || rpe > 10) {
      throw createError({ statusCode: 400, statusMessage: 'RPE must be an integer between 1 and 10.' })
    }
  }

  const date: string = body.date || new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw createError({ statusCode: 400, statusMessage: 'Date must be in YYYY-MM-DD format.' })
  }

  const notes: string | null = body.notes?.trim() || null

  let ftpWatts: number | null = null
  if (body.ftpWatts !== undefined && body.ftpWatts !== null && body.ftpWatts !== '') {
    ftpWatts = Number(body.ftpWatts)
    if (!Number.isInteger(ftpWatts) || ftpWatts <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'FTP must be a positive integer in watts.' })
    }
  }

  let rideType: 'trainer' | 'outdoor' | null = null
  if (body.rideType !== undefined && body.rideType !== null) {
    if (body.rideType !== 'trainer' && body.rideType !== 'outdoor') {
      throw createError({ statusCode: 400, statusMessage: "Ride type must be 'trainer' or 'outdoor'." })
    }
    rideType = body.rideType
  }

  // undefined = key omitted → leave the stored column alone (a plain "Edit ride"
  // doesn't have the heavy fit_data/laps columns client-side, see index.get.ts)
  let fitData: WorkoutFitData | null | undefined
  if (body.fitData === null) fitData = null
  else if (body.fitData !== undefined) {
    if (typeof body.fitData !== 'object') {
      throw createError({ statusCode: 400, statusMessage: 'fitData must be an object.' })
    }
    const fd = body.fitData
    const numericFields: (keyof WorkoutFitData)[] = ['avgPower', 'maxPower', 'normalizedPower', 'intensityFactor']
    for (const key of numericFields) {
      if (typeof fd[key] !== 'number' || !Number.isFinite(fd[key])) {
        throw createError({ statusCode: 400, statusMessage: `fitData.${key} must be a number.` })
      }
    }
    const optionalNumericFields: (keyof WorkoutFitData)[] = ['avgHr', 'maxHr', 'avgCadence', 'maxCadence']
    for (const key of optionalNumericFields) {
      if (fd[key] !== null && fd[key] !== undefined && (typeof fd[key] !== 'number' || !Number.isFinite(fd[key]))) {
        throw createError({ statusCode: 400, statusMessage: `fitData.${key} must be a number or null.` })
      }
    }
    let zoneBuckets: number[] | null = null
    if (fd.zoneBuckets !== null && fd.zoneBuckets !== undefined) {
      if (!Array.isArray(fd.zoneBuckets) || fd.zoneBuckets.length !== 6
        || fd.zoneBuckets.some((s: unknown) => typeof s !== 'number' || !Number.isFinite(s) || s < 0)) {
        throw createError({ statusCode: 400, statusMessage: 'fitData.zoneBuckets must be an array of 6 non-negative numbers.' })
      }
      zoneBuckets = fd.zoneBuckets
    }
    let zoneFtp: number | null = null
    if (fd.zoneFtp !== null && fd.zoneFtp !== undefined) {
      if (typeof fd.zoneFtp !== 'number' || !Number.isFinite(fd.zoneFtp) || fd.zoneFtp <= 0) {
        throw createError({ statusCode: 400, statusMessage: 'fitData.zoneFtp must be a positive number.' })
      }
      zoneFtp = fd.zoneFtp
    }
    fitData = {
      avgPower: fd.avgPower,
      maxPower: fd.maxPower,
      normalizedPower: fd.normalizedPower,
      intensityFactor: fd.intensityFactor,
      avgHr: fd.avgHr ?? null,
      maxHr: fd.maxHr ?? null,
      avgCadence: fd.avgCadence ?? null,
      maxCadence: fd.maxCadence ?? null,
      zoneBuckets,
      zoneFtp,
    }
  }

  let laps: WorkoutLap[] | null | undefined
  if (body.laps === null) laps = null
  else if (body.laps !== undefined) {
    if (!Array.isArray(body.laps)) {
      throw createError({ statusCode: 400, statusMessage: 'laps must be an array.' })
    }
    laps = body.laps.map((lap: Record<string, unknown>, i: number) => {
      const requiredNumericFields: (keyof WorkoutLap)[] = ['lapNumber', 'durationSeconds', 'distanceMeters']
      for (const key of requiredNumericFields) {
        if (typeof lap[key] !== 'number' || !Number.isFinite(lap[key])) {
          throw createError({ statusCode: 400, statusMessage: `laps[${i}].${key} must be a number.` })
        }
      }
      const optionalNumericFields: (keyof WorkoutLap)[] = ['avgPower', 'maxPower', 'avgHr', 'maxHr', 'avgCadence', 'avgSpeedKph']
      for (const key of optionalNumericFields) {
        if (lap[key] !== null && lap[key] !== undefined && (typeof lap[key] !== 'number' || !Number.isFinite(lap[key]))) {
          throw createError({ statusCode: 400, statusMessage: `laps[${i}].${key} must be a number or null.` })
        }
      }
      return {
        lapNumber: lap.lapNumber as number,
        durationSeconds: lap.durationSeconds as number,
        distanceMeters: lap.distanceMeters as number,
        avgPower: (lap.avgPower as number | null) ?? null,
        maxPower: (lap.maxPower as number | null) ?? null,
        avgHr: (lap.avgHr as number | null) ?? null,
        maxHr: (lap.maxHr as number | null) ?? null,
        avgCadence: (lap.avgCadence as number | null) ?? null,
        avgSpeedKph: (lap.avgSpeedKph as number | null) ?? null,
      }
    })
  }

  const pbInput = Array.isArray(body.powerBests) ? parsePowerEntries(body.powerBests, 'power best') : undefined
  const curveInput = Array.isArray(body.powerCurve) ? parsePowerEntries(body.powerCurve, 'power curve') : undefined

  // ── Update ────────────────────────────────────────────────────────────────

  const db = useDB()

  const [dateConflict] = await db
    .select({ id: workouts.id })
    .from(workouts)
    .where(and(eq(workouts.userId, user.id), eq(workouts.date, date), ne(workouts.id, id)))
    .limit(1)

  if (dateConflict) {
    throw createError({
      statusCode: 409,
      statusMessage: `A different workout is already logged for ${date}.`,
    })
  }

  const updated = await db
    .update(workouts)
    .set({
      date,
      name: body.name.trim(),
      durationMinutes,
      distanceKm,
      tss,
      rpe,
      notes,
      ftpWatts,
      rideType,
      fitData,
      laps,
    })
    .where(and(eq(workouts.id, id), eq(workouts.userId, user.id)))
    .returning()

  const updatedWorkout = updated[0]
  if (!updatedWorkout) {
    throw createError({ statusCode: 404, statusMessage: 'Workout not found.' })
  }

  if (pbInput || curveInput) {
    await recordRidePowerBests(db, {
      userId: user.id,
      workoutId: id,
      date: updatedWorkout.date,
      curve: curveInput,
      prCandidates: pbInput,
    })
  }

  invalidateMetrics(user.id)

  // Same tracked-segments hook as the create path — a "Refresh ride data"
  // edit is often when the Strava activity's segment efforts have finished
  // matching. Fire-and-forget; the nightly reconcile is the backstop.
  if (updatedWorkout.rideType === 'outdoor' && updatedWorkout.stravaActivityId) {
    void syncActivitySegmentEfforts(db, user.id, updatedWorkout.stravaActivityId, event.context.requestId)
  }

  getLogger('workouts').info('workouts.updated', { requestId: event.context.requestId, workoutId: id })

  return { workout: updatedWorkout }
})
