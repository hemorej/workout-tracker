/**
 * Wahoo Cloud API access for the single-user "mark planned workout as
 * completed" flow — the Wahoo equivalent of server/utils/strava.ts, but
 * additionally able to fetch the actual recorded FIT file (Strava's API has
 * no such endpoint; see CLAUDE.md).
 *
 * OAuth is set up once, out of band (see CLAUDE.md) — this app never runs
 * the authorization redirect itself. It only holds a long-lived refresh
 * token and exchanges it for short-lived access tokens as needed.
 *
 * Access tokens expire every 2 hours (shorter-lived than Strava's 6).
 *
 * CONFIRMED: Wahoo rotates the refresh token on every use — each refresh
 * response's `refresh_token` invalidates the previous one. WAHOO_REFRESH_TOKEN
 * is only ever read as the *first* refresh token for a given process; every
 * refresh after that reuses whatever Wahoo returned last time, held in
 * `_cachedRefreshToken`. That means the token in .env goes stale the moment
 * this process performs its first successful refresh — if the process
 * restarts (deploy, dev server restart, crash), the .env value will no
 * longer work and Wahoo returns invalid_grant. When that happens, re-run the
 * one-time OAuth exchange (see CLAUDE.md) for a new token — there is no way
 * to recover in-process. A rotated token is logged at `warn` specifically so
 * it's visible and copyable when this happens.
 */

import { parseFitFile, type ParsedFitMetrics } from './fit'

interface CachedToken {
  accessToken: string
  expiresAt: number // unix seconds
}

let _cachedToken: CachedToken | null = null
/** Overrides config.wahooRefreshToken once Wahoo has rotated it at least once this process. */
let _cachedRefreshToken: string | null = null

interface WahooTokenResponse {
  access_token: string
  expires_in: number // seconds
  refresh_token?: string
}

async function refreshAccessToken(): Promise<CachedToken> {
  const config = useRuntimeConfig()
  const refreshToken = _cachedRefreshToken ?? config.wahooRefreshToken

  let response: WahooTokenResponse
  try {
    response = await $fetch<WahooTokenResponse>('https://api.wahooligan.com/oauth/token', {
      method: 'POST',
      body: {
        client_id: config.wahooClientId,
        client_secret: config.wahooClientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      },
    })
  } catch (err: unknown) {
    const e = err as Record<string, any>
    getLogger('wahoo').error('wahoo.token_refresh_failed', { status: e?.status ?? e?.response?.status })
    throw err
  }

  if (response.refresh_token && response.refresh_token !== refreshToken) {
    _cachedRefreshToken = response.refresh_token
    getLogger('wahoo').warn('wahoo.refresh_token_rotated', { newRefreshToken: response.refresh_token })
  }

  const token: CachedToken = {
    accessToken: response.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + response.expires_in,
  }
  _cachedToken = token
  getLogger('wahoo').info('wahoo.token_refreshed', { expiresAt: token.expiresAt })
  return token
}

/** Returns a valid Wahoo access token, refreshing it if expired or missing. */
export async function getWahooAccessToken(): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const bufferSeconds = 60

  if (_cachedToken && _cachedToken.expiresAt > nowSeconds + bufferSeconds) {
    return _cachedToken.accessToken
  }

  const token = await refreshAccessToken()
  return token.accessToken
}

export interface WahooRideSummary {
  id: number
  name: string
  /** Local start time, ISO-ish "YYYY-MM-DDTHH:mm:ssZ" */
  startDateLocal: string
  movingTimeSeconds: number
  distanceMeters: number
  rideType: 'trainer' | 'outdoor'
}

/**
 * Wahoo's full workout_type_id enum (undocumented on the API reference site
 * itself, but present in cloud-api.wahooligan.com's schema) has dozens of
 * ids across many sports, each tagged Indoor or Outdoor. These are just the
 * cycling ones, split by that tag — id 0 (BIKING, Outdoor) is also reused by
 * SYSTM-generated planned-but-not-yet-ridden entries, which is why plan_id
 * filtering in fetchRecentRides matters more than this type check alone.
 */
const OUTDOOR_BIKING_WORKOUT_TYPE_IDS = new Set([
  0, // BIKING
  11, // BIKING_CYCLECROSS
  13, // BIKING_MOUNTAIN
  14, // BIKING_RECUMBENT
  15, // BIKING_ROAD
  16, // BIKING_TRACK
  17, // BIKING_MOTOCYCLING
  64, // EBIKING
  70, // HANDCYCLING
])
const INDOOR_WORKOUT_TYPE_IDS = new Set([
  12, // BIKING_INDOOR
  49, // BIKING_INDOOR_CYCLING_CLASS
  61, // BIKING_INDOOR_TRAINER
  68, // BIKING_INDOOR_VIRTUAL (Zwift)
])
const BIKING_WORKOUT_TYPE_IDS = new Set([...OUTDOOR_BIKING_WORKOUT_TYPE_IDS, ...INDOOR_WORKOUT_TYPE_IDS])

interface WahooWorkoutSummary {
  file?: { url: string } | null
  /** Meters, as a numeric string — Wahoo returns workout_summary metrics as strings, not numbers. */
  distance_accum?: string | null
}

interface WahooWorkout {
  id: number
  name: string | null
  starts: string
  minutes: number
  workout_type_id: number
  /**
   * Non-null means this entry was generated from a training plan
   * (SYSTM/RGT). Critically, this does NOT mean it was completed — a
   * scheduled-but-never-ridden entry keeps workout_summary: null and has
   * suspiciously round `starts`/`minutes` (the plan's scheduled values, not
   * a real recording). Excluded entirely below rather than trying to
   * distinguish "planned and done" from "planned and skipped" without an
   * extra per-item detail fetch.
   */
  plan_id: number | null
  workout_summary?: WahooWorkoutSummary | null
}

interface WahooWorkoutsResponse {
  workouts: WahooWorkout[]
  /** Observed to already be order: "descending", sort: "starts" — no client-side re-sort needed. */
  order: string
  sort: string
}

function toRideSummary(w: WahooWorkout): WahooRideSummary {
  return {
    id: w.id,
    name: w.name?.trim() || 'Wahoo ride',
    startDateLocal: w.starts,
    movingTimeSeconds: Math.round(w.minutes * 60),
    // Wahoo's workout list doesn't carry distance directly — only
    // workout_summary does, which is only populated on the per-activity
    // fetch (fetchAndParseActivity), not the list endpoint used here.
    distanceMeters: w.workout_summary?.distance_accum ? Number(w.workout_summary.distance_accum) : 0,
    rideType: INDOOR_WORKOUT_TYPE_IDS.has(w.workout_type_id) ? 'trainer' : 'outdoor',
  }
}

/** Fetches the most recent completed Wahoo biking workouts, newest first. */
export async function fetchRecentRides(limit = 3): Promise<WahooRideSummary[]> {
  const accessToken = await getWahooAccessToken()

  const response = await $fetch<WahooWorkoutsResponse>('https://api.wahooligan.com/v1/workouts', {
    headers: { Authorization: `Bearer ${accessToken}` },
    query: { page: 1, per_page: 15 },
  })

  return response.workouts
    .filter((w) => BIKING_WORKOUT_TYPE_IDS.has(w.workout_type_id) && w.plan_id === null)
    .slice(0, limit)
    .map(toRideSummary)
}

export interface WahooActivityDetail {
  ride: WahooRideSummary
  metrics: ParsedFitMetrics
}

/**
 * Finds the most recent Wahoo biking workout that started on the given
 * calendar day (local date, "YYYY-MM-DD"). Used to match a Strava-sourced
 * activity (the picker's source of truth, see CLAUDE.md's Strava/Wahoo
 * refactor) to its corresponding Wahoo workout so the original FIT file can
 * be fetched — the user only ever logs one ride per day, so same-day is a
 * reliable match without needing to correlate by id or duration.
 */
export async function findRideByDate(dateLocal: string, searchLimit = 15): Promise<WahooRideSummary | null> {
  const rides = await fetchRecentRides(searchLimit)
  return rides.find((r) => r.startDateLocal.slice(0, 10) === dateLocal) ?? null
}

/**
 * Fetches a single workout's FIT file and parses it against the given FTP.
 * Throws if the workout has no associated FIT file (workout_summary.file)
 * or the file has no power data.
 */
export async function fetchAndParseActivity(workoutId: number, ftpWatts: number): Promise<WahooActivityDetail> {
  const accessToken = await getWahooAccessToken()

  const workout = await $fetch<WahooWorkout>(`https://api.wahooligan.com/v1/workouts/${workoutId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  const fileUrl = workout.workout_summary?.file?.url
  if (!fileUrl) {
    throw createError({ statusCode: 422, statusMessage: 'This Wahoo workout has no FIT file available yet.' })
  }

  const fileBuffer = await $fetch<ArrayBuffer>(fileUrl, { responseType: 'arrayBuffer' })
  const metrics = await parseFitFile(Buffer.from(fileBuffer), ftpWatts)

  return { ride: toRideSummary(workout), metrics }
}
