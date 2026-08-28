/**
 * One-off recovery: regenerate a SQL file that restores the `workouts.laps`
 * column for 2026 rides where it was nulled (a workout re-save through the
 * PATCH endpoint writes laps = NULL whenever the request body omits `laps`).
 *
 * Runs offline — no DB connection. Resolves each ride's FIT file the same way
 * the normal backfill does (local Zwift file for indoor, Wahoo API for
 * outdoor), re-parses it, and emits one guarded UPDATE per date:
 *
 *     UPDATE workouts SET laps = '<json>'::jsonb
 *     WHERE user_id = (SELECT id FROM users WHERE email = '…')
 *       AND date = 'YYYY-MM-DD'
 *       AND laps IS NULL;
 *
 * The `laps IS NULL` guard makes it a no-op on rows that still have laps, so
 * it's safe to run against prod without knowing exactly which rows were hit.
 * Only rides whose FIT has ≥2 lap messages get a statement — same rule as the
 * app (0/1 lap is stored as NULL on purpose).
 *
 * Laps come straight from the FIT `lap` messages (computeLaps in
 * server/utils/fit.ts) and don't depend on FTP; the FTP passed to parseFitFile
 * here is irrelevant to the output.
 *
 * Mint a local Wahoo access token (see gen-time-in-zone-sql.ts header), then:
 *   WAHOO_ACCESS_TOKEN=<token> pnpm exec tsx scripts/gen-laps-restore-sql.ts
 *   ZWIFT_DIR=/path/to/Activities WAHOO_ACCESS_TOKEN=<token> pnpm exec tsx scripts/gen-laps-restore-sql.ts
 *
 * Output: scripts/out/laps-restore-prod.sql — review, then on prod:
 *   psql "$PROD_DATABASE_URL" -f scripts/out/laps-restore-prod.sql
 */

import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFitFile } from '../server/utils/fit.ts'

const EMAIL = 'jerome.arfouche@pm.me'
const YEAR_START = '2026-01-01'
const YEAR_END = '2026-12-31'
const FTP_FOR_PARSE = 240 // irrelevant to lap output; parseFitFile just requires a value

const ACCESS_TOKEN = process.env.WAHOO_ACCESS_TOKEN
const ZWIFT_DIR = process.env.ZWIFT_DIR ?? join(homedir(), 'Documents/Zwift/Activities')
const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'out', 'laps-restore-prod.sql')

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

/** date "YYYY-MM-DD" -> local `YYYY-MM-DD-*.fit` paths, largest first, 2026 only. */
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
    const date = m[1]!
    if (date < YEAR_START || date > YEAR_END) continue
    const path = join(ZWIFT_DIR, name)
    const { size } = await stat(path)
    const list = byDate.get(date) ?? []
    list.push({ path, size })
    byDate.set(date, list)
  }
  return new Map(
    [...byDate].map(([date, list]) => [date, list.sort((a, b) => b.size - a.size).map((f) => f.path)]),
  )
}

function dollar(s: string): string {
  return `$laps$${s}$laps$`
}

async function main() {
  console.log('Indexing local Zwift FIT files…')
  const zwiftByDate = await buildZwiftFilesByDate()
  console.log(`  ${zwiftByDate.size} date(s) in 2026.`)

  console.log('Indexing Wahoo rides…')
  const wahooByDate = await buildWahooRidesByDate()
  console.log(`  ${wahooByDate.size} date(s) in 2026.`)

  const dates = [...new Set([...zwiftByDate.keys(), ...wahooByDate.keys()])].sort()
  console.log(`${dates.length} distinct ride date(s) to check.\n`)

  const statements: string[] = []
  const noLaps: string[] = []
  const missed: { date: string, reason: string }[] = []

  for (const date of dates) {
    // Indoor first (Zwift file), then outdoor (Wahoo). For a Zwift-origin ride
    // the Wahoo copy has no FIT anyway, so at most one source yields a buffer.
    let buf: Buffer | null = null
    let source = ''
    try {
      for (const path of zwiftByDate.get(date) ?? []) {
        buf = await readFile(path)
        source = `zwift:${path.split('/').pop()}`
        break
      }
      if (!buf) {
        for (const ride of wahooByDate.get(date) ?? []) {
          const fit = await downloadWahooFit(ride.id)
          if (fit) { buf = fit; source = `wahoo:${ride.id}`; break }
        }
      }
    } catch (err) {
      missed.push({ date, reason: `fetch failed: ${(err as Error).message}` })
      continue
    }
    if (!buf) {
      missed.push({ date, reason: 'no FIT file (likely Zwift ride with no Wahoo FIT)' })
      continue
    }

    let metrics
    try {
      metrics = await parseFitFile(buf, FTP_FOR_PARSE)
    } catch (err) {
      missed.push({ date, reason: `parse failed (${source}): ${(err as Error).message}` })
      continue
    }

    if (metrics.laps.length < 2) {
      noLaps.push(date)
      continue
    }

    statements.push([
      `-- ${date}  (${source})  ${metrics.laps.length} laps`,
      `UPDATE workouts SET laps = ${dollar(JSON.stringify(metrics.laps))}::jsonb`,
      `WHERE user_id = (SELECT id FROM users WHERE email = ${dollar(EMAIL)})`,
      `  AND date = '${date}'`,
      `  AND laps IS NULL;`,
    ].join('\n'))
    console.log(`  ✓ ${date}  ${source.padEnd(28)}  ${metrics.laps.length} laps`)
  }

  const sql = [
    `-- laps-column restore for production — generated ${new Date().toISOString()}`,
    `-- ${statements.length} ride(s) with ≥2 laps; guarded by "laps IS NULL" so it only fills gaps.`,
    `-- Review, then:  psql "$PROD_DATABASE_URL" -f scripts/out/laps-restore-prod.sql`,
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
  console.log(`${noLaps.length} ride(s) had <2 laps (correctly left as NULL).`)
  if (missed.length > 0) {
    console.log(`\nNo FIT for ${missed.length} date(s):`)
    for (const m of missed) console.log(`  ${m.date}  ${m.reason}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
