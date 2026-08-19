/**
 * Strava API access for the single-user "mark as completed" flow.
 *
 * OAuth is set up once, out of band (see CLAUDE.md) — this app never runs the
 * authorization redirect itself. It only holds a long-lived refresh token and
 * exchanges it for short-lived access tokens as needed.
 *
 * Access tokens expire every 6 hours; the refresh token does not expire under
 * normal use, so it's read straight from runtime config on every refresh.
 */

interface CachedToken {
  accessToken: string
  expiresAt: number // unix seconds
}

let _cachedToken: CachedToken | null = null

interface StravaTokenResponse {
  access_token: string
  expires_at: number
}

async function refreshAccessToken(): Promise<CachedToken> {
  const config = useRuntimeConfig()

  let response: StravaTokenResponse
  try {
    response = await $fetch<StravaTokenResponse>('https://www.strava.com/oauth/token', {
      method: 'POST',
      body: {
        client_id: config.stravaClientId,
        client_secret: config.stravaClientSecret,
        refresh_token: config.stravaRefreshToken,
        grant_type: 'refresh_token',
      },
    })
  } catch (err: unknown) {
    const e = err as Record<string, any>
    getLogger('strava').error('strava.token_refresh_failed', { status: e?.status ?? e?.response?.status })
    throw err
  }

  const token: CachedToken = {
    accessToken: response.access_token,
    expiresAt: response.expires_at,
  }
  _cachedToken = token
  getLogger('strava').info('strava.token_refreshed', { expiresAt: token.expiresAt })
  return token
}

/** Returns a valid Strava access token, refreshing it if expired or missing. */
export async function getStravaAccessToken(): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const bufferSeconds = 60

  if (_cachedToken && _cachedToken.expiresAt > nowSeconds + bufferSeconds) {
    return _cachedToken.accessToken
  }

  const token = await refreshAccessToken()
  return token.accessToken
}

export interface StravaRideSummary {
  id: number
  name: string
  /** Local start time, ISO-ish "YYYY-MM-DDTHH:mm:ssZ" per Strava's summary_activity schema */
  startDateLocal: string
  movingTimeSeconds: number
  distanceMeters: number
  /** Mirrors workouts.ride_type: 'trainer' for Strava's VirtualRide, 'outdoor' for Ride. */
  rideType: 'trainer' | 'outdoor'
}

interface StravaActivity {
  id: number
  name: string
  type: string
  start_date_local: string
  moving_time: number
  distance: number
}

interface StravaActivityDetail extends StravaActivity {
  map?: {
    summary_polyline?: string
  }
  average_watts?: number | null
  total_elevation_gain?: number | null
  average_speed?: number | null
}

export interface StravaActivityOverlayData {
  name: string
  distanceMeters: number
  movingTimeSeconds: number
  /** Decoded [lat, lng] points, empty if the activity has no route (e.g. manually entered). */
  points: [number, number][]
  /** Null if the activity has no power data (e.g. no power meter). */
  avgWatts: number | null
  elevationGainMeters: number
  /** Meters per second, null if unavailable (e.g. manually entered ride). */
  avgSpeedMetersPerSecond: number | null
  /** Local start time, ISO-ish "YYYY-MM-DDTHH:mm:ssZ" per Strava's activity schema. */
  startDateLocal: string
}

export interface StravaStreamPoint {
  /** Elapsed seconds from ride start */
  t: number
  watts: number | null
  heartrate: number | null
}

interface StravaStreamSet {
  time?: { data: number[] }
  watts?: { data: number[] }
  heartrate?: { data: number[] }
}

/**
 * Fetches the raw per-second power/HR stream for a Strava activity and
 * downsamples it to ~maxPoints evenly-spaced samples (simple bucket
 * averaging) — a multi-hour ride's raw stream is one point per second, far
 * more than an insights prompt needs or should spend tokens on. Streams are
 * kept on Strava's side indefinitely; the app never persists them (see
 * workouts.stravaActivityId in server/db/schema.ts).
 *
 * Returns an empty array if the activity has no power/HR streams at all
 * (e.g. a ride with no power meter) rather than throwing — callers should
 * treat that the same as "no stream available".
 */
export async function fetchActivityStreams(activityId: number, maxPoints = 120): Promise<StravaStreamPoint[]> {
  const accessToken = await getStravaAccessToken()

  const streams = await $fetch<StravaStreamSet>(`https://www.strava.com/api/v3/activities/${activityId}/streams`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    query: { keys: 'time,watts,heartrate', key_by_type: true },
  })

  const time = streams.time?.data ?? []
  const watts = streams.watts?.data ?? []
  const heartrate = streams.heartrate?.data ?? []
  if (time.length === 0 || (watts.length === 0 && heartrate.length === 0)) return []

  const bucketSize = Math.max(1, Math.ceil(time.length / maxPoints))
  const points: StravaStreamPoint[] = []
  for (let start = 0; start < time.length; start += bucketSize) {
    const end = Math.min(start + bucketSize, time.length)
    const wattsSlice = watts.slice(start, end).filter((w) => w !== undefined)
    const hrSlice = heartrate.slice(start, end).filter((h) => h !== undefined)
    points.push({
      t: time[start]!,
      watts: wattsSlice.length > 0 ? Math.round(mean(wattsSlice)) : null,
      heartrate: hrSlice.length > 0 ? Math.round(mean(hrSlice)) : null,
    })
  }
  return points
}

function mean(arr: number[]): number {
  return arr.reduce((sum, v) => sum + v, 0) / arr.length
}

/**
 * Fetches a single Strava activity's detail (name, distance, moving time,
 * and route) for the photo-overlay feature. `summary_polyline` is used
 * rather than the full-resolution `polyline` — smaller payload, plenty
 * precise for a photo overlay rendered at typical canvas sizes.
 */
export async function fetchStravaActivityOverlayData(activityId: number): Promise<StravaActivityOverlayData> {
  const accessToken = await getStravaAccessToken()

  const activity = await $fetch<StravaActivityDetail>(`https://www.strava.com/api/v3/activities/${activityId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  const encoded = activity.map?.summary_polyline
  return {
    name: activity.name,
    distanceMeters: activity.distance,
    movingTimeSeconds: activity.moving_time,
    points: encoded ? decodePolyline(encoded) : [],
    avgWatts: activity.average_watts ?? null,
    elevationGainMeters: activity.total_elevation_gain ?? 0,
    avgSpeedMetersPerSecond: activity.average_speed ?? null,
    startDateLocal: activity.start_date_local,
  }
}

/** Fetches the most recent Strava activities of type "Ride", newest first. */
export async function fetchRecentStravaRides(limit = 3): Promise<StravaRideSummary[]> {
  const accessToken = await getStravaAccessToken()

  const activities = await $fetch<StravaActivity[]>('https://www.strava.com/api/v3/athlete/activities', {
    headers: { Authorization: `Bearer ${accessToken}` },
    query: { per_page: 15 },
  })

  // "Ride" covers outdoor rides; Zwift/indoor trainer sessions come back as "VirtualRide".
  return activities
    .filter((a) => a.type === 'Ride' || a.type === 'VirtualRide')
    .slice(0, limit)
    .map((a) => ({
      id: a.id,
      name: a.name,
      startDateLocal: a.start_date_local,
      movingTimeSeconds: a.moving_time,
      distanceMeters: a.distance,
      rideType: (a.type === 'VirtualRide' ? 'trainer' : 'outdoor') as 'trainer' | 'outdoor',
    }))
}
