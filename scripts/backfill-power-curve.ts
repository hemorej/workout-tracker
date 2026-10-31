/**
 * One-off backfill: populate `power_curve` (the full 14-duration power curve
 * per ride) for existing 2026 workouts, then recompute each of those rides'
 * PR rows (`power_bests`) under the current rule — a duration is a PR only if
 * it is strictly higher than the max for that duration over the 8 weeks before
 * the ride (shared/utils/powerBestRules.ts, the same code the app uses).
 *
 * FIT files come from LOCAL directories only (no Wahoo API calls, so no
 * refresh-token rotation). Default dirs:
 *   - .data/fit-files                      (webhook / Zwift-daemon storage: <id>-<date>.fit, zwift-<hash>-<date>.fit)
 *   - ~/Documents/Zwift/Activities         (YYYY-MM-DD-HH-MM-SS.fit)
 * Override with FIT_DIRS=/a,/b. A file is matched to a workout by the
 * YYYY-MM-DD in its name (the ride's local day); if several share a day the
 * largest wins. Workouts with no matching file are left completely untouched.
 *
 * Only workouts dated 2026-01-01 .. 2026-12-31 are considered. Idempotent:
 * re-running replaces the same rows. Rides early in the year are judged
 * against whatever earlier data exists (legacy power_bests / wahoo_power_bests
 * rows) — with no 2025 curves, January PRs will be generous.
 *
 * Usage:
 *   DRY_RUN=1 pnpm dlx dotenv-cli -e .env -- pnpm exec tsx scripts/backfill-power-curve.ts   # preview, no writes
 *   pnpm dlx dotenv-cli -e .env -- pnpm exec tsx scripts/backfill-power-curve.ts
 *   FIT_DIRS=/path/one,/path/two pnpm dlx dotenv-cli -e .env -- pnpm exec tsx scripts/backfill-power-curve.ts
 *
 * Run `pnpm db:migrate` first (creates the power_curve table).
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { parseFitFile } from '../server/utils/fit.ts'
import { findNewBestEfforts, type DatedPowerEffort, type PowerEffort } from '../shared/utils/powerBestRules.ts'

const EMAIL = 'jerome.arfouche@pm.me'
const YEAR_START = '2026-01-01'
const YEAR_END = '2026-12-31'
/** Power-curve bests don't depend on FTP (only TSS/zones do), so any value works for parsing. */
const PARSE_FTP = 230
const DRY_RUN = process.env.DRY_RUN === '1'
const FIT_DIRS = (process.env.FIT_DIRS
  ? process.env.FIT_DIRS.split(',').map((d) => d.trim()).filter(Boolean)
  : ['.data/fit-files', join(homedir(), 'Documents/Zwift/Activities')])

if (!process.env.DATABASE_URL) {
  console.error('Error: DATABASE_URL environment variable is not set.')
  process.exit(1)
}

/** date → candidate FIT paths, largest first. */
async function indexFitFiles(): Promise<Map<string, string[]>> {
  const byDate = new Map<string, { path: string, size: number }[]>()
  for (const dir of FIT_DIRS) {
    let names: string[]
    try {
      names = await readdir(dir)
    }
    catch {
      console.warn(`  (skipping unreadable dir: ${dir})`)
      continue
    }
    let n = 0
    for (const name of names) {
      // "<id>-2026-09-06.fit", "zwift-<hash>-2026-09-06.fit" or "2026-09-06-10-30-00.fit"
      const m = name.match(/(?:^|[-_])(\d{4}-\d{2}-\d{2})(?:-\d{2}-\d{2}-\d{2})?\.fit$/i)
      if (!m) continue
      const path = join(dir, name)
      const { size } = await stat(path)
      const list = byDate.get(m[1]!) ?? []
      list.push({ path, size })
      byDate.set(m[1]!, list)
      n++
    }
    console.log(`  ${dir}: ${n} FIT file(s)`)
  }
  return new Map([...byDate].map(([d, l]) => [d, l.sort((a, b) => b.size - a.size).map((f) => f.path)]))
}

interface PoolRow extends DatedPowerEffort {
  /** Set for power_curve / power_bests rows; null for legacy wahoo_power_bests. */
  workoutId: number | null
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

  const { rows: workouts } = await pool.query<{ id: number, date: string, name: string }>(
    `SELECT id, date::text AS date, name FROM workouts
     WHERE user_id = $1 AND date >= $2 AND date <= $3 ORDER BY date ASC`,
    [userId, YEAR_START, YEAR_END],
  )
  console.log(`${workouts.length} workout(s) in 2026. Indexing FIT files:`)
  const filesByDate = await indexFitFiles()

  // ── Pass 1: parse a curve for every workout we can find a file for ─────
  const curves = new Map<number, PowerEffort[]>()
  const skipped: string[] = []
  for (const w of workouts) {
    const paths = filesByDate.get(w.date)
    if (!paths?.length) {
      skipped.push(`${w.date}  ${w.name.slice(0, 34).padEnd(34)}  no FIT file found`)
      continue
    }
    try {
      const metrics = await parseFitFile(await readFile(paths[0]!), PARSE_FTP)
      const curve = Object.entries(metrics.bests).map(([duration, watts]) => ({ duration, watts: watts! }))
      if (curve.length === 0) throw new Error('no power data')
      curves.set(w.id, curve)
    }
    catch (err) {
      skipped.push(`${w.date}  ${w.name.slice(0, 34).padEnd(34)}  parse failed: ${(err as Error).message}`)
    }
  }
  console.log(`Parsed ${curves.size} of ${workouts.length} workout(s).`)

  // ── Pass 2: baseline pool = everything the app would see, with processed
  // workouts' old curve rows replaced by the freshly parsed ones. ──────────
  const [curveRows, prRows, legacyRows] = await Promise.all([
    pool.query<{ workout_id: number, duration: string, watts: number, date: string }>(
      `SELECT pc.workout_id, pc.duration, pc.watts, w.date::text AS date
       FROM power_curve pc JOIN workouts w ON w.id = pc.workout_id WHERE w.user_id = $1`, [userId]),
    pool.query<{ workout_id: number, duration: string, watts: number, date: string }>(
      `SELECT pb.workout_id, pb.duration, pb.watts, w.date::text AS date
       FROM power_bests pb JOIN workouts w ON w.id = pb.workout_id WHERE w.user_id = $1`, [userId]),
    pool.query<{ duration: string, watts: number, date: string }>(
      `SELECT duration, watts, achieved_at::text AS date FROM wahoo_power_bests`),
  ])
  const datesById = new Map(workouts.map((w) => [w.id, w.date]))
  const oldPrs = new Map<number, Map<string, number>>()
  for (const r of prRows.rows) {
    const m = oldPrs.get(r.workout_id) ?? new Map<string, number>()
    m.set(r.duration, r.watts)
    oldPrs.set(r.workout_id, m)
  }

  const basePool: PoolRow[] = [
    ...curveRows.rows.filter((r) => !curves.has(r.workout_id)).map((r) => ({ workoutId: r.workout_id, duration: r.duration, watts: r.watts, date: r.date })),
    ...prRows.rows.map((r) => ({ workoutId: r.workout_id, duration: r.duration, watts: r.watts, date: r.date })),
    ...legacyRows.rows.map((r) => ({ workoutId: null, duration: r.duration, watts: r.watts, date: r.date })),
  ]
  for (const [id, curve] of curves) {
    for (const pt of curve) basePool.push({ workoutId: id, duration: pt.duration, watts: pt.watts, date: datesById.get(id)! })
  }

  const newPrs = new Map<number, PowerEffort[]>()
  let prsAdded = 0
  let prsRemoved = 0
  for (const w of workouts) {
    const curve = curves.get(w.id)
    if (!curve) continue
    // Other workouts' rows, plus legacy rows not dated the same day (same-ride rows).
    const existing = basePool.filter((r) => (r.workoutId !== null ? r.workoutId !== w.id : r.date !== w.date))
    const prs = findNewBestEfforts(existing, w.date, curve)
    newPrs.set(w.id, prs)

    const before = oldPrs.get(w.id) ?? new Map<string, number>()
    const after = new Map(prs.map((p) => [p.duration, p.watts]))
    const added = [...after].filter(([d, v]) => before.get(d) !== v).map(([d]) => d)
    const removed = [...before.keys()].filter((d) => !after.has(d))
    prsAdded += added.length
    prsRemoved += removed.length
    console.log(
      `  ${DRY_RUN ? '·' : '✓'} ${w.date}  ${w.name.slice(0, 30).padEnd(30)}  curve ${curve.length}  PRs ${before.size}→${after.size}`
      + (added.length ? `  +[${added.join(' ')}]` : '') + (removed.length ? `  −[${removed.join(' ')}]` : ''),
    )
  }

  // ── Write ──────────────────────────────────────────────────────────────
  if (!DRY_RUN && curves.size > 0) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const [id, curve] of curves) {
        await client.query('DELETE FROM power_curve WHERE workout_id = $1', [id])
        await client.query(
          `INSERT INTO power_curve (workout_id, duration, watts)
           SELECT $1, d, w FROM unnest($2::text[], $3::int[]) AS t(d, w)`,
          [id, curve.map((c) => c.duration), curve.map((c) => c.watts)],
        )
        const prs = newPrs.get(id) ?? []
        await client.query('DELETE FROM power_bests WHERE workout_id = $1', [id])
        if (prs.length > 0) {
          await client.query(
            `INSERT INTO power_bests (workout_id, duration, watts)
             SELECT $1, d, w FROM unnest($2::text[], $3::int[]) AS t(d, w)`,
            [id, prs.map((c) => c.duration), prs.map((c) => c.watts)],
          )
        }
      }
      await client.query('COMMIT')
    }
    catch (err) {
      await client.query('ROLLBACK')
      throw err
    }
    finally {
      client.release()
    }
  }

  console.log(`\n${DRY_RUN ? '[dry run] would write' : 'Wrote'} curves for ${curves.size} workout(s); PR rows changed: +${prsAdded} / −${prsRemoved}.`)
  if (skipped.length > 0) {
    console.log(`\nLeft untouched (${skipped.length}):`)
    for (const s of skipped) console.log(`  ${s}`)
  }
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
