/**
 * Shared power-curve logic — one source of truth for what counts as a PR and
 * for the candidate pool the History panel ranks.
 *
 * Data model:
 *   - `power_curve`      every ride's FULL curve (14 durations). The source of
 *                        truth for History's rolling 8-week max and all-time
 *                        top 3, and the baseline PRs are judged against.
 *   - `power_bests`      only the durations that were PRs (strictly above the
 *                        trailing-8-week max) when the ride was logged — drives
 *                        the workout card badges.
 *   - `wahoo_power_bests` LEGACY, read-only. Kept in the pool so history from
 *                        before `power_curve` existed isn't lost; nothing
 *                        writes to it any more.
 *
 * The PR rule itself is pure and lives in shared/utils/powerBestRules.ts.
 */

import { and, eq, ne } from 'drizzle-orm'
import { powerBests, powerCurve, wahooPowerBests, workouts, POWER_BEST_DURATIONS } from '../db/schema'
import { useDB } from '../db'
import {
  findNewBestEfforts,
  type DatedPowerEffort,
  type PowerEffort,
} from '../../shared/utils/powerBestRules'

/** One known best (duration → watts) with the date it was achieved. */
export type PowerBestCandidate = DatedPowerEffort

/**
 * Validates a client-supplied list of `{duration, watts}` entries (powerBests
 * or powerCurve). Throws a 400 on bad input. `label` names the field in errors.
 */
export function parsePowerEntries(raw: unknown, label: string): PowerEffort[] {
  const valid = new Set(POWER_BEST_DURATIONS as readonly string[])
  const out: PowerEffort[] = []
  if (!Array.isArray(raw)) return out
  for (const pb of raw) {
    if (!pb?.duration || !valid.has(pb.duration)) {
      throw createError({ statusCode: 400, statusMessage: `Invalid ${label} duration: ${pb?.duration}` })
    }
    const watts = Number(pb.watts)
    if (!Number.isInteger(watts) || watts <= 0) {
      throw createError({ statusCode: 400, statusMessage: `${label} watts must be a positive integer.` })
    }
    out.push({ duration: pb.duration, watts })
  }
  if (new Set(out.map((p) => p.duration)).size !== out.length) {
    throw createError({ statusCode: 400, statusMessage: `Each ${label} duration must be unique.` })
  }
  return out
}

/**
 * Every known effort for the (single) tracked athlete as a flat
 * {duration, watts, date} list: full curves + PR rows + legacy Wahoo rows.
 * Duplicates are harmless — consumers take maxima / distinct values.
 *
 * `excludeWorkoutId` drops one workout's own `power_curve`/`power_bests` rows
 * so a ride can't be its own baseline. `excludeWahooDate` ("YYYY-MM-DD") does
 * the same for legacy `wahoo_power_bests` rows achieved that day.
 */
export async function getPowerBestCandidates(
  db: ReturnType<typeof useDB>,
  userId: number,
  excludeWorkoutId?: number,
  excludeWahooDate?: string,
): Promise<PowerBestCandidate[]> {
  const scope = () =>
    excludeWorkoutId !== undefined
      ? and(eq(workouts.userId, userId), ne(workouts.id, excludeWorkoutId))
      : eq(workouts.userId, userId)

  const [curve, prs, legacy] = await Promise.all([
    db
      .select({ duration: powerCurve.duration, watts: powerCurve.watts, date: workouts.date })
      .from(powerCurve)
      .innerJoin(workouts, eq(powerCurve.workoutId, workouts.id))
      .where(scope()),
    db
      .select({ duration: powerBests.duration, watts: powerBests.watts, date: workouts.date })
      .from(powerBests)
      .innerJoin(workouts, eq(powerBests.workoutId, workouts.id))
      .where(scope()),
    // Not scoped by user — wahoo_power_bests is a single-user table.
    db
      .select({ duration: wahooPowerBests.duration, watts: wahooPowerBests.watts, date: wahooPowerBests.achievedAt })
      .from(wahooPowerBests)
      .where(excludeWahooDate !== undefined ? ne(wahooPowerBests.achievedAt, excludeWahooDate) : undefined),
  ])

  return [...curve, ...prs, ...legacy]
}

/**
 * Narrows raw parsed power-curve values to the genuine PRs for a ride: those
 * strictly above the trailing-8-week max before `workoutDate` (see
 * findNewBestEfforts). The ride's own stored rows are excluded from the
 * baseline via `excludeWorkoutId`; legacy same-day Wahoo rows via the date.
 */
export async function filterNewBestEfforts(
  db: ReturnType<typeof useDB>,
  userId: number,
  workoutDate: string,
  candidates: PowerEffort[],
  excludeWorkoutId?: number,
): Promise<PowerEffort[]> {
  if (candidates.length === 0) return []
  const existing = await getPowerBestCandidates(db, userId, excludeWorkoutId, workoutDate)
  return findNewBestEfforts(existing, workoutDate, candidates)
}

/**
 * Persists a ride's power data in one go:
 *   - `curve` (if given) fully replaces the workout's `power_curve` rows;
 *   - `prCandidates` (if given) are filtered down to genuine PRs and fully
 *     replace the workout's `power_bests` rows.
 * Either left undefined ⇒ that table is untouched.
 */
export async function recordRidePowerBests(
  db: ReturnType<typeof useDB>,
  input: {
    userId: number
    workoutId: number
    date: string
    curve?: PowerEffort[]
    prCandidates?: PowerEffort[]
  },
): Promise<void> {
  const { userId, workoutId, date, curve, prCandidates } = input

  if (curve) {
    await db.delete(powerCurve).where(eq(powerCurve.workoutId, workoutId))
    if (curve.length > 0) {
      await db.insert(powerCurve).values(curve.map((pt) => ({ workoutId, duration: pt.duration, watts: pt.watts })))
    }
  }

  if (prCandidates) {
    await db.delete(powerBests).where(eq(powerBests.workoutId, workoutId))
    const prs = await filterNewBestEfforts(db, userId, date, prCandidates, workoutId)
    if (prs.length > 0) {
      await db.insert(powerBests).values(prs.map((pb) => ({ workoutId, duration: pb.duration, watts: pb.watts })))
    }
  }
}
