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
 *   powerBests?:     { duration: string; watts: number }[]
 * }
 *
 * Returns:
 *   201 { workout }  on success
 *   400 for validation errors
 *   409 if a workout already exists for that date
 */

import { eq, and } from 'drizzle-orm'
import { workouts, powerBests, POWER_BEST_DURATIONS } from '../../db/schema'
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

  setResponseStatus(event, 201)
  return { workout: newWorkout }
})
