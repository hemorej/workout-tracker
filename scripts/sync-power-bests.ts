/**
 * Syncs Strava's per-ride power streams into `strava_power_bests`, deriving
 * rolling-average power bests per duration (Strava's own power-curve UI has
 * no public API — see CLAUDE.md's Strava integration section).
 *
 * Retention: a row is kept only if it's currently in the all-time top 3 for
 * its duration, or its activity is within the trailing 8 weeks. Everything
 * else is pruned at the end of each run, so "all-time best" / "8-week best"
 * stay plain queries rather than separately maintained values.
 *
 * Standalone — does not use Nuxt/Nitro auto-imports (useRuntimeConfig,
 * useDB), since it's meant to run outside the app process (see CLAUDE.md /
 * conversation notes on Forge scheduler vs Nitro tasks). Reads the same env
 * vars the app does.
 *
 * Usage: pnpm sync-power-bests
 */

import { Pool } from 'pg'

const REQUIRED_ENV = ['DATABASE_URL', 'STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'STRAVA_REFRESH_TOKEN'] as const
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Error: ${key} environment variable is not set.`)
    process.exit(1)
  }
}

/** duration label -> seconds, matches schema.ts POWER_BEST_DURATIONS */
const DURATIONS: Record<string, number> = {
  '5sec': 5,
  '15sec': 15,
  '30sec': 30,
  '1min': 60,
  '2min': 120,
  '3min': 180,
  '5min': 300,
  '8min': 480,
  '10min': 600,
  '15min': 900,
  '20min': 1200,
  '30min': 1800,
  '45min': 2700,
  '1h': 3600,
}

const EIGHT_WEEKS_MS = 8 * 7 * 24 * 60 * 60 * 1000

/** Don't bother syncing anything before this — no need for older history right now. */
const SYNC_START_EPOCH_SECONDS = Math.floor(Date.UTC(2026, 0, 1) / 1000)

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// ---------------------------------------------------------------------------
// Strava API
// ---------------------------------------------------------------------------

async function getAccessToken(): Promise<string> {
  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  })
  if (!response.ok) {
    throw new Error(`Strava token refresh failed: ${response.status} ${await response.text()}`)
  }
  const data = await response.json() as { access_token: string }
  return data.access_token
}

interface StravaActivitySummary {
  id: number
  type: string
  start_date_local: string
}

async function* iterateRides(accessToken: string): AsyncGenerator<StravaActivitySummary> {
  let page = 1
  const perPage = 30
  while (true) {
    const response = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=${perPage}&page=${page}&after=${SYNC_START_EPOCH_SECONDS}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!response.ok) {
      throw new Error(`Strava activities fetch failed: ${response.status} ${await response.text()}`)
    }
    const activities = await response.json() as StravaActivitySummary[]
    if (activities.length === 0) return

    for (const activity of activities) {
      if (activity.type === 'Ride' || activity.type === 'VirtualRide') yield activity
    }
    page += 1
  }
}

interface StravaStreamSet {
  time?: { data: number[] }
  watts?: { data: number[] }
  moving?: { data: boolean[] }
}

/**
 * Longer rides (ours are typically 1-4h) aren't reliably sampled once per
 * second — devices doing "smart recording" only log a point when something
 * changes, so the raw watts array's index doesn't line up with elapsed
 * seconds. Resampling onto a uniform 1Hz grid via the `time` stream (holding
 * each sample's value forward until the next one) makes the index-based
 * sliding window in computeBests() actually correspond to real seconds,
 * regardless of the device's recording interval.
 *
 * A single stale sample is only held forward for up to MAX_GAP_SECONDS —
 * beyond that a gap more likely means a recording dropout than a real
 * sustained power output, so the remainder is treated as zero rather than
 * inflating a window with one held-over value.
 */
const MAX_GAP_SECONDS = 30

async function fetchPowerSeries(accessToken: string, activityId: number): Promise<number[] | null> {
  const response = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=time,watts,moving&key_by_type=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (response.status === 404) {
    // Manually-created or otherwise streamless activities 404 here even though they
    // showed up in the activity list — treat like "no power data" rather than dying.
    console.warn(`Activity ${activityId}: no streams available (404), skipping.`)
    return null
  }
  if (!response.ok) {
    throw new Error(`Strava streams fetch failed for activity ${activityId}: ${response.status} ${await response.text()}`)
  }
  const streams = await response.json() as StravaStreamSet
  if (!streams.watts?.data?.length) return null

  const watts = streams.watts.data
  const moving = streams.moving?.data
  const time = streams.time?.data

  // No time stream (shouldn't happen for a recorded ride) — fall back to the raw
  // array with pauses zeroed out, same as before, rather than failing the sync.
  if (!time?.length) return moving ? watts.map((w, i) => (moving[i] ? w : 0)) : watts

  const totalSeconds = time[time.length - 1] - time[0]
  if (totalSeconds <= 0) return watts

  const resampled = new Array<number>(totalSeconds + 1).fill(0)
  for (let i = 0; i < time.length; i++) {
    const value = moving && !moving[i] ? 0 : watts[i]
    const start = time[i] - time[0]
    const nextStart = i + 1 < time.length ? time[i + 1] - time[0] : start + 1
    const fillEnd = Math.min(nextStart, start + MAX_GAP_SECONDS, resampled.length)
    for (let s = start; s < fillEnd; s++) resampled[s] = value
  }
  return resampled
}

// ---------------------------------------------------------------------------
// Sliding-window max average, one pass per duration via prefix sums
// ---------------------------------------------------------------------------

function computeBests(watts: number[]): Record<string, number> {
  const prefix = new Float64Array(watts.length + 1)
  for (let i = 0; i < watts.length; i++) prefix[i + 1] = prefix[i] + watts[i]

  const bests: Record<string, number> = {}
  for (const [label, seconds] of Object.entries(DURATIONS)) {
    if (seconds > watts.length) continue // ride shorter than this duration
    let best = 0
    for (let start = 0; start + seconds <= watts.length; start++) {
      const avg = (prefix[start + seconds] - prefix[start]) / seconds
      if (avg > best) best = avg
    }
    if (best > 0) bests[label] = Math.round(best)
  }
  return bests
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const accessToken = await getAccessToken()

  const alreadySynced = new Set(
    (await pool.query('SELECT activity_id FROM strava_synced_activities')).rows.map((r) => Number(r.activity_id)),
  )

  let processed = 0
  let withPower = 0

  for await (const activity of iterateRides(accessToken)) {
    if (alreadySynced.has(activity.id)) {
      // Strava's documented sort order isn't guaranteed once `after` is in play, so skip
      // rather than break — the list call itself is cheap, only the streams fetch isn't.
      continue
    }

    const watts = await fetchPowerSeries(accessToken, activity.id)
    processed += 1

    if (watts) {
      withPower += 1
      const bests = computeBests(watts)
      const achievedAt = activity.start_date_local.slice(0, 10) // YYYY-MM-DD

      for (const [duration, value] of Object.entries(bests)) {
        await pool.query(
          `INSERT INTO strava_power_bests (activity_id, duration, watts, achieved_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (activity_id, duration) DO UPDATE SET watts = EXCLUDED.watts`,
          [activity.id, duration, value, achievedAt],
        )
      }
    }

    await pool.query(
      `INSERT INTO strava_synced_activities (activity_id, had_power)
       VALUES ($1, $2)
       ON CONFLICT (activity_id) DO NOTHING`,
      [activity.id, watts !== null],
    )
  }

  const cutoff = new Date(Date.now() - EIGHT_WEEKS_MS).toISOString().slice(0, 10)

  const { rowCount: pruned } = await pool.query(
    `DELETE FROM strava_power_bests
     WHERE id IN (
       SELECT id FROM (
         SELECT id, achieved_at,
                RANK() OVER (PARTITION BY duration ORDER BY watts DESC) AS rank
         FROM strava_power_bests
       ) ranked
       WHERE rank > 3 AND achieved_at < $1
     )`,
    [cutoff],
  )

  console.log(`Processed ${processed} new activities (${withPower} with power data).`)
  console.log(`Pruned ${pruned} rows no longer relevant to either window.`)

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  pool.end()
  process.exit(1)
})
