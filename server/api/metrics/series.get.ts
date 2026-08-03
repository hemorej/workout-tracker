/**
 * GET /api/metrics/series?weeks=8
 *
 * Returns a plain daily CTL/TSB series for the last `weeks` weeks (default 8,
 * clamped to 1–52), for charting. Reuses the same cached metrics series as
 * /api/workouts and /api/planned-workouts — see server/utils/metricsCache.ts.
 *
 * The `weeks` param keeps this endpoint modular: a future range-selector UI
 * only needs to change the query param, no server changes required.
 *
 * Response: { series: { date: string, ctl: number, tsb: number }[] }
 */

import { eq, asc } from 'drizzle-orm'
import { workouts, users } from '../../db/schema'
import { useDB } from '../../db'
import { computeMetricsSeries } from '../../utils/tss'
import { getCachedMetrics, setCachedMetrics } from '../../utils/metricsCache'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const db = useDB()

  const query = getQuery(event)
  const weeks = Math.min(52, Math.max(1, Number(query.weeks) || 8))
  const days = weeks * 7

  let series = getCachedMetrics(user.id)
  if (!series) {
    const [userRow] = await db
      .select({ initialCtl: users.initialCtl, initialAtl: users.initialAtl })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    const allWorkouts = await db
      .select({ date: workouts.date, tss: workouts.tss, durationMinutes: workouts.durationMinutes })
      .from(workouts)
      .where(eq(workouts.userId, user.id))
      .orderBy(asc(workouts.date))

    series = computeMetricsSeries(allWorkouts, {
      initialCTL: userRow?.initialCtl ?? 0,
      initialATL: userRow?.initialAtl ?? userRow?.initialCtl ?? 0,
    })
    setCachedMetrics(user.id, series)
  }

  const sliced = series.slice(-days).map(d => ({ date: d.date, ctl: d.ctl, tsb: d.tsb }))

  return { series: sliced }
})
