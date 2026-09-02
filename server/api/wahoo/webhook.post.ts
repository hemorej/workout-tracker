/**
 * POST /api/wahoo/webhook  —  PUBLIC (no session)
 *
 * Wahoo Cloud API webhook receiver. Wahoo POSTs here when a workout finishes
 * syncing to their cloud. Authenticated ONLY by a shared secret
 * (`runtimeConfig.wahooWebhookToken`), matched against the body's
 * `webhook_token` or an `Authorization` header — there is no server
 * middleware in this repo and this handler deliberately never calls
 * `requireUserSession` (precedent: server/api/auth/login.post.ts).
 *
 * On a valid delivery for an outdoor ride with a FIT file, it:
 *   1. downloads the FIT file and persists the raw bytes to
 *      `runtimeConfig.fitStorageDir` (survives deploys — see fitStorage.ts),
 *   2. parses it (server/utils/fit.ts) against the athlete's current FTP,
 *   3. takes the ride *title* from the matching Strava activity (falling back
 *      to the planned-workout name, then the Wahoo workout name),
 *   4. upserts the `workouts` row for that (user, date) — inserting a new one
 *      or refreshing an existing one's FIT-derived fields while keeping any
 *      manual name/notes/rpe/ftp,
 *   5. records power bests into `wahoo_power_bests`.
 *
 * Only auth failure returns a non-2xx status. Everything else (nothing to do,
 * or a processing error after the file is safely on disk) returns 2xx so
 * Wahoo doesn't retry-hammer; failures are logged for manual follow-up.
 */

import { eq, and } from 'drizzle-orm'
import { users, workouts, powerBests, plannedWorkouts } from '../../db/schema'
import { useDB } from '../../db'
import { invalidateMetrics } from '../../utils/metricsCache'
import { parseFitFile } from '../../utils/fit'
import { getCurrentFtpWatts } from '../../utils/ftp'
import { metricsToWorkoutFields, upsertWahooPowerBests } from '../../utils/fitWorkout'
import { fetchRecentStravaRides } from '../../utils/strava'
import { saveFitFile } from '../../utils/fitStorage'
import { secretMatches, type WahooWebhookBody } from '../../utils/wahooWebhook'

const log = getLogger('wahoo')

export default defineEventHandler(async (event) => {
  const requestId = event.context.requestId
  const config = useRuntimeConfig()
  const expected = config.wahooWebhookToken

  // ── Auth — the first thing we do ─────────────────────────────────────────
  // Reject anything that doesn't carry the shared secret before touching the
  // DB, the filesystem, or any outbound fetch. Wahoo puts the secret in the
  // JSON body (`webhook_token`); we also accept it as a Bearer `Authorization`
  // header. A malformed/absent body is treated as "no token" ⇒ 401. There is
  // no server middleware in this repo and this handler deliberately never
  // calls `requireUserSession` (precedent: server/api/auth/login.post.ts).
  const headerToken = getHeader(event, 'authorization')?.replace(/^Bearer\s+/i, '')
  const body = await readBody<WahooWebhookBody>(event).catch(() => null)
  if (!secretMatches(body?.webhook_token, expected) && !secretMatches(headerToken, expected)) {
    log.warn('wahoo.webhook_unauthorized', { requestId })
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized.' })
  }

  // ── Filter: is there anything to do? ─────────────────────────────────────
  // Per the Wahoo spec the workout and the FIT file are both nested inside
  // `workout_summary` (not at the top level).
  const summary = body?.workout_summary ?? null
  const workout = summary?.workout ?? null
  const fileUrl = summary?.file?.url ?? null
  if (!workout?.id || !fileUrl || workout.plan_id != null) {
    log.info('wahoo.webhook_ignored', {
      requestId,
      workoutId: workout?.id ?? null,
      hasFile: !!fileUrl,
      planId: workout?.plan_id ?? null,
    })
    setResponseStatus(event, 202)
    return { ok: true, ignored: true }
  }

  const rideDate = String(workout.starts).slice(0, 10)
  log.info('wahoo.webhook_received', {
    requestId,
    workoutId: workout.id,
    workoutTypeId: workout.workout_type_id,
    rideDate,
  })

  try {
    const db = useDB()

    // ── Download + persist the FIT file first ────────────────────────────
    // Done before any DB work so a transient DB failure still leaves the raw
    // file on disk for manual reprocessing.
    const fileBuffer = await $fetch<ArrayBuffer>(fileUrl, { responseType: 'arrayBuffer' })
    const buf = Buffer.from(fileBuffer)
    const path = await saveFitFile(workout.id, rideDate, buf)
    log.info('wahoo.webhook_fit_saved', { requestId, workoutId: workout.id, bytes: buf.length, path })

    // ── Resolve the target user (single-user app) ─────────────────────────
    const userRows = config.webhookUserEmail
      ? await db.select({ id: users.id }).from(users)
          .where(eq(users.email, String(config.webhookUserEmail).toLowerCase())).limit(1)
      : await db.select({ id: users.id }).from(users).limit(2)
    if (userRows.length !== 1) {
      log.warn('wahoo.webhook_user_unresolved', { requestId, matched: userRows.length })
      setResponseStatus(event, 202)
      return { ok: false }
    }
    const userId = userRows[0]!.id

    // ── Parse ───────────────────────────────────────────────────────────
    const ftpWatts = await getCurrentFtpWatts(userId)
    const metrics = await parseFitFile(buf, ftpWatts)
    const fields = metricsToWorkoutFields(metrics, ftpWatts)

    // ── Title/type from Strava (source of truth for the ride name) ───────
    let stravaName: string | null = null
    let rideType: 'trainer' | 'outdoor' = 'outdoor'
    let stravaActivityId: number | null = null
    try {
      const rides = await fetchRecentStravaRides(3)
      const match = rides.find((r) => r.startDateLocal.slice(0, 10) === rideDate) ?? rides[0] ?? null
      if (match) {
        stravaName = match.name
        rideType = match.rideType
        stravaActivityId = match.id
      }
    }
    catch (err: unknown) {
      log.warn('wahoo.webhook_strava_lookup_failed', { requestId, err: (err as Error)?.message })
    }

    // ── Planned-workout name fallback ───────────────────────────────────
    const [planned] = await db
      .select({ name: plannedWorkouts.name })
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.userId, userId), eq(plannedWorkouts.date, rideDate)))
      .limit(1)

    const name = stravaName ?? planned?.name ?? workout.name?.trim() ?? 'Outdoor ride'

    // ── Derive scalar columns (same rounding as POST /api/workouts) ─────
    const durationMinutes = Math.max(1, Math.round(fields.durationSeconds / 60))
    const distanceKm = fields.distanceMeters > 0 ? Math.round(fields.distanceMeters / 100) / 10 : null

    // ── Upsert the workouts row for (userId, rideDate) ──────────────────
    const [existing] = await db
      .select()
      .from(workouts)
      .where(and(eq(workouts.userId, userId), eq(workouts.date, rideDate)))
      .limit(1)

    let workoutId: number
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
      log.info('wahoo.webhook_workout_created', { requestId, workoutId, tss: fields.tss })
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
      log.info('wahoo.webhook_workout_updated', { requestId, workoutId, tss: fields.tss })
    }

    // ── Power bests (per-workout, full replace) ─────────────────────────
    await db.delete(powerBests).where(eq(powerBests.workoutId, workoutId))
    if (fields.powerBests.length > 0) {
      await db.insert(powerBests).values(
        fields.powerBests.map((pb) => ({ workoutId, duration: pb.duration, watts: pb.watts })),
      )
    }

    // ── wahoo_power_bests (all-time / 8-week retention, like by-date) ───
    await upsertWahooPowerBests(db, workout.id, fields.powerBests, rideDate)

    invalidateMetrics(userId)

    setResponseStatus(event, 200)
    return { ok: true, workoutId }
  }
  catch (err: unknown) {
    log.error('wahoo.webhook_process_failed', {
      requestId,
      workoutId: workout.id,
      rideDate,
      err: err instanceof Error ? err.message : String(err),
    })
    setResponseStatus(event, 202)
    return { ok: false }
  }
})
