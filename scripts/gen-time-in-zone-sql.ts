/**
 * One-off: generate a SQL file that backfills `fit_data.zoneBuckets` /
 * `fit_data.zoneFtp` for the OUTDOOR 2026 workouts the normal backfill script
 * (scripts/backfill-time-in-zone.ts) can't reach, because production's own
 * Wahoo app registration is wedged (token cap / invalid_grant).
 *
 * Runs entirely offline against the DB — no prod connection. It fetches + parses
 * the FIT files with a Wahoo ACCESS token you pass in `WAHOO_ACCESS_TOKEN`
 * (mint it from the *local* Wahoo app — same Wahoo account, same rides), and
 * writes date-matched UPDATE statements to a .sql file you import into prod.
 *
 * The dates to backfill and the FTP markers are baked in below (taken from the
 * prod backfill run's own output) — override with the DATES / FTP_MARKERS env
 * vars if the set changes. FTP per ride is carry-forward from the markers, same
 * as getFtpAsOf / makeFtpForDate.
 *
 * Each generated statement matches by (user email + date + ride_type <>
 * 'trainer') — safe because the athlete logs at most one ride per day — and
 * uses a CASE that mirrors the backfill exactly: where `fit_data` already
 * exists, merge ONLY the two zone keys (leave avg/NP/HR alone); where it
 * doesn't, write the whole WorkoutFitData blob.
 *
 * Mint a local access token:
 *   pnpm dlx dotenv-cli -e .env -- node -e '(async()=>{const{Pool}=require("pg");\
 *     const p=new Pool({connectionString:process.env.DATABASE_URL});\
 *     const{rows}=await p.query("SELECT refresh_token FROM wahoo_tokens WHERE id=1");\
 *     const r=await fetch("https://api.wahooligan.com/oauth/token",{method:"POST",\
 *       headers:{"Content-Type":"application/json"},body:JSON.stringify({\
 *       client_id:process.env.WAHOO_CLIENT_ID,client_secret:process.env.WAHOO_CLIENT_SECRET,\
 *       refresh_token:rows[0].refresh_token,grant_type:"refresh_token"})});\
 *     const d=await r.json();\
 *     if(d.refresh_token)await p.query("UPDATE wahoo_tokens SET refresh_token=$1,updated_at=now() WHERE id=1",[d.refresh_token]);\
 *     console.log(d.access_token);await p.end()})()'
 *
 * Then:
 *   WAHOO_ACCESS_TOKEN=<token> pnpm dlx dotenv-cli -e .env -- \
 *     pnpm exec tsx scripts/gen-time-in-zone-sql.ts
 *
 * Output: scripts/out/time-in-zone-prod.sql — review it, then on prod:
 *   psql "$PROD_DATABASE_URL" -f scripts/out/time-in-zone-prod.sql
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFitFile } from '../server/utils/fit.ts'

const EMAIL = 'jerome.arfouche@pm.me'
const YEAR_START = '2026-01-01'
const YEAR_END = '2026-12-31'
const DEFAULT_FTP = 230

const ACCESS_TOKEN = process.env.WAHOO_ACCESS_TOKEN
const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'out', 'time-in-zone-prod.sql')

/** Outdoor 2026 workouts still missing zoneBuckets/zoneFtp on prod (from the backfill run's skip list). */
const DEFAULT_DATES = [
  '2026-04-26', '2026-05-03', '2026-05-10', '2026-05-17', '2026-05-22',
  '2026-05-31', '2026-06-04', '2026-06-13', '2026-06-24', '2026-07-04',
  '2026-07-08', '2026-07-12', '2026-07-15', '2026-07-20', '2026-07-25',
  '2026-08-14', '2026-08-22',
]

/** ftp_watts markers (carry-forward; earliest carried back). From the prod backfill run's output. */
const DEFAULT_FTP_MARKERS = [
  { date: '2026-05-15', ftp: 240 },
  { date: '2026-07-31', ftp: 230 },
]

const DATES = (process.env.DATES?.split(',').map((s) => s.trim()).filter(Boolean)) ?? DEFAULT_DATES
const FTP_MARKERS = process.env.FTP_MARKERS
  ? process.env.FTP_MARKERS.split(',').map((pair) => {
      const [date, ftp] = pair.split(':')
      return { date: date!.trim(), ftp: Number(ftp) }
    })
  : DEFAULT_FTP_MARKERS

if (!ACCESS_TOKEN) {
  console.error('Error: WAHOO_ACCESS_TOKEN is not set (mint one from the local Wahoo app — see header).')
  process.exit(1)
}

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function wahooGet(url: string | URL, attempt = 1): Promise<Response> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } })
  if ((res.status === 429 || res.status >= 500) && attempt <= 6) {
    const wait = Number(res.headers.get('retry-after')) * 1000 || Math.min(attempt * 30_000, 120_000)
    console.log(`    Wahoo ${res.status} — retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}/6)`)
    await sleep(wait)
    return wahooGet(url, attempt + 1)
  }
  return res
}

/** Pages the Wahoo workout list (newest first) until entries predate 2026, indexing biking rides by local start date. */
async function buildWahooRidesByDate(): Promise<Map<string, WahooWorkout[]>> {
  const byDate = new Map<string, WahooWorkout[]>()
  const perPage = 30
  for (let page = 1; page <= 60; page++) {
    const url = new URL('https://api.wahooligan.com/v1/workouts')
    url.searchParams.set('page', String(page))
    url.searchParams.set('per_page', String(perPage))
    const res = await wahooGet(url)
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

async function downloadWahooFit(workoutId: number): Promise<Buffer | null> {
  const res = await wahooGet(`https://api.wahooligan.com/v1/workouts/${workoutId}`)
  if (!res.ok) throw new Error(`Wahoo workout ${workoutId} fetch failed: ${res.status}`)
  const detail = await res.json() as WahooWorkout
  const fileUrl = detail.workout_summary?.file?.url
  if (!fileUrl) return null
  const fileRes = await fetch(fileUrl)
  if (!fileRes.ok) throw new Error(`FIT download failed for ${workoutId}: ${fileRes.status}`)
  await sleep(400)
  return Buffer.from(await fileRes.arrayBuffer())
}

/** Carry-forward FTP — see makeFtpForDate in backfill-time-in-zone.ts / getFtpAsOf. */
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

/** Postgres dollar-quote — tag can't collide, content is JSON (no `$`). */
function dollar(s: string): string {
  return `$zib$${s}$zib$`
}

function updateStatement(date: string, ftp: number, zoneBuckets: number[], fullBlob: object, wahooId: number): string {
  const zonly = dollar(JSON.stringify({ zoneBuckets, zoneFtp: ftp }))
  const full = dollar(JSON.stringify(fullBlob))
  return [
    `-- ${date}  (wahoo:${wahooId})  @${ftp}w`,
    `UPDATE workouts SET fit_data = CASE`,
    `    WHEN fit_data IS NULL THEN ${full}::jsonb`,
    `    ELSE fit_data || ${zonly}::jsonb`,
    `  END`,
    `WHERE user_id = (SELECT id FROM users WHERE email = ${dollar(EMAIL)})`,
    `  AND date = '${date}'`,
    `  AND COALESCE(ride_type, 'outdoor') <> 'trainer';`,
  ].join('\n')
}

async function main() {
  const ftpForDate = makeFtpForDate(FTP_MARKERS)
  console.log(`Dates: ${DATES.length}   FTP markers: ${FTP_MARKERS.map((m) => `${m.date}→${m.ftp}w`).join(', ')}`)

  console.log('Indexing Wahoo rides…')
  const wahooByDate = await buildWahooRidesByDate()
  console.log(`Indexed Wahoo rides for ${wahooByDate.size} date(s) in 2026.`)

  const statements: string[] = []
  const missed: { date: string, reason: string }[] = []

  for (const date of DATES) {
    const ftp = ftpForDate(date)
    let buf: Buffer | null = null
    let wahooId: number | null = null
    try {
      for (const ride of wahooByDate.get(date) ?? []) {
        const fit = await downloadWahooFit(ride.id)
        if (fit) { buf = fit; wahooId = ride.id; break }
      }
    } catch (err) {
      missed.push({ date, reason: `fetch failed: ${(err as Error).message}` })
      continue
    }
    if (!buf || wahooId == null) {
      missed.push({ date, reason: 'no Wahoo FIT file for that date' })
      continue
    }

    let metrics
    try {
      metrics = await parseFitFile(buf, ftp)
    } catch (err) {
      missed.push({ date, reason: `parse failed: ${(err as Error).message}` })
      continue
    }

    const fullBlob = {
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
    statements.push(updateStatement(date, ftp, metrics.zoneBuckets, fullBlob, wahooId))
    const mins = metrics.zoneBuckets.map((s) => Math.round(s / 60))
    console.log(`  ✓ ${date}  wahoo:${String(wahooId).padEnd(10)}  @${ftp}w  Z1-6 min [${mins.join(', ')}]`)
  }

  const sql = [
    `-- time-in-zone backfill for production — generated ${new Date().toISOString()}`,
    `-- ${statements.length} outdoor workout(s); FIT files fetched via the local Wahoo app.`,
    `-- Matches by user email + date + ride_type <> 'trainer' (one ride per day).`,
    `-- Review, then:  psql "$PROD_DATABASE_URL" -f scripts/out/time-in-zone-prod.sql`,
    '',
    'BEGIN;',
    '',
    statements.join('\n\n'),
    '',
    '',
    'COMMIT;',
    '',
  ].join('\n')

  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, sql, 'utf8')

  console.log(`\nWrote ${statements.length} UPDATE(s) to ${OUT_PATH}`)
  if (missed.length > 0) {
    console.log(`\nCouldn't match ${missed.length}:`)
    for (const m of missed) console.log(`  ${m.date}  ${m.reason}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
