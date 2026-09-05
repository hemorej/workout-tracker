/**
 * Strava segment + segment-effort access for the "tracked segments" feature
 * (see CLAUDE.md's Strava segments section).
 *
 * Everything here is scoped to the single connected athlete — Strava's API
 * only ever returns the authenticated athlete's own efforts on a segment,
 * never anyone else's, and there is no leaderboard endpoint any more.
 *
 * Token handling is shared with the rest of the Strava integration via
 * getStravaAccessToken() in ./strava.
 */

import { and, eq, notInArray, sql } from 'drizzle-orm'
import type { useDB } from '../db'
import { trackedSegments, segmentEfforts, type NewSegmentEffort } from '../db/schema'
import { getStravaAccessToken } from './strava'

const STRAVA_API = 'https://www.strava.com/api/v3'
const PER_PAGE = 200
/** Defensive ceiling on pagination — 200 * 40 = 8000 efforts, far past anything realistic. */
const MAX_PAGES = 40

// ── Raw Strava response shapes (partial — only the fields we persist) ──────

/** A row from GET /athlete/segments/starred (SummarySegment). */
export interface StravaSummarySegment {
  id: number
  name: string
  activity_type: string
  distance: number
  average_grade: number | null
  climb_category: number | null
  city: string | null
  state: string | null
  country: string | null
}

/** GET /segments/{id} (DetailedSegment) — adds elevation + athlete stats. */
export interface StravaDetailedSegment extends StravaSummarySegment {
  total_elevation_gain: number | null
  effort_count: number | null
  athlete_segment_stats?: {
    pr_elapsed_time: number | null
    pr_date: string | null
    effort_count: number | null
  } | null
}

/** A DetailedSegmentEffort, as returned by GET /segment_efforts and nested in an activity. */
export interface StravaSegmentEffort {
  id: number
  elapsed_time: number
  moving_time: number | null
  start_date: string
  distance: number | null
  average_watts: number | null
  device_watts: boolean | null
  average_heartrate: number | null
  max_heartrate: number | null
  average_cadence: number | null
  pr_rank: number | null
  segment: { id: number }
  activity: { id: number }
}

async function stravaGet<T>(path: string, query?: Record<string, string | number>): Promise<T> {
  const accessToken = await getStravaAccessToken()
  return $fetch(`${STRAVA_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    query,
  }) as Promise<T>
}

// ── Fetchers ─────────────────────────────────────────────────────────────

/** Every segment in the athlete's starred list (paginated). */
export async function fetchStarredSegments(): Promise<StravaSummarySegment[]> {
  const out: StravaSummarySegment[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await stravaGet<StravaSummarySegment[]>('/segments/starred', {
      page,
      per_page: PER_PAGE,
    })
    out.push(...batch)
    if (batch.length < PER_PAGE) break
  }
  return out
}

/** Full detail for one segment — elevation gain + `athlete_segment_stats`. */
export function fetchSegmentDetail(segmentId: number): Promise<StravaDetailedSegment> {
  return stravaGet<StravaDetailedSegment>(`/segments/${segmentId}`)
}

/**
 * Every effort the athlete has ever recorded on one segment (paginated).
 * Requires a Strava subscription — returns 4xx for a free account.
 */
export async function fetchAllSegmentEfforts(segmentId: number): Promise<StravaSegmentEffort[]> {
  const out: StravaSegmentEffort[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await stravaGet<StravaSegmentEffort[]>('/segment_efforts', {
      segment_id: segmentId,
      page,
      per_page: PER_PAGE,
    })
    out.push(...batch)
    if (batch.length < PER_PAGE) break
  }
  return out
}

/** The segment efforts attached to one activity (Strava matches them asynchronously). */
export async function fetchActivitySegmentEfforts(activityId: number): Promise<StravaSegmentEffort[]> {
  const activity = await stravaGet<{ segment_efforts?: StravaSegmentEffort[] }>(
    `/activities/${activityId}`,
    { include_all_efforts: 'true' },
  )
  return activity.segment_efforts ?? []
}

// ── Row mappers ──────────────────────────────────────────────────────────

/** Fields from a summary segment that a `tracked_segments` upsert can set. */
export function segmentSummaryFields(s: StravaSummarySegment) {
  return {
    name: s.name,
    distanceMeters: s.distance,
    averageGrade: s.average_grade ?? null,
    climbCategory: s.climb_category ?? null,
    city: s.city ?? null,
    state: s.state ?? null,
    country: s.country ?? null,
  }
}

/** The extra fields a detail response adds on top of `segmentSummaryFields`. */
export function segmentDetailFields(d: StravaDetailedSegment) {
  const stats = d.athlete_segment_stats
  return {
    ...segmentSummaryFields(d),
    totalElevationGain: d.total_elevation_gain ?? null,
    stravaEffortCount: stats?.effort_count ?? d.effort_count ?? null,
    prElapsedTime: stats?.pr_elapsed_time ?? null,
    prDate: stats?.pr_date ? stats.pr_date.slice(0, 10) : null,
  }
}

export function effortToRow(e: StravaSegmentEffort, userId: number): NewSegmentEffort {
  return {
    id: e.id,
    segmentId: e.segment.id,
    userId,
    stravaActivityId: e.activity.id,
    elapsedTime: e.elapsed_time,
    movingTime: e.moving_time ?? null,
    distanceMeters: e.distance ?? null,
    startDate: new Date(e.start_date),
    averageWatts: e.average_watts ?? null,
    deviceWatts: e.device_watts ?? null,
    averageHeartrate: e.average_heartrate ?? null,
    maxHeartrate: e.max_heartrate ?? null,
    averageCadence: e.average_cadence ?? null,
    prRank: e.pr_rank ?? null,
  }
}

// ── Persistence ──────────────────────────────────────────────────────────

type DB = ReturnType<typeof useDB>

/**
 * Upserts efforts keyed on the Strava effort id. `allowedSegmentIds`, when
 * given, drops any effort whose segment isn't tracked (used by the
 * per-activity sync, whose activity carries efforts for every segment).
 */
export async function upsertSegmentEfforts(
  db: DB,
  efforts: StravaSegmentEffort[],
  userId: number,
  allowedSegmentIds?: Set<number>,
): Promise<number> {
  const rows = efforts
    .filter((e) => !allowedSegmentIds || allowedSegmentIds.has(e.segment.id))
    .map((e) => effortToRow(e, userId))

  if (rows.length === 0) return 0

  await db
    .insert(segmentEfforts)
    .values(rows)
    .onConflictDoUpdate({
      target: segmentEfforts.id,
      set: {
        elapsedTime: sql`excluded.elapsed_time`,
        movingTime: sql`excluded.moving_time`,
        distanceMeters: sql`excluded.distance_meters`,
        averageWatts: sql`excluded.average_watts`,
        deviceWatts: sql`excluded.device_watts`,
        averageHeartrate: sql`excluded.average_heartrate`,
        maxHeartrate: sql`excluded.max_heartrate`,
        averageCadence: sql`excluded.average_cadence`,
        prRank: sql`excluded.pr_rank`,
      },
    })

  return rows.length
}

/**
 * Reconciles the local `tracked_segments` rows against a freshly-fetched
 * starred list: upserts a row per starred segment (`starred = true`), and
 * flips any row that's no longer starred to `starred = false` (the row and
 * its efforts are kept). Shared by the manual sync and the nightly reconcile.
 *
 * Returns bookkeeping the caller uses to decide what still needs a full
 * effort backfill: `alreadyBackfilled` is the set of segment ids whose
 * `last_synced_at` was already set before this call.
 */
export async function applyStarredList(
  db: DB,
  userId: number,
  starred: StravaSummarySegment[],
): Promise<{ newlyTracked: number, unstarred: number, alreadyBackfilled: Set<number> }> {
  const existing = await db
    .select({ id: trackedSegments.id, lastSyncedAt: trackedSegments.lastSyncedAt })
    .from(trackedSegments)
    .where(eq(trackedSegments.userId, userId))
  const knownIds = new Set(existing.map((r) => r.id))
  const alreadyBackfilled = new Set(existing.filter((r) => r.lastSyncedAt != null).map((r) => r.id))

  const starredIds = starred.map((s) => s.id)

  for (const s of starred) {
    await db
      .insert(trackedSegments)
      .values({ id: s.id, userId, starred: true, ...segmentSummaryFields(s) })
      .onConflictDoUpdate({
        target: trackedSegments.id,
        set: { starred: true, ...segmentSummaryFields(s) },
      })
  }

  const stillStarred = and(
    eq(trackedSegments.userId, userId),
    eq(trackedSegments.starred, true),
  )
  const unstarredRows = await db
    .update(trackedSegments)
    .set({ starred: false })
    .where(starredIds.length > 0
      ? and(stillStarred, notInArray(trackedSegments.id, starredIds))
      : stillStarred)
    .returning({ id: trackedSegments.id })

  return {
    newlyTracked: starredIds.filter((id) => !knownIds.has(id)).length,
    unstarred: unstarredRows.length,
    alreadyBackfilled,
  }
}

/**
 * Fire-and-forget: pull the segment efforts attached to a freshly-synced
 * outdoor Strava activity and upsert the ones on tracked segments. Never
 * throws — a failure here just means the nightly reconcile picks the efforts
 * up later. Called (unawaited) from the workout create/update handlers.
 */
export async function syncActivitySegmentEfforts(
  db: DB,
  userId: number,
  stravaActivityId: number,
  requestId?: string,
): Promise<void> {
  const log = getLogger('segments')
  try {
    const tracked = await db
      .select({ id: trackedSegments.id })
      .from(trackedSegments)
      .where(and(eq(trackedSegments.userId, userId), eq(trackedSegments.starred, true)))

    if (tracked.length === 0) return

    const trackedIds = new Set(tracked.map((t) => t.id))
    const efforts = await fetchActivitySegmentEfforts(stravaActivityId)
    const written = await upsertSegmentEfforts(db, efforts, userId, trackedIds)

    log.info('segments.activity_synced', {
      requestId,
      stravaActivityId,
      effortsOnTrackedSegments: written,
    })
  }
  catch (err: unknown) {
    const e = err as Record<string, unknown>
    log.warn('segments.activity_sync_failed', {
      requestId,
      stravaActivityId,
      status: (e?.status ?? (e?.response as Record<string, unknown>)?.status) as number | undefined,
      err: e?.message as string | undefined,
    })
  }
}

/** How many efforts are currently stored for one segment. */
export async function countStoredEfforts(db: DB, segmentId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(segmentEfforts)
    .where(eq(segmentEfforts.segmentId, segmentId))
  return row?.n ?? 0
}
