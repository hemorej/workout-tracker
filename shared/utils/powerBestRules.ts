/**
 * Pure PR rule for power-curve bests — no imports, so the server utils, the
 * backfill script and the unit tests all share one definition.
 *
 * A duration is a PR for a ride when its watts are STRICTLY higher than the
 * athlete's max for that duration over the 8 weeks (56 days) BEFORE the ride's
 * date. Rides on/after the ride's date are ignored (a PR is "as of then"), and
 * if nothing was ridden in the window there is nothing to beat — any value is
 * a PR.
 */

export const EIGHT_WEEKS_MS = 56 * 24 * 60 * 60 * 1000

export interface PowerEffort {
  duration: string
  watts: number
}

export interface DatedPowerEffort extends PowerEffort {
  /** YYYY-MM-DD */
  date: string
}

/** First day of the 8-week window ending the day before `workoutDate`. */
export function eightWeekCutoff(workoutDate: string): string {
  return new Date(new Date(workoutDate + 'T00:00:00Z').getTime() - EIGHT_WEEKS_MS)
    .toISOString()
    .slice(0, 10)
}

/** Candidates that beat the trailing-8-week max (see file header). `existing` = every other known effort. */
export function findNewBestEfforts<T extends PowerEffort>(
  existing: DatedPowerEffort[],
  workoutDate: string,
  candidates: T[],
): T[] {
  const cutoff = eightWeekCutoff(workoutDate)
  const max8w = new Map<string, number>()
  for (const row of existing) {
    if (row.date >= cutoff && row.date < workoutDate && row.watts > (max8w.get(row.duration) ?? 0)) {
      max8w.set(row.duration, row.watts)
    }
  }
  return candidates.filter((c) => c.watts > (max8w.get(c.duration) ?? 0))
}

/** Top `n` distinct watt values, descending — ties collapse so the next-highest value fills the slot. */
export function topDistinctWatts(values: number[], n = 3): number[] {
  return [...new Set(values)].sort((a, b) => b - a).slice(0, n)
}
