/**
 * Shared "parsed FIT file → workout fields" shaping, used by every entry
 * point that turns a FIT file into a logged workout:
 *   - GET  /api/wahoo/by-date   (outdoor "Mark as completed")
 *   - POST /api/fit/upload      (indoor/manual "Mark as completed")
 *   - POST /api/wahoo/webhook   (auto-log from a Wahoo webhook)
 *
 * `metricsToWorkoutFields` returns the exact object shape the first two
 * endpoints have always returned to the client, so their responses stay
 * byte-identical after the refactor.
 *
 * `upsertWahooPowerBests` is the `wahoo_power_bests` upsert+prune lifted
 * verbatim from by-date.get.ts — it records whatever raw power any
 * Wahoo-sourced ride showed, pruned to the all-time top-3 / trailing-8-week
 * retention window per duration.
 */

import { sql } from 'drizzle-orm'
import { wahooPowerBests, type WorkoutFitData, type WorkoutLap } from '../db/schema'
import type { ParsedFitMetrics } from './fit'
import type { useDB } from '../db'
import { filterNewBestEfforts } from './powerBests'

const EIGHT_WEEKS_MS = 8 * 7 * 24 * 60 * 60 * 1000

export interface FitWorkoutFields {
  tss: number
  durationSeconds: number
  distanceMeters: number
  powerBests: { duration: string; watts: number }[]
  fitData: WorkoutFitData
  laps: WorkoutLap[] | null
}

/** Exact response shape GET /api/wahoo/by-date and POST /api/fit/upload build today. */
export function metricsToWorkoutFields(metrics: ParsedFitMetrics, ftpWatts: number): FitWorkoutFields {
  return {
    tss: metrics.tss,
    durationSeconds: metrics.durationSeconds,
    distanceMeters: metrics.distanceMeters,
    powerBests: Object.entries(metrics.bests).map(([duration, watts]) => ({ duration, watts: watts! })),
    fitData: {
      avgPower: metrics.avgPower,
      maxPower: metrics.maxPower,
      normalizedPower: metrics.normalizedPower,
      intensityFactor: metrics.intensityFactor,
      avgHr: metrics.avgHr,
      maxHr: metrics.maxHr,
      avgCadence: metrics.avgCadence,
      maxCadence: metrics.maxCadence,
      zoneBuckets: metrics.zoneBuckets,
      zoneFtp: ftpWatts,
    },
    laps: metrics.laps.length >= 2 ? metrics.laps : null,
  }
}

/**
 * Upserts the given power bests for a Wahoo activity id, then prunes rows
 * that are neither in the all-time top 3 nor within the trailing 8 weeks for
 * their duration. No-op when `powerBests` is empty.
 */
export async function upsertWahooPowerBests(
  db: ReturnType<typeof useDB>,
  activityId: number,
  powerBests: { duration: string; watts: number }[],
  achievedAt: string,
): Promise<void> {
  if (powerBests.length === 0) return

  await db
    .insert(wahooPowerBests)
    .values(powerBests.map((pb) => ({ activityId, duration: pb.duration, watts: pb.watts, achievedAt })))
    .onConflictDoUpdate({
      target: [wahooPowerBests.activityId, wahooPowerBests.duration],
      set: { watts: sql`excluded.watts` },
    })

  const cutoff = new Date(Date.now() - EIGHT_WEEKS_MS).toISOString().slice(0, 10)
  await db.execute(sql`
    DELETE FROM wahoo_power_bests
    WHERE id IN (
      SELECT id FROM (
        SELECT id, achieved_at,
               RANK() OVER (PARTITION BY duration ORDER BY watts DESC) AS rank
        FROM wahoo_power_bests
      ) ranked
      WHERE rank > 3 AND achieved_at < ${cutoff}
    )
  `)
}

/**
 * Prefill-time version of the save-time filter: drops `powerBests` down to
 * the durations that beat the athlete's trailing-8-week (or all-time) max as
 * of `date`, so the Add Workout form only prefills genuine best efforts.
 * `excludeWorkoutId` keeps the ride's own stored rows from acting as its own
 * baseline (same-day wahoo_power_bests rows are excluded by the filter itself).
 */
export async function withNewBestEffortsOnly(
  db: ReturnType<typeof useDB>,
  userId: number,
  date: string,
  fields: FitWorkoutFields,
  excludeWorkoutId?: number,
): Promise<FitWorkoutFields> {
  return {
    ...fields,
    powerBests: await filterNewBestEfforts(db, userId, date, fields.powerBests, excludeWorkoutId),
  }
}
