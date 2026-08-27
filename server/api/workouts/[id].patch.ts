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
 * Body (JSON): same shape as POST /api/workouts.
 *
 * powerBests, if provided, fully replaces the workout's existing power-best
 * rows (delete + reinsert) rather than merging — the simplest correct way to
 * handle both additions and removals from a freshly re-parsed file.
 *
 * Returns:
 *   200 { workout }  on success
 *   400 for validation errors
 *   404 if the workout doesn't exist or belongs to a different user
 */

import { eq, and, ne } from 'drizzle-orm'
import { workouts, powerBests, POWER_BEST_DURATIONS, type WorkoutFitData, type WorkoutLap } from '../../db/schema'
import { useDB } from '../../db'
import { invalidateMetrics } from '../../utils/metricsCache'

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

  let fitData: WorkoutFitData | null = null
  if (body.fitData !== undefined && body.fitData !== null) {
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
    }
  }

  let laps: WorkoutLap[] | null = null
  if (body.laps !== undefined && body.laps !== null) {
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

  const validDurations = new Set(POWER_BEST_DURATIONS as readonly string[])
  const pbInput: { duration: string; watts: number }[] = []
  if (Array.isArray(body.powerBests)) {
    for (const pb of body.powerBests) {
      if (!pb.duration || !validDurations.has(pb.duration)) {
        throw createError({ statusCode: 400, statusMessage: `Invalid power best duration: ${pb.duration}` })
      }
      const watts = Number(pb.watts)
      if (!Number.isInteger(watts) || watts <= 0) {
        throw createError({ statusCode: 400, statusMessage: 'Power best watts must be a positive integer.' })
      }
      pbInput.push({ duration: pb.duration, watts })
    }
    const durations = pbInput.map((p) => p.duration)
    if (new Set(durations).size !== durations.length) {
      throw createError({ statusCode: 400, statusMessage: 'Each power best duration must be unique.' })
    }
  }

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

  if (Array.isArray(body.powerBests)) {
    await db.delete(powerBests).where(eq(powerBests.workoutId, id))
    if (pbInput.length > 0) {
      await db.insert(powerBests).values(
        pbInput.map((pb) => ({ workoutId: id, duration: pb.duration, watts: pb.watts })),
      )
    }
  }

  invalidateMetrics(user.id)

  getLogger('workouts').info('workouts.updated', { requestId: event.context.requestId, workoutId: id })

  return { workout: updatedWorkout }
})
