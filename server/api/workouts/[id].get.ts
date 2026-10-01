/**
 * GET /api/workouts/:id
 *
 * Returns the heavy FIT-derived JSONB (`fitData`, `laps`) for one workout —
 * the ride-stats overlay loads these on demand, so the paginated list in
 * GET /api/workouts can leave them out (it returns `hasFitData` instead).
 *
 * Filters by both `id` AND `userId` (IDOR protection), like every other
 * workout route. Returns 404 if the workout doesn't exist or isn't the
 * caller's.
 */

import { and, eq } from 'drizzle-orm'
import { workouts } from '../../db/schema'
import { useDB } from '../../db'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid workout ID.' })
  }

  const [row] = await useDB()
    .select({ fitData: workouts.fitData, laps: workouts.laps })
    .from(workouts)
    .where(and(eq(workouts.id, id), eq(workouts.userId, user.id)))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'Workout not found.' })
  }

  return row
})
