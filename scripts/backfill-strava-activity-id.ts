/**
 * One-off backfill: populate workouts.strava_activity_id for historical
 * entries logged before this field existed, so the AI insights endpoint can
 * fetch their raw power/HR stream from Strava (see server/utils/strava.ts's
 * fetchActivityStreams, used by server/api/workouts/[id]/insights.post.ts).
 *
 * Matching strategy: one workout per calendar day (enforced by the DB's
 * unique (user_id, date) index), so each workout is matched to the Strava
 * Ride/VirtualRide activity that started on the same local date. Only rows
 * with strava_activity_id IS NULL are touched — safe to re-run.
 *
 * Usage:
 *   pnpm dlx dotenv-cli -e .env -- node --experimental-strip-types scripts/backfill-strava-activity-id.ts
 */

import { Pool } from 'pg'

const EMAIL = 'jerome.arfouche@pm.me'

for (const key of ['DATABASE_URL', 'STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'STRAVA_REFRESH_TOKEN']) {
  if (!process.env[key]) {
    console.error(`Error: ${key} environment variable is not set.`)
    process.exit(1)
  }
}

// ── Strava auth ──────────────────────────────────────────────────────────

interface StravaTokenResponse {
  access_token: string
}

async function getAccessToken(): Promise<string> {
  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`)
  }
  const data = await response.json() as StravaTokenResponse
  return data.access_token
}

// ── Strava activity fetch (paginated) ────────────────────────────────────

interface StravaActivity {
  id: number
  name: string
  type: string
  start_date_local: string
  distance: number // metres
}

/** Fetches every Ride/VirtualRide activity on or after `afterUnix`, oldest constraint via pagination. */
async function fetchAllRidesSince(accessToken: string, afterUnix: number): Promise<StravaActivity[]> {
  const rides: StravaActivity[] = []
  let page = 1
  const perPage = 100

  while (true) {
    const url = new URL('https://www.strava.com/api/v3/athlete/activities')
    url.searchParams.set('after', String(afterUnix))
    url.searchParams.set('per_page', String(perPage))
    url.searchParams.set('page', String(page))

    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!response.ok) {
      throw new Error(`Strava activities fetch failed: ${response.status} ${await response.text()}`)
    }
    const batch = await response.json() as StravaActivity[]
    if (batch.length === 0) break

    for (const a of batch) {
      if (a.type === 'Ride' || a.type === 'VirtualRide') rides.push(a)
    }

    if (batch.length < perPage) break
    page += 1
  }

  return rides
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  const { rows: users } = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])
  const userId = users[0]?.id
  if (!userId) {
    console.error(`No user found with email: ${EMAIL}`)
    await pool.end()
    process.exit(1)
  }

  // Cast date to text explicitly — the pg driver otherwise parses the DATE
  // column into a JS Date (with TZ-dependent formatting), which breaks the
  // plain "YYYY-MM-DD" string matching used below.
  const { rows: missing } = await pool.query<{ id: number, date: string, name: string }>(
    `SELECT id, date::text AS date, name FROM workouts
     WHERE user_id = $1 AND strava_activity_id IS NULL
     ORDER BY date ASC`,
    [userId],
  )

  if (missing.length === 0) {
    console.log('No workouts are missing strava_activity_id — nothing to backfill.')
    await pool.end()
    return
  }

  const earliestDate = missing[0]!.date
  console.log(`Backfilling strava_activity_id for ${missing.length} workout(s) from ${earliestDate} onward…`)

  // Fetch from a day before the earliest missing workout to be safe against local/UTC boundary drift.
  const afterUnix = Math.floor(new Date(`${earliestDate}T00:00:00Z`).getTime() / 1000) - 86400

  const accessToken = await getAccessToken()
  const rides = await fetchAllRidesSince(accessToken, afterUnix)
  console.log(`Fetched ${rides.length} ride(s) from Strava.`)

  // Index rides by local calendar date. If more than one ride lands on the
  // same date, keep the longest by distance — a reasonable tie-breaker for
  // a "one workout per day" logging habit (e.g. a short warm-up + main ride).
  const rideByDate = new Map<string, StravaActivity>()
  for (const ride of rides) {
    const date = ride.start_date_local.slice(0, 10)
    const existing = rideByDate.get(date)
    if (!existing || ride.distance > existing.distance) {
      rideByDate.set(date, ride)
    }
  }

  let matched = 0
  const unmatched: { date: string, name: string }[] = []

  for (const workout of missing) {
    const ride = rideByDate.get(workout.date)
    if (!ride) {
      unmatched.push({ date: workout.date, name: workout.name })
      continue
    }
    await pool.query('UPDATE workouts SET strava_activity_id = $1 WHERE id = $2', [ride.id, workout.id])
    matched += 1
  }

  console.log(`Matched and updated ${matched} of ${missing.length} workout(s).`)
  if (unmatched.length > 0) {
    console.log(`No matching Strava ride found for ${unmatched.length} workout(s):`)
    for (const u of unmatched) console.log(`  ${u.date} — ${u.name}`)
  }

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
