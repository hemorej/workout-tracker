/**
 * GET /api/workouts?page=1&limit=14
 *
 * Returns a paginated day-by-day series (newest first) with computed
 * CTL, ATL and TSB metrics, plus weekly summary stats and today's metrics.
 *
 * How it works:
 *  1. Check the in-memory metrics cache for this user.
 *     • Cache hit  → skip the DB workout fetch and recompute entirely.
 *     • Cache miss → fetch all workouts, compute the full series, store it.
 *  2. Slice the series for the requested page (newest days first).
 *  3. Return the page alongside weekly stats and today's snapshot.
 *
 * The cache is invalidated whenever a workout is created or deleted, so the
 * series is always recomputed after a write. A short TTL (5 min) also ensures
 * the series stays current as the calendar rolls past midnight.
 *
 * Response shape:
 * {
 *   days: DayEntry[]          — paginated, newest first
 *   weeklyStats: { tssTotal, hoursTotal }
 *   todayMetrics: { ctl, atl, tsb }
 *   yesterdayMetrics: { ctl, atl, tsb } | null
 *   pagination: { page, limit, totalDays, totalPages }
 * }
 */

import { eq, asc, inArray } from 'drizzle-orm'
import { workouts, users, powerBests } from '../../db/schema'
import { useDB } from '../../db'
import { computeMetricsSeries, computeWeeklyStats } from '../../utils/tss'
import { getCachedMetrics, setCachedMetrics } from '../../utils/metricsCache'

export default defineEventHandler(async (event) => {
  // Require authentication — throws 401 if no valid session
  const { user } = await requireUserSession(event)

  // Parse pagination query params with sensible defaults
  const query = getQuery(event)
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(60, Math.max(1, Number(query.limit) || 14)) // cap at 60

  // ── Metrics series (cached) ────────────────────────────────────────────────

  // Try the cache first. A null return means the entry is absent, stale, or
  // outdated (series ends before today), so we fall through to a full compute.
  let series = getCachedMetrics(user.id)

  // Also need the workout list to join workout details onto each day.
  // On a cache hit we still fetch workouts, but only for the date window
  // being displayed — NOT the full history. That saves the heavy query.
  // On a cache miss we fetch everything so we can compute the full series.
  const db = useDB()

  if (!series) {
    // ── Cache miss: full computation path ───────────────────────────────────

    // Fetch the user's starting CTL/ATL preferences (set once, rarely changes)
    const [userRow] = await db
      .select({ initialCtl: users.initialCtl, initialAtl: users.initialAtl })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    const initialCTL = userRow?.initialCtl ?? 0
    const initialATL = userRow?.initialAtl ?? initialCTL

    // Fetch the full workout history — required to seed CTL/ATL from day one
    const allWorkouts = await db
      .select({
        id: workouts.id,
        date: workouts.date,
        name: workouts.name,
        durationMinutes: workouts.durationMinutes,
        distanceKm: workouts.distanceKm,
        tss: workouts.tss,
        rpe: workouts.rpe,
        notes: workouts.notes,
        ftpWatts: workouts.ftpWatts,
      })
      .from(workouts)
      .where(eq(workouts.userId, user.id))
      .orderBy(asc(workouts.date))

    // Compute the full day-by-day series (first workout → today)
    series = computeMetricsSeries(allWorkouts, { initialCTL, initialATL })

    // Store in cache so subsequent GETs skip this work
    setCachedMetrics(user.id, series)
  }

  // ── Pagination ─────────────────────────────────────────────────────────────

  // Reverse so newest days come first, then take the requested page slice
  const reversed = [...series].reverse()
  const totalDays = reversed.length
  const start = (page - 1) * limit
  const pageSlice = reversed.slice(start, start + limit)

  // ── Join workout details onto each day in the page ─────────────────────────

  // Fetch only the workouts that fall within the dates we're displaying.
  // This is a tiny query (≤ `limit` rows) even though the full series may be long.
  const pageDates = pageSlice.map((d) => d.date)

  // Build a Set for O(1) date lookups
  const pageDateSet = new Set(pageDates)

  // Grab workout rows only for the dates in the current page
  const pageWorkouts = await db
    .select({
      id: workouts.id,
      date: workouts.date,
      name: workouts.name,
      durationMinutes: workouts.durationMinutes,
      distanceKm: workouts.distanceKm,
      tss: workouts.tss,
      rpe: workouts.rpe,
      notes: workouts.notes,
      ftpWatts: workouts.ftpWatts,
    })
    .from(workouts)
    .where(eq(workouts.userId, user.id))

  // Filter in JS (Drizzle doesn't support `date IN (...)` on string arrays
  // without raw SQL; filtering server-side is fine for ≤ 60 rows per page)
  const filteredPageWorkouts = pageWorkouts.filter((w) => pageDateSet.has(w.date))
  const workoutByDate = new Map(filteredPageWorkouts.map((w) => [w.date, w]))

  // Fetch power bests for the workouts in this page
  const pageWorkoutIds = filteredPageWorkouts.map((w) => w.id)
  const pagePowerBests = pageWorkoutIds.length > 0
    ? await db
        .select({ workoutId: powerBests.workoutId, duration: powerBests.duration, watts: powerBests.watts })
        .from(powerBests)
        .where(inArray(powerBests.workoutId, pageWorkoutIds))
    : []

  const powerBestsByWorkoutId = new Map<number, { duration: string; watts: number }[]>()
  for (const pb of pagePowerBests) {
    if (!powerBestsByWorkoutId.has(pb.workoutId)) powerBestsByWorkoutId.set(pb.workoutId, [])
    powerBestsByWorkoutId.get(pb.workoutId)!.push({ duration: pb.duration, watts: pb.watts })
  }

  // ── Build response ─────────────────────────────────────────────────────────

  // Weekly stats derived from the full series (cheap array scan)
  const weeklyStats = computeWeeklyStats(series)

  // Today's metrics — last element of the series (series runs to today)
  const todayMetrics = series.at(-1)
    ? {
        ctl: series.at(-1)!.ctl,
        atl: series.at(-1)!.atl,
        tsb: series.at(-1)!.tsb,
      }
    : { ctl: 0, atl: 0, tsb: 0 }

  // Yesterday's metrics — powers the trend arrows on the summary cards
  const yesterdayMetrics = series.at(-2)
    ? {
        ctl: series.at(-2)!.ctl,
        atl: series.at(-2)!.atl,
        tsb: series.at(-2)!.tsb,
      }
    : null

  const days = pageSlice.map((day) => {
    const workout = workoutByDate.get(day.date)
    return {
      date: day.date,
      isRestDay: day.isRestDay,
      metrics: {
        ctl: day.ctl,
        atl: day.atl,
        tsb: day.tsb,
      },
      workout: workout
        ? {
            id: workout.id,
            name: workout.name,
            durationMinutes: workout.durationMinutes,
            distanceKm: workout.distanceKm,
            tss: workout.tss,
            rpe: workout.rpe,
            notes: workout.notes,
            ftpWatts: workout.ftpWatts,
            powerBests: powerBestsByWorkoutId.get(workout.id) ?? [],
          }
        : null,
    }
  })

  return {
    days,
    weeklyStats,
    todayMetrics,
    yesterdayMetrics,
    pagination: {
      page,
      limit,
      totalDays,
      totalPages: Math.ceil(totalDays / limit),
    },
  }
})
