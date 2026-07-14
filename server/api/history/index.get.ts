/**
 * GET /api/history?groupBy=week|month|year
 *
 * Returns aggregated training history grouped by the requested period,
 * plus a power-bests panel (last 8 weeks vs all time) and current FTP.
 *
 * Response shape:
 * {
 *   periods:          PeriodEntry[]
 *   powerBestsPanel:  { last8Weeks: Record<duration, watts>, allTime: Record<duration, watts> }
 *   currentFtp:       number | null
 * }
 */

import { eq, asc, inArray } from 'drizzle-orm'
import { workouts, powerBests as powerBestsTable, POWER_BEST_DURATIONS } from '../../db/schema'
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

  const last8wBests: Record<string, number> = {}
  const allTimeBests: Record<string, number> = {}

  for (const pb of allPowerBests) {
    const date = workoutDateById.get(pb.workoutId)
    if (!date) continue

    const prevAll = allTimeBests[pb.duration]
    if (prevAll === undefined || pb.watts > prevAll) {
      allTimeBests[pb.duration] = pb.watts
    }
    if (date >= cutoffStr) {
      const prev8w = last8wBests[pb.duration]
      if (prev8w === undefined || pb.watts > prev8w) {
        last8wBests[pb.duration] = pb.watts
      }
    }
  }

  // Current FTP: most recent non-null ftpWatts (allWorkouts sorted asc, so last wins)
  const currentFtp = allWorkouts.filter((w) => w.ftpWatts != null).at(-1)?.ftpWatts ?? null

  // Surface which durations have any data for the panel
  const durationsWithData = POWER_BEST_DURATIONS.filter(
    (d) => allTimeBests[d] !== undefined,
  )

  return {
    periods,
    powerBestsPanel: {
      last8Weeks: last8wBests,
      allTime: allTimeBests,
      durations: durationsWithData,
    },
    currentFtp,
  }
})
