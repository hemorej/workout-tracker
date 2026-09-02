/**
 * Persistent storage for raw Wahoo FIT files delivered by the webhook
 * (server/api/wahoo/webhook.post.ts) — the first and only filesystem writes
 * in `server/`. Everything else that needs to survive a deploy goes to
 * Postgres; FIT files are large binary blobs kept on disk instead.
 *
 * The target directory is `runtimeConfig.fitStorageDir` (env
 * NUXT_FIT_STORAGE_DIR). In dev it defaults to `.data/fit-files` (gitignored).
 * In production it MUST point outside the Forge release dir
 * (e.g. /home/forge/sprocket.jerome-arfouche.ca/storage/fit-files) so files
 * persist across deploys and accumulate over time — see CLAUDE.md.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Absolute path to the configured FIT storage directory. */
export function fitStorageDir(): string {
  const dir = useRuntimeConfig().fitStorageDir || '.data/fit-files'
  return isAbsolute(dir) ? dir : resolve(process.cwd(), dir)
}

/** `<wahooWorkoutId>-<YYYY-MM-DD>.fit` — stable per (workout, date) so a re-delivered webhook overwrites rather than duplicates. */
export function fitFileName(wahooWorkoutId: number, dateLocal: string): string {
  const safeDate = DATE_RE.test(dateLocal) ? dateLocal : 'unknown-date'
  return `${wahooWorkoutId}-${safeDate}.fit`
}

/** Writes the FIT bytes to the storage dir (creating it if needed) and returns the full path. */
export async function saveFitFile(wahooWorkoutId: number, dateLocal: string, bytes: Buffer): Promise<string> {
  const dir = fitStorageDir()
  await mkdir(dir, { recursive: true })
  const path = join(dir, fitFileName(wahooWorkoutId, dateLocal))
  await writeFile(path, bytes)
  return path
}

/** Reads a previously stored FIT file — kept for future manual reprocessing. */
export function readFitFile(path: string): Promise<Buffer> {
  return readFile(path)
}
