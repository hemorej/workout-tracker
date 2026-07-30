/**
 * DELETE /api/planned-workouts/:date
 *
 * Removes a planned workout for the given date.
 */

import { eq, and } from 'drizzle-orm'
import { plannedWorkouts } from '../../db/schema'
import { useDB } from '../../db'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const date = getRouterParam(event, 'date')

  if (!date) throw createError({ statusCode: 400, message: 'date is required' })

  const db = useDB()
  await db
    .delete(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, user.id), eq(plannedWorkouts.date, date)))

  getLogger('planned_workouts').info('planned_workouts.deleted', { requestId: event.context.requestId, date })

  return { ok: true }
})
