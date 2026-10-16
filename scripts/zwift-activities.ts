/**
 * Local Zwift-activities daemon: watches your Zwift Activities folder and
 * uploads each newly finished ride's FIT file to the Sprocket server
 * (POST /api/zwift/activity), which logs it as a workout — title from the
 * same-day Strava ride, else the planned workout, else "Zwift ride".
 *
 * Usage:
 *   pnpm zwift-activities            # run forever (watch + periodic reconcile)
 *   pnpm zwift-activities --once     # one reconcile, then exit
 *   pnpm zwift-activities --dry-run  # log what would be uploaded; send nothing
 *
 * Config (environment):
 *   SPROCKET_URL            — e.g. https://sprocket.jerome-arfouche.ca (required)
 *   ZWIFT_ACTIVITY_TOKEN    — must equal the server's NUXT_ZWIFT_ACTIVITY_TOKEN (required)
 *   ZWIFT_ACTIVITIES_DIR    — default ~/Documents/Zwift/Activities
 *   ZWIFT_ACTIVITIES_STATE  — default ~/.sprocket-zwift-activities.json
 *   BACKFILL_DAYS           — first run only: upload rides from the last N days
 *                             (default 2); older existing files are marked seen
 *   RECONCILE_MINUTES       — periodic full-scan interval, default 10
 *
 * Only files named like Zwift's own `YYYY-MM-DD-HH-MM-SS.fit` are considered
 * (this skips `inProgressActivity.fit`). That name is LOCAL time and is where
 * the ride's calendar day comes from — the FIT has UTC timestamps only.
 *
 * A file is uploaded once: the state file records what was sent (by content
 * hash) so restarts and periodic reconciles are no-ops. The server is
 * idempotent too, so a lost state file just re-sends recent rides harmlessly.
 *
 * Intentionally plain console.log, like the other scripts/.
 * Run it at login via launchd — see infra/zwift-activities.plist.example.
 */

import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── Config ───────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2))
const ONCE = args.has('--once')
const DRY_RUN = args.has('--dry-run')

const ROOT = process.env.ZWIFT_ACTIVITIES_DIR ?? join(homedir(), 'Documents/Zwift/Activities')
const STATE_PATH = process.env.ZWIFT_ACTIVITIES_STATE ?? join(homedir(), '.sprocket-zwift-activities.json')
const SERVER = (process.env.SPROCKET_URL ?? '').replace(/\/+$/, '')
const TOKEN = process.env.ZWIFT_ACTIVITY_TOKEN ?? ''
const BACKFILL_DAYS = Math.max(0, Number(process.env.BACKFILL_DAYS ?? 2))
const RECONCILE_MS = Math.max(1, Number(process.env.RECONCILE_MINUTES ?? 10)) * 60_000

const SETTLE_MS = 5_000 // wait after the last fs event before touching a file
const STABLE_CHECK_MS = 3_000 // size must not change across this gap
const MAX_BYTES = 8_000_000 // server cap
// The server may spend up to ~40 s waiting for Strava to receive the ride.
const REQUEST_TIMEOUT_MS = 120_000
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000]
const NAME_RE = /^(\d{4}-\d{2}-\d{2})-\d{2}-\d{2}-\d{2}\.fit$/

if (!SERVER || !TOKEN) {
  console.error('SPROCKET_URL and ZWIFT_ACTIVITY_TOKEN must be set.')
  process.exit(1)
}

function log(msg: string) {
  console.log(`${new Date().toISOString()} ${msg}`)
}

// ── State ────────────────────────────────────────────────────────────────

interface State {
  /** filename → { sha256 of what was handled, outcome } */
  files: Record<string, { hash: string, outcome: 'uploaded' | 'rejected' | 'baseline' }>
}

let state: State = { files: {} }
let firstRun = false

async function loadState(): Promise<void> {
  try {
    state = JSON.parse(await readFile(STATE_PATH, 'utf-8')) as State
  }
  catch {
    firstRun = true
  }
}

async function saveState(): Promise<void> {
  const tmp = `${STATE_PATH}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  await rename(tmp, STATE_PATH)
}

// ── Upload ───────────────────────────────────────────────────────────────

class AuthError extends Error {}
class RejectedError extends Error {}

interface ActivityResponse {
  ok: boolean
  workoutId: number
  created: boolean
  name: string
  nameSource: 'strava' | 'planned' | 'fallback'
  tss: number
}

async function upload(buf: Buffer, rideDate: string): Promise<ActivityResponse> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(`${SERVER}/api/zwift/activity`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'Content-Type': 'application/octet-stream',
          'X-Ride-Date': rideDate,
        },
        body: new Uint8Array(buf),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (res.status === 401) throw new AuthError('server rejected the token (401) — check ZWIFT_ACTIVITY_TOKEN')
      if (res.status === 422 || res.status === 413) {
        throw new RejectedError(`${res.status} ${await res.text().catch(() => '')}`)
      }
      // Other 4xx are config/bug, not transient — don't retry.
      if (res.status >= 400 && res.status < 500) throw new AuthError(`→ ${res.status} ${await res.text().catch(() => '')}`)
      if (!res.ok) throw new Error(`→ ${res.status}`)
      return await res.json() as ActivityResponse
    }
    catch (err) {
      lastError = err
      if (err instanceof AuthError || err instanceof RejectedError || attempt === RETRY_DELAYS_MS.length) break
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]))
    }
  }
  throw lastError
}

// ── Processing ───────────────────────────────────────────────────────────

const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** Reads the file once its size has stopped changing; null if it vanished or never settles. */
async function readSettled(abs: string): Promise<Buffer | null> {
  try {
    const first = (await stat(abs)).size
    await new Promise(r => setTimeout(r, STABLE_CHECK_MS))
    const second = (await stat(abs)).size
    if (first !== second || second === 0) return null
    return await readFile(abs)
  }
  catch {
    return null
  }
}

async function handleFile(name: string): Promise<void> {
  const m = NAME_RE.exec(name)
  if (!m) return
  const rideDate = m[1]!
  const abs = join(ROOT, name)

  const buf = await readSettled(abs)
  if (!buf) {
    log(`${name}: not readable/settled yet — will retry on the next scan`)
    return
  }
  if (buf.length > MAX_BYTES) {
    log(`${name}: ${buf.length} bytes exceeds the ${MAX_BYTES} cap — skipped`)
    return
  }
  const hash = sha256Hex(buf)
  if (state.files[name]?.hash === hash) return

  if (DRY_RUN) {
    log(`[dry-run] would upload ${name} (${buf.length} bytes, ride date ${rideDate})`)
    return
  }

  try {
    const res = await upload(buf, rideDate)
    state.files[name] = { hash, outcome: 'uploaded' }
    await saveState()
    log(`${name}: ${res.created ? 'created' : 'updated'} workout #${res.workoutId} "${res.name}" (${res.nameSource}), TSS ${res.tss}`)
  }
  catch (err) {
    if (err instanceof RejectedError) {
      // Unparseable / no power data — retrying the same bytes can't help.
      state.files[name] = { hash, outcome: 'rejected' }
      await saveState()
      log(`${name}: server rejected the file (${err.message}) — won't retry`)
      return
    }
    throw err
  }
}

/** Day-granular age check using the local date in the filename. */
function withinBackfill(name: string): boolean {
  const m = NAME_RE.exec(name)
  if (!m) return false
  const ageDays = (Date.now() - new Date(`${m[1]}T00:00:00`).getTime()) / 86_400_000
  return ageDays <= BACKFILL_DAYS + 1
}

async function reconcile(reason: string): Promise<void> {
  log(`reconcile (${reason})…`)
  const names = (await readdir(ROOT)).filter(n => NAME_RE.test(n)).sort()

  if (firstRun) {
    // Hundreds of historical files live here already; only the recent ones
    // are uploaded, the rest are recorded as seen so they never are.
    let baselined = 0
    for (const n of names) {
      if (!withinBackfill(n) && !state.files[n]) {
        state.files[n] = { hash: '', outcome: 'baseline' }
        baselined++
      }
    }
    firstRun = false
    if (!DRY_RUN) await saveState()
    log(`first run: marked ${baselined} older file(s) as seen, considering the last ${BACKFILL_DAYS} day(s)`)
  }

  // Anything with no state entry: new, or a previous attempt failed transiently.
  const pending = names.filter(n => !state.files[n])
  if (pending.length === 0) {
    log('nothing new')
    return
  }
  for (const n of pending) await handleFile(n)
}

// ── Watch ────────────────────────────────────────────────────────────────

let queue: Promise<void> = Promise.resolve()
function enqueue(job: () => Promise<void>): void {
  queue = queue.then(job).catch((err) => {
    log(`error: ${err instanceof Error ? err.message : String(err)}`)
    if (err instanceof AuthError) log('check the token / server config — files stay pending and retry on the next scan')
  })
}

const timers = new Map<string, NodeJS.Timeout>()

function onFsEvent(filename: string | null) {
  if (!filename || !NAME_RE.test(filename)) return
  clearTimeout(timers.get(filename))
  timers.set(filename, setTimeout(() => {
    timers.delete(filename)
    // A re-saved file (new hash) is re-sent; an unchanged one is a no-op.
    enqueue(() => handleFile(filename))
  }, SETTLE_MS))
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  try {
    await readdir(ROOT)
  }
  catch {
    console.error(`Cannot read ${ROOT} — set ZWIFT_ACTIVITIES_DIR.`)
    process.exit(1)
  }
  await loadState()

  log(`watching ${ROOT} → ${SERVER}${DRY_RUN ? ' [dry-run]' : ''}`)

  if (ONCE) {
    await reconcile('--once')
    await queue
    return
  }

  const watcher: FSWatcher = watch(ROOT, (_event, filename) => onFsEvent(filename))
  watcher.on('error', err => log(`watcher error: ${err.message}`))

  enqueue(() => reconcile('startup'))
  const interval = setInterval(() => enqueue(() => reconcile('periodic')), RECONCILE_MS)

  const shutdown = () => {
    clearInterval(interval)
    watcher.close()
    log('stopped')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
