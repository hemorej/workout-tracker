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
 *   3. hands off to `ingestFitRide` (server/utils/ingestFitRide.ts, shared
 *      with the Zwift activity upload): title from the same-day Strava
 *      activity (falling back to the planned-workout name, then the Wahoo
 *      workout name — never a different day's ride), upsert of the `workouts`
 *      row for that (user, date) keeping any manual name/notes/rpe/ftp, power
 *      bests, and `wahoo_power_bests`.
 *
 * Only auth failure returns a non-2xx status. Everything else (nothing to do,
 * or a processing error after the file is safely on disk) returns 2xx so
 * Wahoo doesn't retry-hammer; failures are logged for manual follow-up.
 */

import { useDB } from '../../db'
import { saveFitFile } from '../../utils/fitStorage'
import { ingestFitRide } from '../../utils/ingestFitRide'
import { rideTypeForWorkoutType } from '../../utils/wahoo'
import { resolveWebhookUserId } from '../../utils/webhookUser'
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
    const { userId, matched } = await resolveWebhookUserId(db)
    if (userId == null) {
      log.warn('wahoo.webhook_user_unresolved', { requestId, matched })
      setResponseStatus(event, 202)
      return { ok: false }
    }

    // ── Parse, title, upsert, bests (shared with the Zwift activity upload) ──
    // Title: matching same-day Strava ride → planned workout → Wahoo name.
    const result = await ingestFitRide({
      userId,
      rideDate,
      buf,
      source: 'wahoo',
      wahooWorkoutId: workout.id,
      rideType: rideTypeForWorkoutType(workout.workout_type_id),
      fallbackName: workout.name?.trim() || 'Outdoor ride',
      nameLookup: { attempts: 3, delayMs: 5_000 },
      requestId,
    })
    const workoutId = result.workoutId
    log.info('wahoo.webhook_ingested', { requestId, workoutId, created: result.created, nameSource: result.nameSource })

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
