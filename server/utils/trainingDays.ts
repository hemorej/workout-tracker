/**
 * Shared builder for the Training tab's per-day view model.
 *
 * Merges `workouts` (the logged ride, at most one per day) and
 * `planned_workouts` (the plan, at most one per day) by date and attaches the
 * day's form metrics:
 *   - "actual" days (a ride exists, or the date is before today) read the
 *     cached CTL/ATL/TSB series;
 *   - every other day (today until it is ridden, and the future) is projected
 *     forward from the previous day using the planned TSS — same EMA constants
 *     as server/utils/tss.ts.
 *
 * Used by GET /api/training/days and GET /api/training/search.
 */

import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import { plannedWorkouts, powerBests, users, workouts } from '../db/schema'
import { useDB } from '../db'
import { getMetricsSeries } from './metricsCache'
import type { FormMetrics, PlanEntry, PowerBestEntry, TrainingDay, TrainingSummary, WorkoutDetail } from '#shared/types/training'

const CTL_DECAY = 1 / 42
const ATL_DECAY = 1 / 7

const round1 = (n: number) => Math.round(n * 10) / 10

export function toPlanEntry(row: { id: number, name: string | null, type: string | null, tss: number | null, durationMinutes: number | null, notes: string | null }): PlanEntry {
  return { id: row.id, name: row.name, type: row.type, tss: row.tss, durationMinutes: row.durationMinutes, notes: row.notes }
}

/** Columns of a logged ride, minus the heavy fit_data / laps JSONB (a `hasFitData` flag stands in). */
export const rideColumns = {
  id: workouts.id,
  date: workouts.date,
  name: workouts.name,
  durationMinutes: workouts.durationMinutes,
  distanceKm: workouts.distanceKm,
  tss: workouts.tss,
  rpe: workouts.rpe,
  notes: workouts.notes,
  ftpWatts: workouts.ftpWatts,
  rideType: workouts.rideType,
  hasFitData: sql<boolean>`${workouts.fitData} is not null`,
  stravaActivityId: workouts.stravaActivityId,
}

export function selectRides(where: SQL | undefined) {
  return useDB().select(rideColumns).from(workouts).where(where)
}

/** Rides keyed by date, each carrying its PR power bests. */
function ridesByDate(rides: Awaited<ReturnType<typeof selectRides>>, bests: { workoutId: number, duration: string, watts: number }[]): Map<string, WorkoutDetail> {
  const bestsById = new Map<number, PowerBestEntry[]>()
  for (const { workoutId, duration, watts } of bests) {
    const list = bestsById.get(workoutId)
    if (list) list.push({ duration, watts })
    else bestsById.set(workoutId, [{ duration, watts }])
  }

  const byDate = new Map<string, WorkoutDetail>()
  for (const r of rides) {
    const { date, ...rest } = r
    byDate.set(date, { ...rest, rideType: r.rideType as WorkoutDetail['rideType'], powerBests: bestsById.get(r.id) ?? [] })
  }
  return byDate
}

/**
 * Whole-week day list for [from, to] (both must be Mondays / Sundays — the
 * callers align them), ascending.
 */
export async function buildTrainingDays(userId: number, from: string, to: string): Promise<{ days: TrainingDay[], hasOlder: boolean }> {
  const db = useDB()
  const today = localDateIso()

  const [series, planRows, rideRows, bestRows] = await Promise.all([
    getMetricsSeries(userId),
    db.select().from(plannedWorkouts).where(and(
      eq(plannedWorkouts.userId, userId),
      gte(plannedWorkouts.date, from),
      lte(plannedWorkouts.date, to),
    )),
    selectRides(and(eq(workouts.userId, userId), gte(workouts.date, from), lte(workouts.date, to))),
    // Joined on the same window so it runs alongside the rides query instead of after it.
    db.select({ workoutId: powerBests.workoutId, duration: powerBests.duration, watts: powerBests.watts })
      .from(powerBests)
      .innerJoin(workouts, eq(powerBests.workoutId, workouts.id))
      .where(and(eq(workouts.userId, userId), gte(workouts.date, from), lte(workouts.date, to))),
  ])

  const seriesByDate = new Map(series.map(d => [d.date, d]))
  const planByDate = new Map(planRows.map(r => [r.date, toPlanEntry(r)]))
  const rideByDate = ridesByDate(rideRows, bestRows)

  // Carry = form at the end of the day before `from`; falls back to the user's
  // seed values when the series doesn't reach that far back.
  const before = seriesByDate.get(addDaysIso(from, -1))
  let ctl: number
  let atl: number
  if (before) {
    ctl = before.ctl
    atl = before.atl
  }
  else {
    const [seed] = await db
      .select({ initialCtl: users.initialCtl, initialAtl: users.initialAtl })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    ctl = seed?.initialCtl ?? 0
    atl = seed?.initialAtl ?? ctl
  }

  const days: TrainingDay[] = []
  for (let date = from; date <= to; date = addDaysIso(date, 1)) {
    const plan = planByDate.get(date) ?? null
    const ride = rideByDate.get(date) ?? null
    const isPast = date < today

    if (ride || isPast) {
      const actual = seriesByDate.get(date)
      if (actual) {
        ctl = actual.ctl
        atl = actual.atl
      }
    }
    else {
      const tss = plan?.tss ?? 0
      ctl = tss * CTL_DECAY + ctl * (1 - CTL_DECAY)
      atl = tss * ATL_DECAY + atl * (1 - ATL_DECAY)
    }

    days.push({
      date,
      plan,
      ride,
      metrics: { ctl: round1(ctl), atl: round1(atl), tsb: round1(ctl - atl) },
      isToday: date === today,
      isPast,
    })
  }

  return { days, hasOlder: !!series[0] && series[0].date < from }
}

/** Always-global headline numbers (unaffected by the requested range). */
export async function buildTrainingSummary(userId: number): Promise<TrainingSummary> {
  const series = await getMetricsSeries(userId)
  const form = (d: FormMetrics | undefined): FormMetrics | null => d ? { ctl: d.ctl, atl: d.atl, tsb: d.tsb } : null

  let min = Infinity
  let max = -Infinity
  // Trailing year, not all-time, so the ramp-up from the seed (or one career-best peak) doesn't pin the scale.
  for (const d of series.slice(-365)) {
    if (d.ctl < min) min = d.ctl
    if (d.ctl > max) max = d.ctl
  }

  return {
    today: form(series.at(-1)) ?? { ctl: 0, atl: 0, tsb: 0 },
    weekAgo: form(series.at(-8)),
    ctlRange: Number.isFinite(min) ? { min, max } : null,
  }
}
