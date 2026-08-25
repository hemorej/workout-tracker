/**
 * GET /api/history?groupBy=week|month|year
 *
 * Returns aggregated training history grouped by the requested period,
 * plus a power-bests panel (last 8 weeks vs all time) and current FTP.
 *
 * The power-bests panel merges two sources: manually-entered bests tied to
 * a logged workout (`power_bests`), and bests derived from Wahoo FIT files
 * (`wahoo_power_bests`, populated by server/api/wahoo/by-date.get.ts
 * whenever an outdoor ride is previewed via the "Mark completed" picker —
 * indoor/virtual rides go through the manual-upload path in
 * server/api/fit/upload.post.ts instead, which does not write here). They're
 * kept as separate tables — computed values may not always match what the
 * user chooses to log — but shown together here as "best known value from
 * either source".
 *
 * Response shape:
 * {
 *   periods:          PeriodEntry[]
 *   powerBestsPanel:  {
 *     last8Weeks: Record<duration, watts>,     // single best value
 *     allTime:    Record<duration, watts[]>,   // top 3, descending
 *     durations:  duration[],
 *     bestMeta:   Record<duration, { date: string, isFresh: boolean }>,
 *   }
 *   currentFtp:       number | null
 *   weightKg:         number | null
 * }
 */

import { eq, asc, inArray } from 'drizzle-orm'
import { workouts, powerBests as powerBestsTable, wahooPowerBests, users, POWER_BEST_DURATIONS } from '../../db/schema'
import { useDB } from '../../db'

type GroupBy = 'week' | 'month' | 'year'

function getWeekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00')
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d.toISOString().slice(0, 10)
}

function getPeriodKey(dateStr: string, groupBy: GroupBy): string {
  if (groupBy === 'year') return dateStr.slice(0, 4)
  if (groupBy === 'month') return dateStr.slice(0, 7)
  return getWeekMonday(dateStr)
}

function formatLabel(key: string, groupBy: GroupBy): string {
  if (groupBy === 'year') return key
  if (groupBy === 'month') {
    const parts = key.split('-')
    const year = Number(parts[0] ?? 0)
    const month = Number(parts[1] ?? 1)
    const d = new Date(year, month - 1, 1)
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  }
  // week: key is the Monday date
  const monday = new Date(key + 'T00:00')
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${fmt(monday)} – ${fmt(sunday)}`
}

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const rawQuery = getQuery(event)
  const groupBy: GroupBy = (['week', 'month', 'year'] as const).includes(rawQuery.groupBy as GroupBy)
    ? (rawQuery.groupBy as GroupBy)
    : 'month'

  const db = useDB()

  const allWorkouts = await db
    .select({
      id: workouts.id,
      date: workouts.date,
      tss: workouts.tss,
      durationMinutes: workouts.durationMinutes,
      distanceKm: workouts.distanceKm,
      ftpWatts: workouts.ftpWatts,
    })
    .from(workouts)
    .where(eq(workouts.userId, user.id))
    .orderBy(asc(workouts.date))

  const workoutIds = allWorkouts.map((w) => w.id)
  const allPowerBests = workoutIds.length > 0
    ? await db
        .select({
          workoutId: powerBestsTable.workoutId,
          duration: powerBestsTable.duration,
          watts: powerBestsTable.watts,
        })
        .from(powerBestsTable)
        .where(inArray(powerBestsTable.workoutId, workoutIds))
    : []

  const workoutIdsWithPowerBests = new Set(allPowerBests.map((pb) => pb.workoutId))

  // ── Group workouts into periods ────────────────────────────────────────────

  const periodMap = new Map<string, {
    tssTotal: number
    minutesTotal: number
    kmTotal: number
    workoutCount: number
    hasFtp: boolean
    hasPowerBests: boolean
    ftpWatts: number | null
  }>()

  for (const w of allWorkouts) {
    const key = getPeriodKey(w.date, groupBy)
    if (!periodMap.has(key)) {
      periodMap.set(key, {
        tssTotal: 0,
        minutesTotal: 0,
        kmTotal: 0,
        workoutCount: 0,
        hasFtp: false,
        hasPowerBests: false,
        ftpWatts: null,
      })
    }
    const p = periodMap.get(key)!
    p.tssTotal += w.tss
    p.minutesTotal += w.durationMinutes
    p.kmTotal += w.distanceKm ?? 0
    p.workoutCount += 1
    if (w.ftpWatts != null) {
      p.hasFtp = true
      p.ftpWatts = w.ftpWatts
    }
    if (workoutIdsWithPowerBests.has(w.id)) {
      p.hasPowerBests = true
    }
  }

  const periods = [...periodMap.keys()]
    .sort()
    .reverse()
    .map((key) => {
      const p = periodMap.get(key)!
      return {
        key,
        label: formatLabel(key, groupBy),
        tssTotal: p.tssTotal,
        hoursTotal: p.minutesTotal / 60,
        kmTotal: Math.round(p.kmTotal),
        workoutCount: p.workoutCount,
        hasFtp: p.hasFtp,
        hasPowerBests: p.hasPowerBests,
        ftpWatts: p.ftpWatts,
      }
    })

  // ── Power bests panel ─────────────────────────────────────────────────────

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 56) // 8 weeks
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const workoutDateById = new Map(allWorkouts.map((w) => [w.id, w.date]))

  // Merge candidates from both sources — manual entries (tied to a workout date)
  // and Wahoo-derived bests (tied to an activity date) — before ranking.
  const candidatesByDuration = new Map<string, { watts: number; date: string }[]>()
  function addCandidate(duration: string, watts: number, date: string) {
    const list = candidatesByDuration.get(duration)
    if (list) list.push({ watts, date })
    else candidatesByDuration.set(duration, [{ watts, date }])
  }

  for (const pb of allPowerBests) {
    const date = workoutDateById.get(pb.workoutId)
    if (date) addCandidate(pb.duration, pb.watts, date)
  }

  const allWahooBests = await db
    .select({
      duration: wahooPowerBests.duration,
      watts: wahooPowerBests.watts,
      achievedAt: wahooPowerBests.achievedAt,
    })
    .from(wahooPowerBests)

  for (const wb of allWahooBests) {
    addCandidate(wb.duration, wb.watts, wb.achievedAt)
  }

  const last8wBests: Record<string, number> = {}
  const allTimeTop3: Record<string, number[]> = {}
  const bestMeta: Record<string, { date: string; isFresh: boolean }> = {}

  for (const [duration, candidates] of candidatesByDuration) {
    const sorted = [...candidates].sort((a, b) => b.watts - a.watts)
    allTimeTop3[duration] = sorted.slice(0, 3).map((c) => c.watts)

    const best8w = sorted.find((c) => c.date >= cutoffStr)
    if (best8w) last8wBests[duration] = best8w.watts

    const top = sorted[0]!
    bestMeta[duration] = {
      date: top.date,
      isFresh: best8w != null && best8w.watts === top.watts,
    }
  }

  // Current FTP: most recent non-null ftpWatts (allWorkouts sorted asc, so last wins)
  const currentFtp = allWorkouts.filter((w) => w.ftpWatts != null).at(-1)?.ftpWatts ?? null

  const [userRow] = await db
    .select({ weightKg: users.weightKg })
    .from(users)
    .where(eq(users.id, user.id))
  const weightKg = userRow?.weightKg ?? null

  // Surface which durations have any data for the panel
  const durationsWithData = POWER_BEST_DURATIONS.filter(
    (d) => allTimeTop3[d]?.length,
  )

  return {
    periods,
    powerBestsPanel: {
      last8Weeks: last8wBests,
      allTime: allTimeTop3,
      durations: durationsWithData,
      bestMeta,
    },
    currentFtp,
    weightKg,
  }
})
