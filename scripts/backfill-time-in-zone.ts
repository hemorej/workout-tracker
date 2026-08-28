/**
 * One-off backfill: populate `fit_data.zoneBuckets` (seconds per power zone,
 * Z1..Z6) and `fit_data.zoneFtp` for existing 2026 workouts, so the Power tab
 * in WorkoutFitOverlay.vue has data for rides logged before those fields
 * existed.
 *
 * Zone buckets are computed by re-parsing each ride's FIT file with the same
 * `parseFitFile` the app uses (server/utils/fit.ts), against the FTP that
 * applied on the ride's date — carry-forward from the athlete's `ftp_watts`
 * markers (see makeFtpForDate; mirrors getFtpAsOf in server/utils/ftp.ts),
 * not the workout's own (usually null) column. That FTP is stored as
 * `zoneFtp` so the Power tab's watt bands line up with the split. Where a row
 * has no `fit_data` at all, the whole blob (avg/max power, NP, IF, HR,
 * cadence + zone keys) is written; where `fit_data` already exists, only the
 * `zoneBuckets` / `zoneFtp` keys are merged in — the previously-computed
 * avg/NP/HR values are left untouched.
 *
 * FIT file source, per ride:
 *   - trainer / indoor (Zwift) → local file under ZWIFT_DIR, matched by the
 *     `YYYY-MM-DD-*.fit` filename date (largest file wins if several).
 *   - outdoor → the Wahoo workout that started that calendar day, paged out
 *     of the Wahoo Cloud API and its FIT file downloaded.
 *   - ride_type NULL → tries the local Zwift file first, then Wahoo.
 *
 * Only touches workouts dated 2026-01-01 .. 2026-12-31. A row is processed if
 * it lacks `zoneBuckets` or `zoneFtp` (so a plain re-run also refreshes rows
 * an earlier version bucketed against the wrong FTP), or always with FORCE=1.
 * Safe to re-run; unmatched / unparseable rides are reported and left alone.
 *
 * NOTE: this rotates the Wahoo refresh token (Wahoo rotates on every use —
 * see CLAUDE.md). It reads the live token from the `wahoo_tokens` row and
 * persists the rotated one back, same as the app. Don't run it while the dev
 * server is also making Wahoo calls.
 *
 * Run via tsx (not `node --experimental-strip-types`): this imports
 * server/utils/fit.ts, whose own imports are extensionless and need a real
 * TS-aware loader to resolve.
 *
 * Usage:
 *   DRY_RUN=1 pnpm dlx dotenv-cli -e .env -- pnpm exec tsx scripts/backfill-time-in-zone.ts   # preview, no writes
 *   pnpm dlx dotenv-cli -e .env -- pnpm exec tsx scripts/backfill-time-in-zone.ts
 *   FORCE=1 pnpm dlx dotenv-cli -e .env -- pnpm exec tsx scripts/backfill-time-in-zone.ts       # recompute every 2026 row
 *   ZWIFT_DIR=/path/to/Activities pnpm dlx dotenv-cli -e .env -- pnpm exec tsx scripts/backfill-time-in-zone.ts
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { parseFitFile } from '../server/utils/fit.ts'

const EMAIL = 'jerome.arfouche@pm.me'
const YEAR_START = '2026-01-01'
const YEAR_END = '2026-12-31'
const DEFAULT_FTP = 230
const FORCE = process.env.FORCE === '1'
/** DRY_RUN=1 → resolve + parse every FIT and print what would change, but issue no UPDATEs. */
const DRY_RUN = process.env.DRY_RUN === '1'
const ZWIFT_DIR = process.env.ZWIFT_DIR ?? join(homedir(), 'Documents/Zwift/Activities')

for (const key of ['DATABASE_URL']) {
  if (!process.env[key]) {
    console.error(`Error: ${key} environment variable is not set.`)
    process.exit(1)
  }
}

// ── Wahoo Cloud API (outdoor FIT files) ──────────────────────────────────
//
// Reimplemented here rather than importing server/utils/wahoo.ts: that module
// depends on Nitro auto-imports ($fetch, useRuntimeConfig, getLogger) that
// don't exist in a plain node script, and its list fetch is hardcoded to the
// 15 most-recent workouts — too shallow for a whole-year backfill.

const OUTDOOR_BIKING_WORKOUT_TYPE_IDS = new Set([0, 11, 13, 14, 15, 16, 17, 64, 70])
const INDOOR_WORKOUT_TYPE_IDS = new Set([12, 49, 61, 68])
const BIKING_WORKOUT_TYPE_IDS = new Set([...OUTDOOR_BIKING_WORKOUT_TYPE_IDS, ...INDOOR_WORKOUT_TYPE_IDS])

interface WahooWorkout {
  id: number
  starts: string
  workout_type_id: number
  plan_id: number | null
  workout_summary?: { file?: { url: string } | null } | null
}

interface WahooTokenResponse {
  access_token: string
  refresh_token?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * GET with retry/backoff on 429 and 5xx. Wahoo enforces a per-hour request
 * quota; a whole-year sweep plus repeated runs can exhaust it, in which case
 * only a wait of up to ~an hour clears it — re-run the script later (it's
 * idempotent and resumes from the still-missing rows). Honours `Retry-After`
 * when present, otherwise backs off 30s → 2min.
 */
async function wahooGet(url: string | URL, accessToken: string, attempt = 1): Promise<Response> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if ((res.status === 429 || res.status >= 500) && attempt <= 6) {
    const wait = Number(res.headers.get('retry-after')) * 1000 || Math.min(attempt * 30_000, 120_000)
    console.log(`    Wahoo ${res.status} — retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}/6)`)
    await sleep(wait)
    return wahooGet(url, accessToken, attempt + 1)
  }
  return res
}

async function getWahooAccessToken(pool: Pool): Promise<string> {
  for (const key of ['WAHOO_CLIENT_ID', 'WAHOO_CLIENT_SECRET']) {
    if (!process.env[key]) throw new Error(`${key} is not set — needed for the outdoor (Wahoo) branch.`)
  }

  const { rows } = await pool.query<{ refresh_token: string }>(
    'SELECT refresh_token FROM wahoo_tokens WHERE id = 1',
  )
  const refreshToken = rows[0]?.refresh_token ?? process.env.WAHOO_REFRESH_TOKEN
  if (!refreshToken) throw new Error('No Wahoo refresh token in wahoo_tokens or WAHOO_REFRESH_TOKEN.')

  const res = await fetch('https://api.wahooligan.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.WAHOO_CLIENT_ID,
      client_secret: process.env.WAHOO_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Wahoo token refresh failed: ${res.status} ${await res.text()}`)
  const data = await res.json() as WahooTokenResponse

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await pool.query(
      `INSERT INTO wahoo_tokens (id, refresh_token, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET refresh_token = $1, updated_at = now()`,
      [data.refresh_token],
    )
    console.log('  (rotated + persisted Wahoo refresh token)')
  }
  return data.access_token
}

/** Pages the Wahoo workout list (newest first) until entries predate 2026, indexing biking rides by local start date. */
async function buildWahooRidesByDate(accessToken: string): Promise<Map<string, WahooWorkout[]>> {
  const byDate = new Map<string, WahooWorkout[]>()
  const perPage = 30
  for (let page = 1; page <= 60; page++) {
    const url = new URL('https://api.wahooligan.com/v1/workouts')
    url.searchParams.set('page', String(page))
    url.searchParams.set('per_page', String(perPage))
    const res = await wahooGet(url, accessToken)
    if (!res.ok) throw new Error(`Wahoo workouts fetch failed: ${res.status} ${await res.text()}`)
    const { workouts } = await res.json() as { workouts: WahooWorkout[] }
    if (workouts.length === 0) break

    let allBefore2026 = true
    for (const w of workouts) {
      const date = w.starts.slice(0, 10)
      if (date >= YEAR_START) allBefore2026 = false
      if (date < YEAR_START || date > YEAR_END) continue
      if (!BIKING_WORKOUT_TYPE_IDS.has(w.workout_type_id) || w.plan_id !== null) continue
      const list = byDate.get(date) ?? []
      list.push(w)
      byDate.set(date, list)
    }

    if (workouts.length < perPage) break
    if (allBefore2026) break
  }
  return byDate
}

async function downloadWahooFit(accessToken: string, workoutId: number): Promise<Buffer | null> {
  const res = await wahooGet(`https://api.wahooligan.com/v1/workouts/${workoutId}`, accessToken)
  if (!res.ok) throw new Error(`Wahoo workout ${workoutId} fetch failed: ${res.status}`)
  const detail = await res.json() as WahooWorkout
  const fileUrl = detail.workout_summary?.file?.url
  if (!fileUrl) return null
  const fileRes = await fetch(fileUrl) // S3 pre-signed URL, not rate-limited
  if (!fileRes.ok) throw new Error(`FIT download failed for ${workoutId}: ${fileRes.status}`)
  await sleep(400) // be gentle on the Wahoo API between activity fetches
  return Buffer.from(await fileRes.arrayBuffer())
}

// ── Local Zwift FIT files (indoor branch) ────────────────────────────────

/** date "YYYY-MM-DD" -> absolute paths of local `YYYY-MM-DD-*.fit` files, largest first. */
async function buildZwiftFilesByDate(): Promise<Map<string, string[]>> {
  const byDate = new Map<string, { path: string, size: number }[]>()
  let entries: string[]
  try {
    entries = await readdir(ZWIFT_DIR)
  } catch {
    console.warn(`Zwift dir not readable (${ZWIFT_DIR}) — indoor rides will be unmatched.`)
    return new Map()
  }
  for (const name of entries) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})-.*\.fit$/i)
    if (!m) continue
    const path = join(ZWIFT_DIR, name)
    const { size } = await stat(path)
    const list = byDate.get(m[1]!) ?? []
    list.push({ path, size })
    byDate.set(m[1]!, list)
  }
  return new Map(
    [...byDate].map(([date, list]) => [date, list.sort((a, b) => b.size - a.size).map((f) => f.path)]),
  )
}

// ── Main ────────────────────────────────────────────────────────────────

interface WorkoutRow {
  id: number
  date: string
  name: string
  ride_type: 'trainer' | 'outdoor' | null
  has_fit_data: boolean
  has_zone_buckets: boolean
  has_zone_ftp: boolean
}

/**
 * Carry-forward FTP: `ftp_watts` is a sparse "changed to X as of this day"
 * marker, so the FTP that applied on `date` is the latest marker on or before
 * it. Dates before the first marker carry the earliest known value backward.
 * Mirrors getFtpAsOf in server/utils/ftp.ts.
 */
function makeFtpForDate(markers: { date: string, ftp: number }[]): (date: string) => number {
  const sorted = [...markers].sort((a, b) => a.date.localeCompare(b.date))
  return (date: string) => {
    let val = sorted[0]?.ftp ?? DEFAULT_FTP
    for (const m of sorted) {
      if (m.date <= date) val = m.ftp
      else break
    }
    return val
  }
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  const { rows: users } = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])
  const userId = users[0]?.id
  if (!userId) {
    console.error(`No user found with email: ${EMAIL}`)
    await pool.end()
    process.exit(1)
  }

  const { rows: workouts } = await pool.query<WorkoutRow>(
    `SELECT id, date::text AS date, name, ride_type,
            (fit_data IS NOT NULL)                AS has_fit_data,
            (fit_data ? 'zoneBuckets')           AS has_zone_buckets,
            (fit_data ? 'zoneFtp')               AS has_zone_ftp
     FROM workouts
     WHERE user_id = $1 AND date >= $2 AND date <= $3
     ORDER BY date ASC`,
    [userId, YEAR_START, YEAR_END],
  )

  // Every FTP marker the athlete has ever logged — not just 2026 — so the
  // carry-forward is correct at the start of the window.
  const { rows: markerRows } = await pool.query<{ date: string, ftp: number }>(
    `SELECT date::text AS date, ftp_watts AS ftp FROM workouts
     WHERE user_id = $1 AND ftp_watts IS NOT NULL ORDER BY date ASC`,
    [userId],
  )
  const ftpForDate = makeFtpForDate(markerRows)
  console.log(
    `FTP markers: ${markerRows.length ? markerRows.map((m) => `${m.date}→${m.ftp}w`).join(', ') : 'none, using ' + DEFAULT_FTP + 'w'}`,
  )

  // Recompute a row if it has no buckets yet, or has buckets that predate the
  // zoneFtp field (bucketed against a possibly-wrong FTP), or FORCE.
  const todo = workouts.filter((w) => FORCE || !w.has_zone_buckets || !w.has_zone_ftp)
  console.log(
    `${workouts.length} workout(s) in 2026; ${todo.length} to process`
    + `${FORCE ? ' (FORCE — recomputing all)' : ` (${workouts.length - todo.length} already current)`}.`,
  )
  if (todo.length === 0) {
    await pool.end()
    return
  }

  const needsOutdoor = todo.some((w) => w.ride_type !== 'trainer')
  const zwiftByDate = await buildZwiftFilesByDate()
  console.log(`Indexed local Zwift FIT files for ${zwiftByDate.size} date(s).`)

  let wahooToken: string | null = null
  let wahooByDate = new Map<string, WahooWorkout[]>()
  if (needsOutdoor) {
    try {
      wahooToken = await getWahooAccessToken(pool)
      wahooByDate = await buildWahooRidesByDate(wahooToken)
      console.log(`Indexed Wahoo rides for ${wahooByDate.size} date(s) in 2026.`)
    } catch (err) {
      console.warn(`Wahoo unavailable — outdoor rides will be unmatched: ${(err as Error).message}`)
    }
  }

  let updated = 0
  const skipped: { date: string, name: string, reason: string }[] = []

  for (const w of todo) {
    const ftp = ftpForDate(w.date)

    // Resolve a FIT buffer for this ride.
    let buf: Buffer | null = null
    let source = ''

    const tryZwift = async () => {
      for (const path of zwiftByDate.get(w.date) ?? []) {
        buf = await readFile(path)
        source = `zwift:${path.split('/').pop()}`
        return true
      }
      return false
    }
    const tryWahoo = async () => {
      if (!wahooToken) return false
      for (const ride of wahooByDate.get(w.date) ?? []) {
        const fit = await downloadWahooFit(wahooToken, ride.id)
        if (fit) {
          buf = fit
          source = `wahoo:${ride.id}`
          return true
        }
      }
      return false
    }

    try {
      if (w.ride_type === 'trainer') {
        await tryZwift()
      } else if (w.ride_type === 'outdoor') {
        await tryWahoo()
      } else {
        (await tryZwift()) || (await tryWahoo())
      }
    } catch (err) {
      skipped.push({ date: w.date, name: w.name, reason: `fetch failed: ${(err as Error).message}` })
      continue
    }

    if (!buf) {
      skipped.push({ date: w.date, name: w.name, reason: `no FIT file found (${w.ride_type ?? 'unknown type'})` })
      continue
    }

    let metrics
    try {
      metrics = await parseFitFile(buf, ftp)
    } catch (err) {
      skipped.push({ date: w.date, name: w.name, reason: `parse failed (${source}): ${(err as Error).message}` })
      continue
    }

    if (!DRY_RUN) {
      if (w.has_fit_data) {
        // Merge the zone keys; leave the confirmed avg/NP/HR values alone.
        await pool.query(
          `UPDATE workouts SET fit_data = fit_data || jsonb_build_object('zoneBuckets', $1::jsonb, 'zoneFtp', $2::int) WHERE id = $3`,
          [JSON.stringify(metrics.zoneBuckets), ftp, w.id],
        )
      } else {
        // No blob yet — write the whole WorkoutFitData shape so the Summary
        // tab's avg/max table has its fields too, not just the zone keys.
        const fitData = {
          avgPower: metrics.avgPower,
          maxPower: metrics.maxPower,
          normalizedPower: metrics.normalizedPower,
          intensityFactor: metrics.intensityFactor,
          avgHr: metrics.avgHr,
          maxHr: metrics.maxHr,
          avgCadence: metrics.avgCadence,
          maxCadence: metrics.maxCadence,
          zoneBuckets: metrics.zoneBuckets,
          zoneFtp: ftp,
        }
        await pool.query(`UPDATE workouts SET fit_data = $1::jsonb WHERE id = $2`, [JSON.stringify(fitData), w.id])
      }
    }

    const mins = metrics.zoneBuckets.map((s) => Math.round(s / 60))
    const tag = `${DRY_RUN ? 'would ' : ''}${w.has_fit_data ? 'merge zones' : 'write full blob'}`
    console.log(`  ${DRY_RUN ? '·' : '✓'} ${w.date}  ${w.name.slice(0, 32).padEnd(32)}  ${source.padEnd(24)}  @${String(ftp).padEnd(4)}  ${tag.padEnd(20)}  Z1-6 min: [${mins.join(', ')}]`)
    updated += 1
  }

  console.log(`\n${DRY_RUN ? '[dry run] would update' : 'Updated'} ${updated} of ${todo.length} workout(s).`)
  if (skipped.length > 0) {
    console.log(`\nSkipped ${skipped.length}:`)
    for (const s of skipped) console.log(`  ${s.date}  ${s.name.slice(0, 34).padEnd(34)}  ${s.reason}`)
  }

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
