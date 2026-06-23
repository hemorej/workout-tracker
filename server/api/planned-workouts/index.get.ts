/**
 * GET /api/planned-workouts
 *
 * Returns 4 weeks of planned workouts starting from the current Monday,
 * plus projected CTL and TSB values for each day based on:
 *   - current CTL/ATL from the user's actual training history
 *   - planned TSS values for each future day
 *
 * Response shape:
 * {
 *   plans: PlannedDay[]   — 28 days, Monday–Sunday × 4 weeks
 *   currentCtl: number
 *   currentAtl: number
 * }
 */

import { eq, asc } from 'drizzle-orm'
import { plannedWorkouts, workouts, users } from '../../db/schema'
import { useDB } from '../../db'
import { computeMetricsSeries } from '../../utils/tss'
import { getCachedMetrics } from '../../utils/metricsCache'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const db = useDB()

  // Get current CTL/ATL from the metrics series (cache or full compute)
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
      initialATL: userRow?.initialAtl ?? 0,
    })
  }

  const lastDay = series.at(-1)
  const currentCtl = lastDay?.ctl ?? 0
  const currentAtl = lastDay?.atl ?? 0

  // Build 4 weeks of dates starting from current week's Monday
  const today = new Date()
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))
  const dayOfWeek = todayUtc.getUTCDay()
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const monday = new Date(todayUtc)
  monday.setUTCDate(todayUtc.getUTCDate() - daysFromMonday)

  const dates: string[] = []
  for (let i = 0; i < 28; i++) {
    const d = new Date(monday)
    d.setUTCDate(monday.getUTCDate() + i)
    dates.push(d.toISOString().slice(0, 10))
  }

  // Fetch existing planned workouts for this window
  const rows = await db
    .select()
    .from(plannedWorkouts)
    .where(eq(plannedWorkouts.userId, user.id))

  const planByDate = new Map(
    rows.filter(r => dates.includes(r.date)).map(r => [r.date, r]),
  )

  // Compute projections day by day
  const CTL_DECAY = 2 / (42 + 1)
  const ATL_DECAY = 2 / (7 + 1)
  let ctl = currentCtl
  let atl = currentAtl

  const todayStr = todayUtc.toISOString().slice(0, 10)

  const plans = dates.map((date) => {
    const plan = planByDate.get(date)
    const isPast = date < todayStr

    // For past days in the current week, use actual series data if available
    let projCtl = ctl
    let projAtl = atl

    if (!isPast) {
      const tss = plan?.tss ?? 0
      ctl = tss * CTL_DECAY + ctl * (1 - CTL_DECAY)
      atl = tss * ATL_DECAY + atl * (1 - ATL_DECAY)
      projCtl = Math.round(ctl * 10) / 10
      projAtl = Math.round(atl * 10) / 10
    }
    else {
      // Use actual historical data for past days
      const historical = series?.find(d => d.date === date)
      projCtl = historical?.ctl ?? ctl
      projAtl = historical?.atl ?? atl
      ctl = projCtl
      atl = projAtl
    }

    return {
      date,
      isPast,
      plan: plan
        ? { id: plan.id, name: plan.name, type: plan.type, tss: plan.tss, durationMinutes: plan.durationMinutes }
        : null,
      projectedCtl: projCtl,
      projectedTsb: Math.round((projCtl - projAtl) * 10) / 10,
    }
  })

  return { plans, currentCtl, currentAtl }
})
