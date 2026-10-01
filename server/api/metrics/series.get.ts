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

import { getMetricsSeries } from '../../utils/metricsCache'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const query = getQuery(event)
  const weeks = Math.min(52, Math.max(1, Number(query.weeks) || 8))
  const days = weeks * 7

  const series = await getMetricsSeries(user.id)

  const sliced = series.slice(-days).map(d => ({ date: d.date, ctl: d.ctl, tsb: d.tsb }))

  return { series: sliced }
})
