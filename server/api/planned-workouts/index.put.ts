/**
 * PUT /api/planned-workouts
 *
 * Upserts a planned workout for a given date.
 * If name/type/tss/durationMinutes are all null/empty, deletes the row instead.
 *
 * Body: { date, name?, type?, tss?, durationMinutes?, notes? }
 */

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

  // Upsert in a single statement — the (user_id, date) unique index lets Postgres
  // resolve concurrent saves for the same day atomically. A separate delete-then-insert
  // is not safe here: two overlapping requests for the same date (e.g. a field's
  // "change" and "blur" events firing back to back) can each pass the delete before
  // either inserts, and the second insert then hits the unique constraint.
  const values = {
    userId: user.id,
    date,
    name: name || null,
    type: type || null,
    tss: tss != null ? Number(tss) : null,
    durationMinutes: durationMinutes != null ? Number(durationMinutes) : null,
    notes: notes || null,
  }

  // On conflict, only overwrite fields the caller actually included in the
  // body — callers that save a subset (e.g. the workout builder's fuelling-guide
  // save, which never sets `type`) must not clobber fields set by other callers
  // (e.g. the planning tab's zone `type`) for the same date.
  const updateValues: Partial<typeof values> = {}
  if ('name' in body) updateValues.name = values.name
  if ('type' in body) updateValues.type = values.type
  if ('tss' in body) updateValues.tss = values.tss
  if ('durationMinutes' in body) updateValues.durationMinutes = values.durationMinutes
  if ('notes' in body) updateValues.notes = values.notes

  await db
    .insert(plannedWorkouts)
    .values(values)
    .onConflictDoUpdate({
      target: [plannedWorkouts.userId, plannedWorkouts.date],
      set: updateValues,
    })

  getLogger('planned_workouts').info('planned_workouts.upserted', { requestId: event.context.requestId, date })

  return { ok: true }
})
