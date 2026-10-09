/**
 * PUT /api/planned-workouts/batch
 *
 * Upserts many planned workouts and/or deletes some, in one transaction.
 * Backs the Planning tab's "Suggest plan" Apply and its Undo.
 *
 * Body: { entries?: Array<{ date, name?, type?, tss?, durationMinutes?, notes? }>, deleteDates?: string[] }
 *
 * Unlike the single-row PUT, an upsert here replaces every field (a missing
 * field becomes null) — Apply/Undo restore whole entries, not partial edits.
 */

import { and, eq, inArray } from 'drizzle-orm'
import { plannedWorkouts } from '../../db/schema'
import { useDB } from '../../db'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_ROWS = 120

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const body = await readBody(event)

  const entries: unknown[] = Array.isArray(body?.entries) ? body.entries : []
  const deleteDates: unknown[] = Array.isArray(body?.deleteDates) ? body.deleteDates : []
  if (entries.length + deleteDates.length > MAX_ROWS) {
    throw createError({ statusCode: 400, message: `At most ${MAX_ROWS} rows per batch` })
  }
  if (deleteDates.some(d => typeof d !== 'string' || !DATE_RE.test(d))) {
    throw createError({ statusCode: 400, message: 'deleteDates must be YYYY-MM-DD strings' })
  }

  const rows = entries.map((e) => {
    const { date, name, type, tss, durationMinutes, notes } = (e ?? {}) as Record<string, unknown>
    if (typeof date !== 'string' || !DATE_RE.test(date)) {
      throw createError({ statusCode: 400, message: 'every entry needs a YYYY-MM-DD date' })
    }
    return {
      userId: user.id,
      date,
      name: typeof name === 'string' && name ? name : null,
      type: typeof type === 'string' && type ? type : null,
      tss: tss != null ? Number(tss) : null,
      durationMinutes: durationMinutes != null ? Number(durationMinutes) : null,
      notes: typeof notes === 'string' && notes ? notes : null,
    }
  })

  const db = useDB()
  await db.transaction(async (tx) => {
    if (deleteDates.length) {
      await tx.delete(plannedWorkouts).where(and(
        eq(plannedWorkouts.userId, user.id),
        inArray(plannedWorkouts.date, deleteDates as string[]),
      ))
    }
    for (const row of rows) {
      await tx
        .insert(plannedWorkouts)
        .values(row)
        .onConflictDoUpdate({
          target: [plannedWorkouts.userId, plannedWorkouts.date],
          set: { name: row.name, type: row.type, tss: row.tss, durationMinutes: row.durationMinutes, notes: row.notes },
        })
    }
  })

  getLogger('planned_workouts').info('planned_workouts.batch_applied', {
    requestId: event.context.requestId,
    upserted: rows.length,
    deleted: deleteDates.length,
  })

  return { ok: true }
})
