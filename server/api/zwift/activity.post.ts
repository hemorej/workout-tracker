/**
 * POST /api/zwift/activity  —  PUBLIC (no session), Bearer-token authed
 *
 * Receives one finished Zwift activity from the local daemon
 * (scripts/zwift-activities.ts): the raw FIT bytes as the body
 * (`application/octet-stream`) plus `X-Ride-Date: YYYY-MM-DD`, the ride's
 * LOCAL day (taken from Zwift's local-time filename — the FIT itself has only
 * UTC timestamps and no offset, so it can't say which local day it was).
 *
 * Mirrors the Wahoo webhook: persist the raw file to disk first, then
 * `ingestFitRide` (parse → title from same-day Strava VirtualRide → planned
 * workout → "Zwift ride" → upsert → bests). Idempotent per (user, date): a
 * re-upload refreshes FIT-derived fields and keeps manual edits.
 *
 * Unlike the third-party Wahoo webhook, the only caller is our own daemon, so
 * this returns honest status codes: 400 bad input, 401 bad token, 413 too
 * large, 422 unparseable / no power data, 5xx = retry later.
 */

import { createHash } from 'node:crypto'
import { useDB } from '../../db'
import { saveFitFile } from '../../utils/fitStorage'
import { looksLikeFit } from '../../utils/fit'
import { FitParseError, ingestFitRide } from '../../utils/ingestFitRide'
import { resolveWebhookUserId } from '../../utils/webhookUser'
import { requireZwiftActivityToken, ZWIFT_ACTIVITY_LIMITS } from '../../utils/zwiftActivity'

const log = getLogger('zwift')
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export default defineEventHandler(async (event) => {
  requireZwiftActivityToken(event)
  const requestId = event.context.requestId

  const rideDate = getHeader(event, 'x-ride-date') ?? ''
  if (!DATE_RE.test(rideDate) || Number.isNaN(Date.parse(`${rideDate}T00:00:00Z`))) {
    throw createError({ statusCode: 400, statusMessage: 'X-Ride-Date (YYYY-MM-DD) is required.' })
  }

  const declared = Number(getHeader(event, 'content-length') ?? 0)
  if (declared > ZWIFT_ACTIVITY_LIMITS.maxBodyBytes) {
    throw createError({ statusCode: 413, statusMessage: 'FIT file too large.' })
  }
  const raw = await readRawBody(event, false)
  if (!raw?.length) throw createError({ statusCode: 400, statusMessage: 'Empty body.' })
  if (raw.length > ZWIFT_ACTIVITY_LIMITS.maxBodyBytes) {
    throw createError({ statusCode: 413, statusMessage: 'FIT file too large.' })
  }
  const buf = Buffer.from(raw)
  // Strict type gate before anything is written to disk: a real FIT header.
  if (!looksLikeFit(buf)) {
    log.warn('zwift.activity_not_fit', { requestId, bytes: buf.length })
    throw createError({ statusCode: 422, statusMessage: 'Not a FIT file.' })
  }

  // Persist the raw file first so a later failure leaves it on disk.
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12)
  const path = await saveFitFile(`zwift-${hash}`, rideDate, buf)
  log.info('zwift.activity_received', { requestId, rideDate, bytes: buf.length, path })

  const db = useDB()
  const { userId, matched } = await resolveWebhookUserId(db)
  if (userId == null) {
    log.warn('zwift.activity_user_unresolved', { requestId, matched })
    throw createError({ statusCode: 409, statusMessage: 'Could not resolve a single target user.' })
  }

  try {
    const result = await ingestFitRide({
      userId,
      rideDate,
      buf,
      source: 'zwift',
      rideType: 'trainer',
      fallbackName: 'Zwift ride',
      nameLookup: { attempts: 3, delayMs: 20_000 },
      requestId,
    })
    return { ok: true, ...result }
  }
  catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('zwift.activity_process_failed', { requestId, rideDate, err: message })
    // Bad bytes are permanent (422 — the daemon won't retry); anything else
    // (DB, Strava, …) is 5xx so the daemon retries.
    if (err instanceof FitParseError) throw createError({ statusCode: 422, statusMessage: message })
    throw createError({ statusCode: 500, statusMessage: 'Processing failed.' })
  }
})
