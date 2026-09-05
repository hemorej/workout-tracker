/**
 * POST /api/segments/sync
 *
 * The "Sync segments" button on the History → Segments tab. Strava has no
 * webhook for starring and no "list every segment I've ridden" endpoint, so
 * the athlete's starred list is the tracked set and this is how it's pulled
 * in (see CLAUDE.md's Strava segments section).
 *
 * Steps:
 *  1. Fetch the starred list; upsert a `tracked_segments` row per entry and
 *     un-star any row that's dropped off it (kept, not deleted) — see
 *     applyStarredList().
 *  2. For every segment that's never had a full effort pull
 *     (`last_synced_at IS NULL` — covers brand-new rows), fetch the segment
 *     detail (elevation + `athlete_segment_stats`) and its entire effort
 *     history, and upsert the efforts. Per-segment failures are logged and
 *     skipped, not fatal.
 *
 * Segments already backfilled once are left alone here — the per-activity
 * sync and the nightly reconcile keep them current.
 *
 * Returns 200 with a summary of what changed.
 */

import { eq } from 'drizzle-orm'
import { useDB } from '../../db'
import { trackedSegments } from '../../db/schema'
import {
  fetchStarredSegments,
  fetchSegmentDetail,
  fetchAllSegmentEfforts,
  segmentDetailFields,
  applyStarredList,
  upsertSegmentEfforts,
} from '../../utils/stravaSegments'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const db = useDB()
  const log = getLogger('segments')
  const requestId = event.context.requestId

  let starred
  try {
    starred = await fetchStarredSegments()
  }
  catch (err: unknown) {
    const e = err as Record<string, any>
    log.error('segments.starred_fetch_failed', {
      requestId,
      status: e?.status ?? e?.response?.status,
      err: e?.message,
    })
    throw createError({ statusCode: 502, statusMessage: 'Could not reach Strava to fetch starred segments.' })
  }

  const { newlyTracked, unstarred, alreadyBackfilled } = await applyStarredList(db, user.id, starred)

  const toBackfill = starred.filter((s) => !alreadyBackfilled.has(s.id))
  let backfilledSegments = 0
  let effortsWritten = 0
  let failures = 0

  for (const s of toBackfill) {
    try {
      const detail = await fetchSegmentDetail(s.id)
      const efforts = await fetchAllSegmentEfforts(s.id)
      effortsWritten += await upsertSegmentEfforts(db, efforts, user.id)
      await db
        .update(trackedSegments)
        .set({ ...segmentDetailFields(detail), lastSyncedAt: new Date() })
        .where(eq(trackedSegments.id, s.id))
      backfilledSegments++
    }
    catch (err: unknown) {
      failures++
      const e = err as Record<string, any>
      log.warn('segments.backfill_failed', {
        requestId,
        segmentId: s.id,
        status: e?.status ?? e?.response?.status,
        err: e?.message,
      })
    }
  }

  log.info('segments.synced', {
    requestId,
    starredCount: starred.length,
    newlyTracked,
    unstarred,
    backfilledSegments,
    effortsWritten,
    failures,
  })

  return { starredCount: starred.length, newlyTracked, unstarred, backfilledSegments, effortsWritten, failures }
})
