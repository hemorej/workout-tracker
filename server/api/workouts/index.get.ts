/**
 * GET /api/workouts?page=1&limit=14
 * GET /api/workouts?page=1&limit=14&name=intervals&type=zwift&minTss=85&minDistance=30&minDuration=60&dateFrom=2026-06-01&dateTo=2026-06-30
 *
 * Returns a paginated day-by-day series (newest first) with computed
 * CTL, ATL and TSB metrics, plus weekly summary stats and today's metrics.
 *
 * Two response modes, chosen automatically based on whether any filter
 * query param is present (this backs the training-log filter bar):
 *
 *  • Unfiltered (default) — the original calendar-day view. Every day from
 *    the first logged workout to today is represented, including rest days,
 *    via the cached CTL/ATL/TSB series. Pagination walks calendar days.
 *
 *  • Filtered — rest days are excluded by construction: the query goes
 *    straight at the `workouts` table with SQL WHERE clauses (indexed
 *    boundary comparisons for tss/distance/duration/date, an equality
 *    match for ride type, a `name ILIKE '%term%'` substring match) and
 *    LIMIT/OFFSET pagination over matching rows. This scales with the
 *    number of *matches*, not with total calendar days, which matters
 *    once the log spans years. CTL/ATL/TSB per row are still pulled from
 *    the cached series (O(1) map lookup) rather than recomputed.
 *
 * The metrics series itself is cached — see server/utils/metricsCache.ts.
 * It is invalidated on every workout write and rebuilt on the next GET.
 *
 * Response shape:
 * {
 *   days: DayEntry[]          — paginated, newest first
 *   weeklyStats: { tssTotal, hoursTotal, kmTotal }
 *   todayMetrics: { ctl, atl, tsb }
 *   yesterdayMetrics: { ctl, atl, tsb } | null
 *   pagination: { page, limit, totalDays, totalPages }
 * }
 */

import { eq, asc, desc, and, gte, lte, ilike, inArray, sql, type SQL } from 'drizzle-orm'
import { workouts, users, powerBests, type WorkoutFitData, type WorkoutInsights } from '../../db/schema'
import { useDB } from '../../db'
import { computeMetricsSeries, computeWeeklyStats, type DayMetrics } from '../../utils/tss'
import { getCachedMetrics, setCachedMetrics } from '../../utils/metricsCache'

/** Escapes LIKE wildcard characters so search text is matched literally */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export default defineEventHandler(async (event) => {
  // Require authentication — throws 401 if no valid session
  const { user } = await requireUserSession(event)

  // Parse pagination query params with sensible defaults
  const query = getQuery(event)
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(60, Math.max(1, Number(query.limit) || 14)) // cap at 60

  // ── Filter bar query params ─────────────────────────────────────────────────

  const rawType = typeof query.type === 'string' ? query.type : 'all'
  const type: 'all' | 'zwift' | 'outdoor' = rawType === 'zwift' || rawType === 'outdoor' ? rawType : 'all'
  const name = typeof query.name === 'string' ? query.name.trim() : ''
  const minTss = Math.max(0, Number(query.minTss) || 0)
  const minDistance = Math.max(0, Number(query.minDistance) || 0)
  const minDuration = Math.max(0, Number(query.minDuration) || 0)
  const dateFrom = typeof query.dateFrom === 'string' && ISO_DATE_RE.test(query.dateFrom) ? query.dateFrom : ''
  const dateTo = typeof query.dateTo === 'string' && ISO_DATE_RE.test(query.dateTo) ? query.dateTo : ''

  const hasFilters = name !== '' || type !== 'all' || minTss > 0 || minDistance > 0 || minDuration > 0 || dateFrom !== '' || dateTo !== ''

  // ── Metrics series (cached) ────────────────────────────────────────────────

  // Try the cache first. A null return means the entry is absent, stale, or
  // outdated (series ends before today), so we fall through to a full compute.
  let series = getCachedMetrics(user.id)

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
        rideType: workouts.rideType,
        fitData: workouts.fitData,
      })
      .from(workouts)
      .where(eq(workouts.userId, user.id))
      .orderBy(asc(workouts.date))

    // Compute the full day-by-day series (first workout → today)
    series = computeMetricsSeries(allWorkouts, { initialCTL, initialATL })

    // Store in cache so subsequent GETs skip this work
    setCachedMetrics(user.id, series)
  }

  // O(1) date → metrics lookups, used for both branches below.
  const seriesByDate = new Map<string, DayMetrics>(series.map((d) => [d.date, d]))

  function metricsForDate(date: string) {
    const entry = seriesByDate.get(date)
    return entry ? { ctl: entry.ctl, atl: entry.atl, tsb: entry.tsb } : { ctl: 0, atl: 0, tsb: 0 }
  }

  // ── Weekly / today / yesterday stats — always global, unaffected by filters ─

  const weeklyStats = computeWeeklyStats(series)

  const todayMetrics = series.at(-1)
    ? { ctl: series.at(-1)!.ctl, atl: series.at(-1)!.atl, tsb: series.at(-1)!.tsb }
    : { ctl: 0, atl: 0, tsb: 0 }

  const yesterdayMetrics = series.at(-2)
    ? { ctl: series.at(-2)!.ctl, atl: series.at(-2)!.atl, tsb: series.at(-2)!.tsb }
    : null

  // ── Row shape shared by both branches ───────────────────────────────────────

  type WorkoutRow = {
    id: number
    date: string
    name: string
    durationMinutes: number
    distanceKm: number | null
    tss: number
    rpe: number | null
    notes: string | null
    ftpWatts: number | null
    rideType: string | null
    fitData: WorkoutFitData | null
    insights: WorkoutInsights | null
    stravaActivityId: number | null
  }

  async function powerBestsByWorkoutId(workoutIds: number[]) {
    const rows = workoutIds.length > 0
      ? await db
          .select({ workoutId: powerBests.workoutId, duration: powerBests.duration, watts: powerBests.watts })
          .from(powerBests)
          .where(inArray(powerBests.workoutId, workoutIds))
      : []

    const map = new Map<number, { duration: string; watts: number }[]>()
    for (const pb of rows) {
      if (!map.has(pb.workoutId)) map.set(pb.workoutId, [])
      map.get(pb.workoutId)!.push({ duration: pb.duration, watts: pb.watts })
    }
    return map
  }

  function buildWorkoutDetail(row: WorkoutRow, pbByWorkoutId: Map<number, { duration: string; watts: number }[]>) {
    return {
      id: row.id,
      name: row.name,
      durationMinutes: row.durationMinutes,
      distanceKm: row.distanceKm,
      tss: row.tss,
      rpe: row.rpe,
      notes: row.notes,
      ftpWatts: row.ftpWatts,
      rideType: row.rideType,
      fitData: row.fitData,
      insights: row.insights,
      stravaActivityId: row.stravaActivityId,
      powerBests: pbByWorkoutId.get(row.id) ?? [],
    }
  }

  let days: unknown[]
  let totalDays: number

  if (hasFilters) {
    // ── Filtered path — query the workouts table directly ────────────────────
    // Rest days are excluded by construction: there is no row for them.
    // "Minimum X" filters are strict boundaries (>=); name is a substring
    // match; ride type is an exact match. All conditions AND together.

    const conditions: SQL[] = [eq(workouts.userId, user.id)]
    if (name) conditions.push(ilike(workouts.name, `%${escapeLikePattern(name)}%`))
    if (type === 'zwift') conditions.push(eq(workouts.rideType, 'trainer'))
    else if (type === 'outdoor') conditions.push(eq(workouts.rideType, 'outdoor'))
    if (minTss > 0) conditions.push(gte(workouts.tss, minTss))
    if (minDistance > 0) conditions.push(gte(workouts.distanceKm, minDistance))
    if (minDuration > 0) conditions.push(gte(workouts.durationMinutes, minDuration))
    if (dateFrom) conditions.push(gte(workouts.date, dateFrom))
    if (dateTo) conditions.push(lte(workouts.date, dateTo))
    const whereClause = and(...conditions)

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workouts)
      .where(whereClause)
    totalDays = countRow?.count ?? 0

    const matchedWorkouts: WorkoutRow[] = await db
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
        rideType: workouts.rideType,
        fitData: workouts.fitData,
        insights: workouts.insights,
        stravaActivityId: workouts.stravaActivityId,
      })
      .from(workouts)
      .where(whereClause)
      .orderBy(desc(workouts.date))
      .limit(limit)
      .offset((page - 1) * limit)

    const pbByWorkoutId = await powerBestsByWorkoutId(matchedWorkouts.map((w) => w.id))

    days = matchedWorkouts.map((workout) => ({
      date: workout.date,
      isRestDay: false,
      metrics: metricsForDate(workout.date),
      workout: buildWorkoutDetail(workout, pbByWorkoutId),
    }))
  }
  else {
    // ── Unfiltered path — calendar-day view, including rest days ─────────────

    // Reverse so newest days come first, then take the requested page slice
    const reversed = [...series].reverse()
    totalDays = reversed.length
    const start = (page - 1) * limit
    const pageSlice = reversed.slice(start, start + limit)

    // Fetch only the workouts that fall within the dates we're displaying.
    // This is a tiny query (≤ `limit` rows) even though the full series may be long.
    const pageDateSet = new Set(pageSlice.map((d) => d.date))

    const pageWorkouts: WorkoutRow[] = await db
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
        rideType: workouts.rideType,
        fitData: workouts.fitData,
        insights: workouts.insights,
        stravaActivityId: workouts.stravaActivityId,
      })
      .from(workouts)
      .where(eq(workouts.userId, user.id))

    // Filter in JS (Drizzle doesn't support `date IN (...)` on string arrays
    // without raw SQL; filtering server-side is fine for ≤ 60 rows per page)
    const filteredPageWorkouts = pageWorkouts.filter((w) => pageDateSet.has(w.date))
    const workoutByDate = new Map(filteredPageWorkouts.map((w) => [w.date, w]))

    const pbByWorkoutId = await powerBestsByWorkoutId(filteredPageWorkouts.map((w) => w.id))

    days = pageSlice.map((day) => {
      const workout = workoutByDate.get(day.date)
      return {
        date: day.date,
        isRestDay: day.isRestDay,
        metrics: { ctl: day.ctl, atl: day.atl, tsb: day.tsb },
        workout: workout ? buildWorkoutDetail(workout, pbByWorkoutId) : null,
      }
    })
  }

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
