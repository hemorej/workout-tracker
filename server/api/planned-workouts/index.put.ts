/**
 * PUT /api/planned-workouts
 *
 * Upserts a planned workout for a given date.
 * If name/type/tss/durationMinutes are all null/empty, deletes the row instead.
 *
 * Body: { date, name?, type?, tss?, durationMinutes?, notes? }
 */

import { eq, and } from 'drizzle-orm'
import { plannedWorkouts } from '../../db/schema'
import { useDB } from '../../db'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const body = await readBody(event)

  const { date, name, type, tss, durationMinutes, notes } = body ?? {}
  if (!date || typeof date !== 'string') {
    throw createError({ statusCode: 400, message: 'date is required' })
  }

  const db = useDB()

  // Upsert: delete existing row for this user+date, then insert the new values
  await db
    .delete(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, user.id), eq(plannedWorkouts.date, date)))

  await db.insert(plannedWorkouts).values({
    userId: user.id,
    date,
    name: name || null,
    type: type || null,
    tss: tss != null ? Number(tss) : null,
    durationMinutes: durationMinutes != null ? Number(durationMinutes) : null,
    notes: notes || null,
  })

  getLogger('planned_workouts').info('planned_workouts.upserted', { requestId: event.context.requestId, date })

  return { ok: true }
})
