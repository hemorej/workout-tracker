/**
 * GET /api/training/days
 * GET /api/training/days?from=2026-11-02&to=2026-11-15
 *
 * The Training tab's week grid: one TrainingDay per calendar day (plan + ride +
 * form metrics, see server/utils/trainingDays.ts), as whole Monday–Sunday weeks.
 *
 * Without params it returns the initial window: last week, the current week and
 * the next two — extended through the last planned week when plans run further.
 * With params it returns the weeks covering [from, to] (≤ 53 weeks), which is how
 * older weeks load on scroll and how the tab refreshes after a write.
 *
 * Response: { days, summary, hasOlder } — see TrainingDaysResponse.
 */

import { desc, eq } from 'drizzle-orm'
import { plannedWorkouts } from '../../db/schema'
import { useDB } from '../../db'
import { buildTrainingDays, buildTrainingSummary } from '../../utils/trainingDays'
import type { TrainingDaysResponse } from '#shared/types/training'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_WEEKS = 53

export default defineEventHandler(async (event): Promise<TrainingDaysResponse> => {
  const { user } = await requireUserSession(event)
  const query = getQuery(event)

  const currentMonday = mondayOf(localDateIso())
  let from: string
  let to: string

  if (typeof query.from === 'string' && ISO_DATE_RE.test(query.from)) {
    from = mondayOf(query.from)
    to = typeof query.to === 'string' && ISO_DATE_RE.test(query.to) ? addDaysIso(mondayOf(query.to), 6) : addDaysIso(currentMonday, 20)
    if (to < from) throw createError({ statusCode: 400, message: 'to must not be before from' })
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 >= MAX_WEEKS * 7) {
      throw createError({ statusCode: 400, message: `Range is limited to ${MAX_WEEKS} weeks` })
    }
  }
  else {
    from = addDaysIso(currentMonday, -7)
    to = addDaysIso(currentMonday, 20)
    const [lastPlanned] = await useDB()
      .select({ date: plannedWorkouts.date })
      .from(plannedWorkouts)
      .where(eq(plannedWorkouts.userId, user.id))
      .orderBy(desc(plannedWorkouts.date))
      .limit(1)
    if (lastPlanned && lastPlanned.date > to) to = addDaysIso(mondayOf(lastPlanned.date), 6)
  }

  const [{ days, hasOlder }, summary] = await Promise.all([
    buildTrainingDays(user.id, from, to),
    buildTrainingSummary(user.id),
  ])
  return { days, summary, hasOlder }
})
