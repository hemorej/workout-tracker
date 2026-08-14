/**
 * PUT /api/users/me
 *
 * Updates the authenticated user's weight and training plan (see
 * server/db/schema.ts) — previously only editable via `pnpm db:studio`/raw
 * SQL. The account row always already exists (accounts are created directly
 * in the DB, see CLAUDE.md), so this is a plain update, never an insert.
 *
 * Body (JSON):
 * {
 *   weightKg?:      number | null — optional, positive
 *   trainingPlan?:  string | null — optional free text
 * }
 *
 * Returns:
 *   200 { weightKg, trainingPlan }
 *   400 for validation errors
 */

import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import { useDB } from '../../db'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const body = await readBody(event)

  let weightKg: number | null = null
  if (body?.weightKg !== undefined && body.weightKg !== null && body.weightKg !== '') {
    weightKg = Number(body.weightKg)
    if (!Number.isFinite(weightKg) || weightKg <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Weight must be a positive number.' })
    }
  }

  const trainingPlan: string | null = typeof body?.trainingPlan === 'string' ? body.trainingPlan.trim() || null : null

  const db = useDB()

  const [updated] = await db
    .update(users)
    .set({ weightKg, trainingPlan })
    .where(eq(users.id, user.id))
    .returning({ weightKg: users.weightKg, trainingPlan: users.trainingPlan })

  if (!updated) {
    throw createError({ statusCode: 404, statusMessage: 'User not found.' })
  }

  getLogger('auth').info('users.settings_updated', { requestId: event.context.requestId, userId: user.id })

  return updated
})
