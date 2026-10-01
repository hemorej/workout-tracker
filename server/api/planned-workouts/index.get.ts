/**
 * GET /api/planned-workouts
 *
 * Returns 4+ weeks (more if later days are planned) of planned workouts starting from the current Monday,
 * plus projected CTL and TSB values for each day based on:
 *   - CTL/ATL as of the end of yesterday, from the user's actual training history
 *   - planned TSS values for each future day (or the actual logged TSS for
 *     today, once a workout has been logged — that day's row then reuses the
 *     historical series value directly instead of re-projecting)
 *
 * Response shape:
 * {
 *   plans: PlannedDay[]   — 28+ days, Monday–Sunday × 4+ weeks
 *   currentCtl: number    — seed CTL for future projections (yesterday's value)
 *   currentAtl: number    — seed ATL for future projections (yesterday's value)
 * }
 */

import { eq, desc, and, gte, lte, inArray } from 'drizzle-orm'
import { plannedWorkouts, workouts, users } from '../../db/schema'
import { useDB } from '../../db'
import { getMetricsSeries } from '../../utils/metricsCache'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const db = useDB()

  // Get the metrics series (cache or full compute) — includes today, reflecting
  // any workout already logged today
  const series = await getMetricsSeries(user.id)
  const seriesByDate = new Map(series.map(d => [d.date, d]))

  // Build 4 weeks of dates starting from current week's Monday
  const today = new Date()
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))
  const dayOfWeek = todayUtc.getUTCDay()
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const monday = new Date(todayUtc)
  monday.setUTCDate(todayUtc.getUTCDate() - daysFromMonday)

  // At least 4 weeks, extended to whole weeks so any later planned day (e.g. in
  // a week added with "Add week") is still returned after a reload.
  const [lastPlanned] = await db
    .select({ date: plannedWorkouts.date })
    .from(plannedWorkouts)
    .where(eq(plannedWorkouts.userId, user.id))
    .orderBy(desc(plannedWorkouts.date))
    .limit(1)
  let dayCount = 28
  if (lastPlanned) {
    const span = Math.floor((new Date(`${lastPlanned.date}T00:00:00Z`).getTime() - monday.getTime()) / 86_400_000) + 1
    dayCount = Math.max(28, Math.ceil(span / 7) * 7)
  }

  const dates: string[] = []
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(monday)
    d.setUTCDate(monday.getUTCDate() + i)
    dates.push(d.toISOString().slice(0, 10))
  }

  const todayStr = todayUtc.toISOString().slice(0, 10)
  const yesterdayUtc = new Date(todayUtc)
  yesterdayUtc.setUTCDate(yesterdayUtc.getUTCDate() - 1)
  const yesterdayStr = yesterdayUtc.toISOString().slice(0, 10)

  // Today counts as "logged" (and therefore read-only, like a past day) once
  // an actual workout exists for it — otherwise its row is still projected
  // from the planned TSS like any future day.
  const todayEntry = seriesByDate.get(todayStr)
  const isTodayLogged = !!todayEntry && !todayEntry.isRestDay

  // Actual logged totals per day, for past days only — lets the UI show what
  // really happened instead of just the plan. Summed per date since a day can
  // have more than one logged workout but the grid is one row per day.
  const actualRows = await db
    .select({ date: workouts.date, tss: workouts.tss, durationMinutes: workouts.durationMinutes })
    .from(workouts)
    .where(and(eq(workouts.userId, user.id), inArray(workouts.date, dates)))

  const actualByDate = new Map<string, { tss: number, durationMinutes: number }>()
  for (const row of actualRows) {
    const existing = actualByDate.get(row.date) ?? { tss: 0, durationMinutes: 0 }
    existing.tss += row.tss
    existing.durationMinutes += row.durationMinutes
    actualByDate.set(row.date, existing)
  }

  // Seed for future-day projections is CTL/ATL as of the END of yesterday —
  // using today's own series entry here would double-count today's load
  // once it's logged, since the projection loop below applies today's TSS
  // (planned or actual) itself.
  const yesterdayEntry = seriesByDate.get(yesterdayStr)
  let currentCtl: number
  let currentAtl: number
  if (yesterdayEntry) {
    currentCtl = yesterdayEntry.ctl
    currentAtl = yesterdayEntry.atl
  }
  else {
    // No training history through yesterday (e.g. earliest workout is today
    // or later) — fall back to the user's initial seed values.
    const [userRow] = await db
      .select({ initialCtl: users.initialCtl, initialAtl: users.initialAtl })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    currentCtl = userRow?.initialCtl ?? 0
    currentAtl = userRow?.initialAtl ?? currentCtl
  }

  // Fetch existing planned workouts for this window
  const rows = await db
    .select()
    .from(plannedWorkouts)
    .where(and(
      eq(plannedWorkouts.userId, user.id),
      gte(plannedWorkouts.date, dates[0]!),
      lte(plannedWorkouts.date, dates.at(-1)!),
    ))

  const planByDate = new Map(rows.map(r => [r.date, r]))

  // Compute projections day by day — must match the decay constants in
  // server/utils/tss.ts (the TrainingPeaks/Coggan PMC standard: TSS delta / N)
  const CTL_DECAY = 1 / 42
  const ATL_DECAY = 1 / 7
  let ctl = currentCtl
  let atl = currentAtl

  const plans = dates.map((date) => {
    const plan = planByDate.get(date)
    const isPast = date < todayStr || (date === todayStr && isTodayLogged)

    // For past days (and today, once logged), use actual series data if available
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
      const historical = seriesByDate.get(date)
      projCtl = historical?.ctl ?? ctl
      projAtl = historical?.atl ?? atl
      ctl = projCtl
      atl = projAtl
    }

    return {
      date,
      isPast,
      plan: plan
        ? { id: plan.id, name: plan.name, type: plan.type, tss: plan.tss, durationMinutes: plan.durationMinutes, notes: plan.notes }
        : null,
      actual: isPast ? (actualByDate.get(date) ?? { tss: 0, durationMinutes: 0 }) : null,
      projectedCtl: projCtl,
      projectedTsb: Math.round((projCtl - projAtl) * 10) / 10,
    }
  })

  return { plans, currentCtl, currentAtl }
})
