/**
 * Picks the Strava activity that corresponds to a FIT-file ride. Pure and
 * import-free (runs under `node --experimental-strip-types` for tests).
 *
 * A ride matches only if it started on the SAME calendar day as `rideDate`
 * and — when the source knows it — has the same `rideType`. There is no
 * "newest ride" fallback: a ride from another day is never the right title.
 * When several rides qualify (e.g. a morning outdoor ride and an evening
 * Zwift session), the one whose moving time is closest to the FIT duration
 * wins; with no duration given, the first (newest) one does.
 */

export interface RideCandidate {
  startDateLocal: string
  movingTimeSeconds: number
  rideType: 'trainer' | 'outdoor'
}

export function pickStravaRide<T extends RideCandidate>(
  rides: T[],
  opts: { rideDate: string, rideType?: 'trainer' | 'outdoor', durationSeconds?: number },
): T | null {
  const candidates = rides.filter(r =>
    r.startDateLocal.slice(0, 10) === opts.rideDate
    && (!opts.rideType || r.rideType === opts.rideType),
  )
  if (candidates.length === 0) return null
  const { durationSeconds } = opts
  if (candidates.length === 1 || !durationSeconds) return candidates[0]!
  return candidates.reduce((best, r) =>
    Math.abs(r.movingTimeSeconds - durationSeconds) < Math.abs(best.movingTimeSeconds - durationSeconds) ? r : best,
  )
}
