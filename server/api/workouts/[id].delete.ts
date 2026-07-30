/**
 * DELETE /api/workouts/:id
 *
 * Deletes a workout by its ID.
 * Only the workout's owner can delete it — we always filter by both
 * `id` AND `userId` to prevent one user from deleting another user's data.
 *
 * Returns:
 *   200 { ok: true }   on success
 *   404 if the workout doesn't exist or belongs to a different user
 */

import { and, eq } from 'drizzle-orm'
import { workouts } from '../../db/schema'
import { useDB } from '../../db'
import { invalidateMetrics } from '../../utils/metricsCache'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid workout ID.' })
  }

  const db = useDB()

  // Delete only if the row belongs to the authenticated user
  const deleted = await db
    .delete(workouts)
    .where(and(eq(workouts.id, id), eq(workouts.userId, user.id)))
    .returning({ id: workouts.id })

  if (deleted.length === 0) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Workout not found.',
    })
  }

  // Invalidate the metrics cache so the next GET recomputes without this workout
  invalidateMetrics(user.id)

  getLogger('workouts').info('workouts.deleted', { requestId: event.context.requestId, workoutId: id })

  return { ok: true }
})
