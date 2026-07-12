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

  const response = await $fetch<StravaTokenResponse>('https://www.strava.com/oauth/token', {
    method: 'POST',
    body: {
      client_id: config.stravaClientId,
      client_secret: config.stravaClientSecret,
      refresh_token: config.stravaRefreshToken,
      grant_type: 'refresh_token',
    },
  })

  const token: CachedToken = {
    accessToken: response.access_token,
    expiresAt: response.expires_at,
  }
  _cachedToken = token
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
}

interface StravaActivity {
  id: number
  name: string
  type: string
  start_date_local: string
  moving_time: number
  distance: number
}

/** Fetches the most recent Strava activities of type "Ride", newest first. */
export async function fetchRecentRides(limit = 3): Promise<StravaRideSummary[]> {
  const accessToken = await getStravaAccessToken()

  const activities = await $fetch<StravaActivity[]>('https://www.strava.com/api/v3/athlete/activities', {
    headers: { Authorization: `Bearer ${accessToken}` },
    query: { per_page: 15 },
  })

  return activities
    .filter((a) => a.type === 'Ride')
    .slice(0, limit)
    .map((a) => ({
      id: a.id,
      name: a.name,
      startDateLocal: a.start_date_local,
      movingTimeSeconds: a.moving_time,
      distanceMeters: a.distance,
    }))
}
