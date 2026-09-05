/**
 * POST /api/segments/reconcile  —  PUBLIC (no session), secret-authed
 *
 * Nightly safety net for the tracked-segments feature, meant to be hit by a
 * Forge scheduled job (same pattern as the Wahoo webhook — there's no server
 * middleware in this repo and this never calls `requireUserSession`).
 * Authenticated ONLY by a shared secret (`runtimeConfig.segmentsSyncToken`),
 * matched against a `token` body field or a Bearer `Authorization` header.
 *
 * Why it exists: the per-activity sync (server/utils/stravaSegments.ts,
 * called from the workout create/update handlers) runs as soon as a ride is
 * logged, but Strava matches segments to a new activity asynchronously — so
 * that first pass can see zero (or partial) efforts. This job re-checks every
 * tracked segment's `athlete_segment_stats.effort_count` against the number
 * stored locally and re-pulls the full effort history for any segment where
 * they disagree (or that's never been backfilled). It also refreshes the
 * starred set.
 *
 * Only auth failure returns non-2xx; every other outcome returns 200 with a
 * summary, so a cron misfire doesn't page anyone. Per-segment errors are
 * logged.
 */

import { and, eq } from 'drizzle-orm'
import { useDB } from '../../db'
import { users, trackedSegments } from '../../db/schema'
import { secretMatches } from '../../utils/wahooWebhook'
import {
  fetchStarredSegments,
  fetchSegmentDetail,
  fetchAllSegmentEfforts,
  segmentDetailFields,
  applyStarredList,
  upsertSegmentEfforts,
  countStoredEfforts,
} from '../../utils/stravaSegments'

const log = getLogger('segments')

export default defineEventHandler(async (event) => {
  const requestId = event.context.requestId
  const config = useRuntimeConfig()
  const expected = config.segmentsSyncToken

  // ── Auth — before any DB work or outbound fetch ─────────────────────────
  const headerToken = getHeader(event, 'authorization')?.replace(/^Bearer\s+/i, '')
  const body = await readBody<{ token?: string }>(event).catch(() => null)
  if (!secretMatches(body?.token, expected) && !secretMatches(headerToken, expected)) {
    log.warn('segments.reconcile_unauthorized', { requestId })
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized.' })
  }

  const db = useDB()

  // ── Resolve the target user (single-user app; mirrors the Wahoo webhook) ─
  const userRows = config.webhookUserEmail
    ? await db.select({ id: users.id }).from(users)
        .where(eq(users.email, String(config.webhookUserEmail).toLowerCase())).limit(1)
    : await db.select({ id: users.id }).from(users).limit(2)
  if (userRows.length !== 1) {
    log.warn('segments.reconcile_no_user', { requestId, matched: userRows.length })
    return { ok: true, skipped: 'no unambiguous user' }
  }
  const userId = userRows[0]!.id

  let checked = 0
  let updated = 0
  let effortsWritten = 0
  let failures = 0
  let unstarred = 0

  try {
    const starred = await fetchStarredSegments()
    ;({ unstarred } = await applyStarredList(db, userId, starred))

    const tracked = await db
      .select({
        id: trackedSegments.id,
        stravaEffortCount: trackedSegments.stravaEffortCount,
        lastSyncedAt: trackedSegments.lastSyncedAt,
      })
      .from(trackedSegments)
      .where(and(eq(trackedSegments.userId, userId), eq(trackedSegments.starred, true)))

    for (const row of tracked) {
      checked++
      try {
        const detail = await fetchSegmentDetail(row.id)
        const detailFields = segmentDetailFields(detail)
        const storedCount = await countStoredEfforts(db, row.id)
        const stravaCount = detailFields.stravaEffortCount

        const needsRepull = row.lastSyncedAt == null
          || stravaCount == null
          || stravaCount !== storedCount

        if (needsRepull) {
          const efforts = await fetchAllSegmentEfforts(row.id)
          effortsWritten += await upsertSegmentEfforts(db, efforts, userId)
          updated++
        }

        await db
          .update(trackedSegments)
          .set({ ...detailFields, lastSyncedAt: new Date() })
          .where(eq(trackedSegments.id, row.id))
      }
      catch (err: unknown) {
        failures++
        const e = err as Record<string, any>
        log.warn('segments.reconcile_segment_failed', {
          requestId,
          segmentId: row.id,
          status: e?.status ?? e?.response?.status,
          err: e?.message,
        })
      }
    }
  }
  catch (err: unknown) {
    const e = err as Record<string, any>
    log.error('segments.reconcile_failed', {
      requestId,
      status: e?.status ?? e?.response?.status,
      err: e?.message,
    })
    return { ok: false, checked, updated, effortsWritten, failures, unstarred }
  }

  log.info('segments.reconciled', { requestId, checked, updated, effortsWritten, failures, unstarred })
  return { ok: true, checked, updated, effortsWritten, failures, unstarred }
})
