/**
 * Shared power-curve "best effort" logic — one source of truth for merging
 * the two candidate sources (`power_bests`, tied to a logged workout's date;
 * `wahoo_power_bests`, tied to a Wahoo activity's date) that both
 * GET /api/history's power-bests panel and the write-time filter below rank
 * against. Keeping the merge in one place means the panel's "Last 8 Weeks" /
 * "All Time" columns and what actually gets saved as a best effort can never
 * drift apart.
 */

import { and, eq, ne } from 'drizzle-orm'
import { powerBests, wahooPowerBests, workouts } from '../db/schema'
import { useDB } from '../db'

export const EIGHT_WEEKS_MS = 56 * 24 * 60 * 60 * 1000

export interface PowerBestCandidate {
  duration: string
  watts: number
  date: string
}

/**
 * All power-best candidates for the (single) tracked athlete, from both
 * source tables, as a flat {duration, watts, date} list ready to sort/filter
 * by whoever calls this — the history panel groups them per duration for
 * top-3 + freshness, `filterNewBestEfforts` below just needs per-duration
 * maxima.
 *
 * `excludeWorkoutId` drops one workout's own `power_bests` rows from the
 * `power_bests` side of the merge — used when filtering that same workout's
 * candidates so its own (about-to-be-replaced) rows can't be their own
 * baseline.
 */
export async function getPowerBestCandidates(
  db: ReturnType<typeof useDB>,
  userId: number,
  excludeWorkoutId?: number,
): Promise<PowerBestCandidate[]> {
  const ownPowerBests = await db
    .select({ duration: powerBests.duration, watts: powerBests.watts, date: workouts.date })
    .from(powerBests)
    .innerJoin(workouts, eq(powerBests.workoutId, workouts.id))
    .where(
      excludeWorkoutId !== undefined
        ? and(eq(workouts.userId, userId), ne(workouts.id, excludeWorkoutId))
        : eq(workouts.userId, userId),
    )

  // Not scoped by user — wahoo_power_bests is a single-user table (see
  // CLAUDE.md's Wahoo integration section).
  const wahooBests = await db
    .select({ duration: wahooPowerBests.duration, watts: wahooPowerBests.watts, date: wahooPowerBests.achievedAt })
    .from(wahooPowerBests)

  return [...ownPowerBests, ...wahooBests]
}

/**
 * Filters raw parsed power-curve values down to genuine "best effort"
 * highlights for a logged workout.
 *
 * `metricsToWorkoutFields` (fitWorkout.ts) turns every one of the 14
 * `POWER_BEST_DURATIONS` a FIT file yields into a `powerBests` candidate —
 * that's just "the highest power sustained for N seconds/minutes in this
 * ride", not necessarily a best *ever*. Without this filter every logged
 * workout stores (and badges) all 14, which drowns out the durations that
 * actually improved.
 *
 * A duration only counts as a best effort when this workout's watts beat
 * the athlete's trailing-8-week maximum for that duration (the same window
 * as the "Last 8 Weeks" column in the /api/history power-bests panel),
 * falling back to the all-time maximum when there's no data in that window
 * (e.g. the first time a duration has been ridden in months, or ever).
 */
export async function filterNewBestEfforts(
  db: ReturnType<typeof useDB>,
  userId: number,
  workoutDate: string,
  candidates: { duration: string; watts: number }[],
  excludeWorkoutId?: number,
): Promise<{ duration: string; watts: number }[]> {
  if (candidates.length === 0) return []

  const cutoff = new Date(new Date(workoutDate + 'T00:00').getTime() - EIGHT_WEEKS_MS)
    .toISOString()
    .slice(0, 10)

  const existing = await getPowerBestCandidates(db, userId, excludeWorkoutId)

  const last8w = new Map<string, number>()
  const allTime = new Map<string, number>()

  for (const row of existing) {
    if (row.watts > (allTime.get(row.duration) ?? 0)) allTime.set(row.duration, row.watts)
    if (row.date >= cutoff && row.watts > (last8w.get(row.duration) ?? 0)) {
      last8w.set(row.duration, row.watts)
    }
  }

  return candidates.filter((c) => {
    const baseline = last8w.get(c.duration) ?? allTime.get(c.duration)
    return baseline == null || c.watts > baseline
  })
}
