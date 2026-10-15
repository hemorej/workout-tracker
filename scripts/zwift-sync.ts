/**
 * Local Zwift-folder sync daemon: watches your Zwift Workouts folder and
 * mirrors every .zwo change to the Sprocket server (POST /api/zwift/sync).
 *
 * The local folder is the source of truth — this is strictly one-way
 * (disk → server). Edits made in the web UI come back to disk by you
 * downloading the .zwo and saving it into the folder, which this daemon then
 * picks up like any other change.
 *
 * Usage:
 *   pnpm zwift-sync            # run forever (watch + periodic reconcile)
 *   pnpm zwift-sync --once     # one reconcile, then exit
 *   pnpm zwift-sync --dry-run  # log what would be sent; send nothing
 *   pnpm zwift-sync --force-deletes   # allow a reconcile to delete a large share of the mirror
 *
 * Config (environment):
 *   SPROCKET_URL         — e.g. https://sprocket.jerome-arfouche.ca (required)
 *   ZWIFT_SYNC_TOKEN     — must equal the server's NUXT_ZWIFT_SYNC_TOKEN (required)
 *   ZWIFT_WORKOUTS_DIR   — default ~/Documents/Zwift/Workouts
 *   RECONCILE_MINUTES    — periodic full-reconcile interval, default 10
 *
 * Why a periodic reconcile on top of fs.watch: file events are lossy (editor
 * atomic-save renames, the machine sleeping, the daemon being down). Every
 * reconcile diffs the whole folder against the server's manifest, so the
 * mirror always converges.
 *
 * Safety: a reconcile refuses to send deletes when the local scan is empty
 * (unmounted/mistyped folder) or would remove more than half of the mirror.
 * Server-side deletes are soft anyway, and everything re-syncs from disk.
 *
 * Run it at login via launchd — see infra/zwift-sync.plist.example.
 *
 * Intentionally plain console.log: human-run tooling, not app observability
 * (same convention as the other scripts/).
 */

import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { normalizeZwoPath, ZWO_LIMITS } from '../shared/utils/zwo.ts'

// ── Config ───────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2))
const ONCE = args.has('--once')
const DRY_RUN = args.has('--dry-run')
const FORCE_DELETES = args.has('--force-deletes')

const ROOT = process.env.ZWIFT_WORKOUTS_DIR ?? join(homedir(), 'Documents/Zwift/Workouts')
const SERVER = (process.env.SPROCKET_URL ?? '').replace(/\/+$/, '')
const TOKEN = process.env.ZWIFT_SYNC_TOKEN ?? ''
const RECONCILE_MS = Math.max(1, Number(process.env.RECONCILE_MINUTES ?? 10)) * 60_000

const DEBOUNCE_MS = 500
const MAX_FILES_PER_BATCH = 100 // server cap
const MAX_DELETES_PER_BATCH = 200 // server cap
// Server caps the body at 1,000,000 bytes; leave headroom for JSON overhead.
const MAX_BATCH_BYTES = 900_000
const RETRY_DELAYS_MS = [1_000, 4_000, 16_000]

if (!SERVER || !TOKEN) {
  console.error('SPROCKET_URL and ZWIFT_SYNC_TOKEN must be set.')
  process.exit(1)
}

function log(msg: string) {
  console.log(`${new Date().toISOString()} ${msg}`)
}

// ── Local scan ───────────────────────────────────────────────────────────

interface LocalFile {
  path: string
  xml: string
  hash: string
  mtime: string
}

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/** Relative, '/'-separated, or null if it isn't a syncable .zwo (dotfile, wrong ext, invalid). */
function toSyncPath(absOrRel: string): string | null {
  const rel = absOrRel.startsWith(ROOT) ? absOrRel.slice(ROOT.length).replace(/^[\\/]+/, '') : absOrRel
  const parts = rel.split(sep)
  if (parts.some(p => p.startsWith('.'))) return null // .DS_Store, editor temp files…
  return normalizeZwoPath(parts.join('/'))
}

async function readLocalFile(path: string): Promise<LocalFile | null> {
  const abs = join(ROOT, ...path.split('/'))
  try {
    const [xml, st] = await Promise.all([readFile(abs, 'utf-8'), stat(abs)])
    if (xml.length > ZWO_LIMITS.maxXmlLength) {
      log(`skip ${path}: larger than ${ZWO_LIMITS.maxXmlLength} chars`)
      return null
    }
    return { path, xml, hash: sha256Hex(xml), mtime: st.mtime.toISOString() }
  }
  catch {
    return null
  }
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, out)
    else if (entry.isFile()) {
      const p = toSyncPath(full)
      if (p) out.push(p)
    }
  }
}

async function scanLocal(): Promise<Map<string, LocalFile>> {
  const paths: string[] = []
  await walk(ROOT, paths)
  const files = new Map<string, LocalFile>()
  for (const p of paths) {
    const f = await readLocalFile(p)
    if (f) files.set(p, f)
  }
  return files
}

// ── Server API ───────────────────────────────────────────────────────────

class AuthError extends Error {}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(`${SERVER}${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 401) throw new AuthError('server rejected the token (401) — check ZWIFT_SYNC_TOKEN')
      // Other 4xx are our bug / config, not transient — don't retry.
      if (res.status >= 400 && res.status < 500) throw new Error(`${method} ${path} → ${res.status} ${await res.text().catch(() => '')}`)
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`)
      return await res.json() as T
    }
    catch (err) {
      lastError = err
      const permanent = err instanceof AuthError || (err instanceof Error && /→ 4\d\d/.test(err.message))
      if (permanent || attempt === RETRY_DELAYS_MS.length) break
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]))
    }
  }
  throw lastError
}

interface SyncResponse {
  upserted: number
  unchanged: number
  restored: number
  deleted: number
  draftsCleared: number
  rejected: Array<{ path: string, reason: string }>
}

/** Last content hash the server is known to hold per path (skips no-op events). */
const serverHashes = new Map<string, string>()

async function push(files: LocalFile[], deletes: string[]): Promise<void> {
  if (DRY_RUN) {
    log(`[dry-run] would send ${files.length} file(s), ${deletes.length} delete(s)`)
    for (const f of files) log(`[dry-run]   upsert ${f.path}`)
    for (const d of deletes) log(`[dry-run]   delete ${d}`)
    return
  }

  // Greedy batching by count and serialized size.
  let batch: LocalFile[] = []
  let bytes = 0
  const flush = async () => {
    if (batch.length === 0) return
    const res = await api<SyncResponse>('POST', '/api/zwift/sync', {
      files: batch.map(f => ({ path: f.path, xml: f.xml, mtime: f.mtime })),
    })
    const rejected = new Set(res.rejected.map(r => r.path))
    for (const f of batch) if (!rejected.has(f.path)) serverHashes.set(f.path, f.hash)
    for (const r of res.rejected) log(`server rejected ${r.path}: ${r.reason}`)
    log(`synced ${batch.length} file(s): ${res.upserted} updated, ${res.unchanged} unchanged, ${res.restored} restored${res.draftsCleared ? `, ${res.draftsCleared} draft(s) cleared` : ''}`)
    batch = []
    bytes = 0
  }
  for (const f of files) {
    const size = f.xml.length * 1.1 + f.path.length + 100 // JSON-escape headroom
    if (batch.length >= MAX_FILES_PER_BATCH || bytes + size > MAX_BATCH_BYTES) await flush()
    batch.push(f)
    bytes += size
  }
  await flush()

  for (let i = 0; i < deletes.length; i += MAX_DELETES_PER_BATCH) {
    const chunk = deletes.slice(i, i + MAX_DELETES_PER_BATCH)
    const res = await api<SyncResponse>('POST', '/api/zwift/sync', { deletes: chunk })
    for (const d of chunk) serverHashes.delete(d)
    log(`deleted ${res.deleted} file(s) on server`)
  }
}

// ── Reconcile ────────────────────────────────────────────────────────────

async function reconcile(reason: string): Promise<void> {
  log(`reconcile (${reason})…`)
  const local = await scanLocal()
  const manifest = await api<{ files: Array<{ path: string, contentHash: string }> }>('GET', '/api/zwift/sync/manifest')

  const server = new Map(manifest.files.map(f => [f.path, f.contentHash]))
  serverHashes.clear()
  for (const [p, h] of server) serverHashes.set(p, h)

  const upserts = [...local.values()].filter(f => server.get(f.path) !== f.hash)
  let deletes = [...server.keys()].filter(p => !local.has(p))

  let refusedDeletes = 0
  if (deletes.length > 0 && !FORCE_DELETES) {
    const emptyScan = local.size === 0
    const tooMany = deletes.length > Math.max(5, server.size / 2)
    if (emptyScan || tooMany) {
      log(`REFUSING ${deletes.length} delete(s): ${emptyScan ? 'local scan found no .zwo files' : 'would remove more than half the mirror'} `
        + `(folder: ${ROOT}). Check the folder is mounted/correct, or re-run with --force-deletes.`)
      refusedDeletes = deletes.length
      deletes = []
    }
  }

  if (upserts.length === 0 && deletes.length === 0) {
    log(refusedDeletes ? 'nothing sent' : `in sync (${local.size} file(s))`)
    return
  }
  await push(upserts, deletes)
}

// ── Watch ────────────────────────────────────────────────────────────────

let queue: Promise<void> = Promise.resolve()
/** Serializes all work so a reconcile and file events never interleave. */
function enqueue(job: () => Promise<void>): void {
  queue = queue.then(job).catch(err => log(`error: ${err instanceof Error ? err.message : String(err)}`))
}

const timers = new Map<string, NodeJS.Timeout>()

async function handlePath(path: string): Promise<void> {
  const file = await readLocalFile(path)
  if (!file) {
    // Only treat it as deleted if it is really gone (ENOENT) — a transient
    // read error mid-save must not delete the server copy. And only delete
    // what the server actually has.
    const gone = await stat(join(ROOT, ...path.split('/'))).then(() => false, (e: NodeJS.ErrnoException) => e.code === 'ENOENT')
    if (gone && serverHashes.has(path)) await push([], [path])
    return
  }
  if (serverHashes.get(path) === file.hash) return
  await push([file], [])
}

function onFsEvent(filename: string | null) {
  if (!filename) return
  const path = toSyncPath(filename)
  if (!path) return
  clearTimeout(timers.get(path))
  timers.set(path, setTimeout(() => {
    timers.delete(path)
    enqueue(() => handlePath(path))
  }, DEBOUNCE_MS))
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  try {
    await readdir(ROOT)
  }
  catch {
    console.error(`Cannot read ${ROOT} — set ZWIFT_WORKOUTS_DIR.`)
    process.exit(1)
  }

  log(`watching ${ROOT} → ${SERVER}${DRY_RUN ? ' [dry-run]' : ''}`)

  if (ONCE) {
    await reconcile('--once')
    return
  }

  // Start watching before the first reconcile so changes made during it aren't missed.
  const watcher: FSWatcher = watch(ROOT, { recursive: true }, (_event, filename) => onFsEvent(filename))
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
