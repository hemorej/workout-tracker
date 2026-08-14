/**
 * GET /api/users/me
 *
 * Returns the authenticated user's editable profile fields — weight and
 * training plan (see server/db/schema.ts). Backs the header's user settings
 * dialog; neither field lives in the session, so the dialog fetches them
 * fresh on open rather than reading useUserSession().
 *
 * Returns:
 *   200 { weightKg: number | null, trainingPlan: string | null }
 */

import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import { useDB } from '../../db'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const db = useDB()

  const [row] = await db
    .select({ weightKg: users.weightKg, trainingPlan: users.trainingPlan })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)

  return {
    weightKg: row?.weightKg ?? null,
    trainingPlan: row?.trainingPlan ?? null,
  }
})
