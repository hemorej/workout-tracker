/**
 * POST /api/workouts
 *
 * Creates a new workout entry for the authenticated user.
 *
 * Body (JSON):
 * {
 *   date:            string   — ISO date "YYYY-MM-DD" (defaults to today)
 *   name:            string   — workout name
 *   durationMinutes: number   — positive integer
 *   distanceKm?:     number   — optional, non-negative
 *   tss:             number   — non-negative integer
 *   rpe?:            number   — optional, 1–10
 *   notes?:          string   — optional free text
 *   ftpWatts?:       number   — optional, positive integer (watts)
 *   rideType?:       string   — optional, 'trainer' | 'outdoor'
 *   powerBests?:     { duration: string; watts: number }[]
 *   fitData?:        WorkoutFitData — optional, extra stats from a parsed FIT file
 *   laps?:           WorkoutLap[] — optional, per-lap splits from a parsed FIT file
 *   stravaActivityId?: number — optional, set when created via the "Mark as
 *                      completed" picker
 * }
 *
 * Returns:
 *   201 { workout }  on success
 *   400 for validation errors
 *   409 if a workout already exists for that date
 */

import { eq, and } from 'drizzle-orm'
import { workouts, powerBests, POWER_BEST_DURATIONS, type WorkoutFitData, type WorkoutLap } from '../../db/schema'
import { useDB } from '../../db'
import { invalidateMetrics } from '../../utils/metricsCache'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
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

  // Default to today if no date provided
  const date: string = body.date || new Date().toISOString().slice(0, 10)

  // Basic ISO date format check
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

  let stravaActivityId: number | null = null
  if (body.stravaActivityId !== undefined && body.stravaActivityId !== null) {
    stravaActivityId = Number(body.stravaActivityId)
    if (!Number.isInteger(stravaActivityId) || stravaActivityId <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'stravaActivityId must be a positive integer.' })
    }
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
    fitData = {
      avgPower: fd.avgPower,
      maxPower: fd.maxPower,
      normalizedPower: fd.normalizedPower,
      intensityFactor: fd.intensityFactor,
      avgHr: fd.avgHr ?? null,
      maxHr: fd.maxHr ?? null,
      avgCadence: fd.avgCadence ?? null,
      maxCadence: fd.maxCadence ?? null,
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
    // Reject duplicate durations in one submission
    const durations = pbInput.map((p) => p.duration)
    if (new Set(durations).size !== durations.length) {
      throw createError({ statusCode: 400, statusMessage: 'Each power best duration must be unique.' })
    }
  }

  // ── Duplicate check ───────────────────────────────────────────────────────

  const db = useDB()

  const [existing] = await db
    .select({ id: workouts.id })
    .from(workouts)
    .where(and(eq(workouts.userId, user.id), eq(workouts.date, date)))
    .limit(1)

  if (existing) {
    throw createError({
      statusCode: 409,
      statusMessage: `A workout is already logged for ${date}. Delete it first to replace it.`,
    })
  }

  // ── Insert ────────────────────────────────────────────────────────────────

  const inserted = await db
    .insert(workouts)
    .values({
      userId: user.id,
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
      stravaActivityId,
    })
    .returning()

  const newWorkout = inserted[0]
  if (!newWorkout) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to create workout.' })
  }

  if (pbInput.length > 0) {
    await db.insert(powerBests).values(
      pbInput.map((pb) => ({ workoutId: newWorkout.id, duration: pb.duration, watts: pb.watts })),
    )
  }

  // Invalidate the metrics cache so the next GET recomputes with the new workout
  invalidateMetrics(user.id)

  getLogger('workouts').info('workouts.created', { requestId: event.context.requestId, workoutId: newWorkout.id })

  setResponseStatus(event, 201)
  return { workout: newWorkout }
})
