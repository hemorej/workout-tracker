/**
 * Shared "parsed FIT file → workout fields" shaping, used by every entry
 * point that turns a FIT file into a logged workout:
 *   - GET  /api/wahoo/by-date   (outdoor "Mark as completed")
 *   - POST /api/fit/upload      (indoor/manual "Mark as completed")
 *   - POST /api/wahoo/webhook   (auto-log from a Wahoo webhook)
 *
 * `metricsToWorkoutFields` returns the shape the first two endpoints send to
 * the client as the Add Workout form prefill (the webhook uses the same
 * fields to write the row directly). `powerCurve` is always the full parsed
 * curve; `powerBests` starts as the same list and `withNewBestEffortsOnly`
 * (prefill time) / `filterNewBestEfforts` (save time, ./powerBests) narrow it
 * to genuine PRs.
 */

import type { WorkoutFitData, WorkoutLap } from '../db/schema'
import type { ParsedFitMetrics } from './fit'
import type { useDB } from '../db'
import { filterNewBestEfforts } from './powerBests'

export interface FitWorkoutFields {
  tss: number
  durationSeconds: number
  distanceMeters: number
  /** PR candidates. Raw (all durations) from metricsToWorkoutFields; narrowed to genuine PRs by withNewBestEffortsOnly. */
  powerBests: { duration: string; watts: number }[]
  /** The ride's full power curve (all parsed durations) — stored in `power_curve` on save. */
  powerCurve: { duration: string; watts: number }[]
  fitData: WorkoutFitData
  laps: WorkoutLap[] | null
}

/**
 * Shapes parsed FIT metrics into the fields a logged workout needs.
 * `ftpWatts` is the FTP the zone split was bucketed against (stored as
 * `fitData.zoneFtp`). `laps` is null unless the file had 2+ laps.
 * Also the response shape of GET /api/wahoo/by-date and POST /api/fit/upload.
 */
export function metricsToWorkoutFields(metrics: ParsedFitMetrics, ftpWatts: number): FitWorkoutFields {
  const curve = Object.entries(metrics.bests).map(([duration, watts]) => ({ duration, watts: watts! }))
  return {
    tss: metrics.tss,
    durationSeconds: metrics.durationSeconds,
    distanceMeters: metrics.distanceMeters,
    powerBests: curve,
    powerCurve: curve,
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
