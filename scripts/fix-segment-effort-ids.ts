/**
 * One-off fix: re-pull every tracked segment's effort history and replace the
 * stored `segment_efforts` rows with ones carrying Strava's EXACT effort ids.
 *
 * Why: effort ids are ~3.5e18 (past 2^53) and Strava gives them no `id_str`, so
 * they used to be stored rounded by JSON.parse. The app now parses them exactly
 * (shared/utils/exactIds.ts); this swaps the old rounded rows for exact ones so
 * the next sync doesn't insert duplicates next to them. Everything is re-derived
 * from Strava, so nothing is lost.
 *
 * Per segment (ONE API call each), in ONE transaction: fetch the fastest 200
 * efforts (all Strava will return — it ignores `page`, and the UI only shows the
 * top 5) → clear the segment's rows → insert the fetched ones. A segment with
 * more than 200 efforts therefore ends up with its fastest 200. A fetch failure
 * leaves that segment untouched, and a segment is skipped (and reported) if
 * Strava returns FEWER efforts than we store (capped at 200). Idempotent.
 *
 * Strava allows 100 read requests / 15 min (200 overall). The script reads the rate-limit headers
 * and sleeps to the next quarter-hour window when it gets close (or on a 429),
 * so a full run can take a few windows. Don't overlap it with the 04:00
 * `segment reconcile` job.
 *
 * Needs DATABASE_URL, STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN
 * (the app's .env has them all). Run `pnpm install` first if node_modules is absent.
 *
 * Usage (from the repo / release dir):
 *   DRY_RUN=1 node --env-file=.env --experimental-strip-types scripts/fix-segment-effort-ids.ts   # preview, no writes
 *   node --env-file=.env --experimental-strip-types scripts/fix-segment-effort-ids.ts
 */

import { Pool } from 'pg'
import { parseJsonExactIds } from '../shared/utils/exactIds.ts'

const DRY_RUN = process.env.DRY_RUN === '1'
/** Strava ignores `page` and caps /segment_efforts at the fastest 200 — one call per segment (same as the app). */
const EFFORTS_CAP = 200
const STRAVA_API = 'https://www.strava.com/api/v3'

for (const k of ['DATABASE_URL', 'STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'STRAVA_REFRESH_TOKEN']) {
  if (!process.env[k]) {
    console.error(`Error: ${k} is not set.`)
    process.exit(1)
  }
}

interface Effort {
  id: string | number
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
  activity: { id: number, id_str?: string }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Strava's short window resets on the quarter hour. */
async function waitForNextWindow(): Promise<void> {
  const window = 15 * 60_000
  const ms = window - (Date.now() % window) + 5_000
  console.log(`  …rate limit close, sleeping ${Math.ceil(ms / 1000)}s until the next 15-min window`)
  await sleep(ms)
}

async function getAccessToken(): Promise<string> {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Strava token refresh failed: ${res.status}`)
  return ((await res.json()) as { access_token: string }).access_token
}

async function stravaGetText(token: string, path: string): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${STRAVA_API}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 429) {
      await waitForNextWindow()
      continue
    }
    if (!res.ok) throw new Error(`Strava ${res.status} on ${path}`)
    const text = await res.text()
    // Reads have their own, tighter 15-min budget (100) than the overall one (200) — watch both.
    const nearLimit = (usageHeader: string, limitHeader: string) => {
      const usage = Number(res.headers.get(usageHeader)?.split(',')[0])
      const limit = Number(res.headers.get(limitHeader)?.split(',')[0])
      return usage > 0 && limit > 0 && usage >= limit - 2
    }
    if (nearLimit('x-ratelimit-usage', 'x-ratelimit-limit') || nearLimit('x-readratelimit-usage', 'x-readratelimit-limit')) {
      await waitForNextWindow()
    }
    return text
  }
  throw new Error(`Strava rate limit not clearing on ${path}`)
}

async function fetchEfforts(token: string, segmentId: number): Promise<Effort[]> {
  const text = await stravaGetText(token, `/segment_efforts?segment_id=${segmentId}&per_page=${EFFORTS_CAP}`)
  return parseJsonExactIds(text) as Effort[]
}

const COLS = [
  'id', 'segment_id', 'user_id', 'strava_activity_id', 'elapsed_time', 'moving_time',
  'distance_meters', 'start_date', 'average_watts', 'device_watts', 'average_heartrate',
  'max_heartrate', 'average_cadence', 'pr_rank',
] as const

function rowValues(e: Effort, userId: number): unknown[] {
  if (!e.activity.id_str) throw new Error(`effort ${e.id} has no activity.id_str`)
  return [
    String(e.id), e.segment.id, userId, e.activity.id_str, e.elapsed_time, e.moving_time ?? null,
    e.distance ?? null, e.start_date, e.average_watts ?? null, e.device_watts ?? null,
    e.average_heartrate ?? null, e.max_heartrate ?? null, e.average_cadence ?? null, e.pr_rank ?? null,
  ]
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

try {
  const token = await getAccessToken()
  const { rows: segments } = await pool.query<{ id: string, user_id: number, name: string }>(
    'SELECT id, user_id, name FROM tracked_segments ORDER BY id',
  )
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}${segments.length} tracked segment(s)`)

  let replaced = 0
  let unchanged = 0
  const problems: string[] = []

  for (const seg of segments) {
    const segId = Number(seg.id)
    try {
      const { rows: stored } = await pool.query<{ id: string }>('SELECT id FROM segment_efforts WHERE segment_id = $1', [seg.id])
      const fetched = await fetchEfforts(token, segId)
      const unique = new Map(fetched.map((e) => [String(e.id), e]))

      // Segments with more than EFFORTS_CAP efforts keep only the fastest EFFORTS_CAP (the extras drop off).
      if (unique.size < Math.min(stored.length, EFFORTS_CAP)) {
        problems.push(`${seg.name} (${seg.id}): Strava returned ${unique.size} efforts but ${stored.length} are stored — skipped`)
        continue
      }
      if (fetched.some((e) => e.segment.id !== segId)) {
        problems.push(`${seg.name} (${seg.id}): response contained efforts for another segment — skipped`)
        continue
      }

      const storedIds = new Set(stored.map((r) => r.id))
      const differing = [...unique.keys()].filter((id) => !storedIds.has(id)).length
      if (differing === 0 && unique.size === stored.length) {
        unchanged += 1
        console.log(`  ok        ${seg.name}: ${unique.size} efforts already exact`)
        continue
      }
      console.log(`  ${DRY_RUN ? 'would fix' : 'fixing   '} ${seg.name}: ${stored.length} stored → ${unique.size} fetched (${differing} ids differ)`)
      if (DRY_RUN) continue

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // Scoped to this one segment, inside the transaction above.
        await client.query('DELETE FROM segment_efforts WHERE segment_id = $1', [seg.id])
        const efforts = [...unique.values()]
        const params = efforts.flatMap((e) => rowValues(e, seg.user_id))
        const placeholders = efforts
          .map((_, i) => `(${COLS.map((_c, j) => `$${i * COLS.length + j + 1}`).join(',')})`)
          .join(',')
        await client.query(`INSERT INTO segment_efforts (${COLS.join(',')}) VALUES ${placeholders}`, params)
        await client.query('COMMIT')
        replaced += 1
      }
      catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
      finally {
        client.release()
      }
    }
    catch (err) {
      problems.push(`${seg.name} (${seg.id}): ${(err as Error).message}`)
    }
  }

  console.log(`\nDone. replaced=${replaced} unchanged=${unchanged} problems=${problems.length}`)
  for (const p of problems) console.log(`  ! ${p}`)

  if (!DRY_RUN) {
    const { rows: mismatches } = await pool.query<{ name: string, stored: string, expected: number }>(
      `SELECT t.name, COUNT(e.id)::text AS stored, t.strava_effort_count AS expected
         FROM tracked_segments t LEFT JOIN segment_efforts e ON e.segment_id = t.id
        GROUP BY t.id HAVING COUNT(e.id) <> LEAST(COALESCE(t.strava_effort_count, COUNT(e.id)), ${EFFORTS_CAP})`,
    )
    console.log(mismatches.length === 0
      ? 'Verify: every segment\'s stored count matches strava_effort_count (capped at 200).'
      : `Verify: ${mismatches.length} segment(s) differ from strava_effort_count:`)
    for (const m of mismatches) console.log(`  ${m.name}: stored ${m.stored}, expected ${m.expected}`)
  }
  process.exitCode = problems.length > 0 ? 1 : 0
}
finally {
  await pool.end()
}
