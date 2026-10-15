/**
 * DELETE /api/zwift/drafts/:workoutId
 *
 * Discards the draft ("Revert to disk" / "Discard my edit"). Idempotent.
 */

import { and, eq } from 'drizzle-orm'
import { useDB } from '../../../../db'
import { zwiftWorkoutDrafts } from '../../../../db/schema'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const workoutId = Number(getRouterParam(event, 'workoutId'))
  if (!Number.isInteger(workoutId)) throw createError({ statusCode: 400, message: 'invalid id' })

  await useDB().delete(zwiftWorkoutDrafts)
    .where(and(eq(zwiftWorkoutDrafts.workoutId, workoutId), eq(zwiftWorkoutDrafts.userId, user.id)))

  getLogger('zwift').info('zwift.draft_discarded', { requestId: event.context.requestId, workoutId })
  return { ok: true }
})
