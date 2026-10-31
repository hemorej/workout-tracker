/**
 * Turns a raw FIT file into a logged workout — the shared back half of every
 * session-less auto-ingest path:
 *   - POST /api/wahoo/webhook   (Wahoo Cloud delivers the file)
 *   - POST /api/zwift/activity  (local daemon uploads a Zwift activity)
 *
 * Callers authenticate, resolve the user, derive `rideDate` (the ride's LOCAL
 * calendar day) and persist the raw bytes first (so a failure here still
 * leaves the file on disk). This function then:
 *   1. parses it against the athlete's current FTP,
 *   2. resolves the title (Strava → planned workout → fallback; rideName.ts),
 *   3. upserts the `workouts` row for (user, rideDate) — a new row, or a
 *      refresh of the FIT-derived fields keeping manual name/notes/rpe/ftp,
 *   4. stores the ride's full `power_curve` and replaces its `power_bests`
 *      with the genuine PRs (strictly above the trailing-8-week max).
 */

import { eq, and } from 'drizzle-orm'
import { workouts } from '../db/schema'
import { useDB } from '../db'
import { invalidateMetrics } from './metricsCache'
import { parseFitFile } from './fit'
import { getCurrentFtpWatts } from './ftp'
import { metricsToWorkoutFields } from './fitWorkout'
import { recordRidePowerBests } from './powerBests'
import { resolveRideName, type RideNameSource } from './rideName'

const log = getLogger('workouts')

/** The bytes aren't a usable FIT ride (corrupt, no power, …) — a permanent, caller-side failure. */
export class FitParseError extends Error {}

export interface IngestFitRideInput {
  userId: number
  /** Local calendar day, YYYY-MM-DD. */
  rideDate: string
  buf: Buffer
  source: 'wahoo' | 'zwift'
  /** Ride type when the source knows it (Zwift ⇒ 'trainer'); else taken from the Strava match, default 'outdoor'. */
  rideType?: 'trainer' | 'outdoor'
  fallbackName: string
  /** Strava lookup retry policy (Strava can lag the ride). */
  nameLookup?: { attempts: number, delayMs: number }
  requestId?: string
}

export interface IngestFitRideResult {
  workoutId: number
  created: boolean
  name: string
  nameSource: RideNameSource
  tss: number
}

export async function ingestFitRide(input: IngestFitRideInput): Promise<IngestFitRideResult> {
  const { userId, rideDate, buf, source, requestId } = input
  const db = useDB()

  const ftpWatts = await getCurrentFtpWatts(userId)
  let metrics: Awaited<ReturnType<typeof parseFitFile>>
  try {
    metrics = await parseFitFile(buf, ftpWatts)
  }
  catch (err: unknown) {
    throw new FitParseError(err instanceof Error ? err.message : 'Failed to parse FIT file.')
  }
  const fields = metricsToWorkoutFields(metrics, ftpWatts)

  const resolved = await resolveRideName({
    userId,
    rideDate,
    rideType: input.rideType,
    durationSeconds: fields.durationSeconds,
    fallbackName: input.fallbackName,
    attempts: input.nameLookup?.attempts,
    delayMs: input.nameLookup?.delayMs,
    requestId,
  })
  const rideType = input.rideType ?? resolved.stravaRideType ?? 'outdoor'
  const { stravaActivityId } = resolved

  // Same rounding as POST /api/workouts.
  const durationMinutes = Math.max(1, Math.round(fields.durationSeconds / 60))
  const distanceKm = fields.distanceMeters > 0 ? Math.round(fields.distanceMeters / 100) / 10 : null

  const [existing] = await db
    .select()
    .from(workouts)
    .where(and(eq(workouts.userId, userId), eq(workouts.date, rideDate)))
    .limit(1)

  let workoutId: number
  let name = resolved.name
  let created = false
  if (!existing) {
    const [inserted] = await db
      .insert(workouts)
      .values({
        userId,
        date: rideDate,
        name,
        durationMinutes,
        distanceKm,
        tss: fields.tss,
        rpe: null,
        notes: null,
        ftpWatts: null,
        rideType,
        fitData: fields.fitData,
        laps: fields.laps,
        stravaActivityId,
      })
      .returning()
    if (!inserted) throw new Error('workout insert returned no row')
    workoutId = inserted.id
    created = true
    log.info('workouts.ingest_created', { requestId, source, workoutId, tss: fields.tss, nameSource: resolved.source })
  }
  else {
    // Overwrite the FIT-derived fields; keep manual name/notes/rpe/ftp.
    await db
      .update(workouts)
      .set({
        durationMinutes,
        distanceKm,
        tss: fields.tss,
        rideType,
        fitData: fields.fitData,
        laps: fields.laps,
        stravaActivityId: existing.stravaActivityId ?? stravaActivityId,
      })
      .where(and(eq(workouts.id, existing.id), eq(workouts.userId, userId)))
    workoutId = existing.id
    name = existing.name
    log.info('workouts.ingest_updated', { requestId, source, workoutId, tss: fields.tss })
  }

  // Full curve → power_curve; only durations above the trailing-8-week max
  // become PR rows (power_bests).
  await recordRidePowerBests(db, {
    userId,
    workoutId,
    date: rideDate,
    curve: fields.powerCurve,
    prCandidates: fields.powerBests,
  })

  invalidateMetrics(userId)

  return { workoutId, created, name, nameSource: resolved.source, tss: fields.tss }
}
