/**
 * POST /api/zwift/drafts/:workoutId/rebase
 *
 * "Keep my edit": the draft stays as is, but is now based on the file
 * currently on disk — which clears its stale state.
 */

import { and, eq } from 'drizzle-orm'
import { useDB } from '../../../../db'
import { zwiftWorkouts, zwiftWorkoutDrafts } from '../../../../db/schema'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const workoutId = Number(getRouterParam(event, 'workoutId'))
  if (!Number.isInteger(workoutId)) throw createError({ statusCode: 400, message: 'invalid id' })

  const db = useDB()
  const [workout] = await db.select({ contentHash: zwiftWorkouts.contentHash }).from(zwiftWorkouts)
    .where(and(eq(zwiftWorkouts.id, workoutId), eq(zwiftWorkouts.userId, user.id)))
    .limit(1)
  if (!workout) throw createError({ statusCode: 404, message: 'Workout not found' })

  const updated = await db.update(zwiftWorkoutDrafts)
    .set({ baseHash: workout.contentHash, updatedAt: new Date() })
    .where(and(eq(zwiftWorkoutDrafts.workoutId, workoutId), eq(zwiftWorkoutDrafts.userId, user.id)))
    .returning({ id: zwiftWorkoutDrafts.id })
  if (!updated.length) throw createError({ statusCode: 404, message: 'No draft to re-base' })

  getLogger('zwift').info('zwift.draft_rebased', { requestId: event.context.requestId, workoutId })
  return { ok: true, baseHash: workout.contentHash }
})
