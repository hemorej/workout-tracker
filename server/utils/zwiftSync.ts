/**
 * Server side of the Zwift workout-folder sync (see scripts/zwift-sync.ts for
 * the daemon, shared/utils/zwo.ts for the parser).
 *
 * Both endpoints under server/api/zwift/sync* are PUBLIC (no session) and
 * authenticated only by `NUXT_ZWIFT_SYNC_TOKEN`, sent as a Bearer header.
 * Everything in a request body is untrusted: size-capped before reading,
 * shape-validated, and parsed with the hardened shared parser. Derived fields
 * (name, TSS, hashes…) are always computed here — never taken from the client.
 */

import { createHash } from 'node:crypto'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { useDB } from '../db'
import { zwiftWorkouts, zwiftWorkoutDrafts } from '../db/schema'
import { secretMatches } from './wahooWebhook'
import { normalizeZwoPath, parseZwo, zoneFromTags, zwoCanonicalString, ZWO_LIMITS } from '../../shared/utils/zwo'

const log = getLogger('zwift')

/**
 * Per-request caps. 1 MB deliberately equals nginx's default
 * client_max_body_size, so no nginx change is needed; the daemon batches to fit.
 */
export const ZWIFT_SYNC_LIMITS = {
  maxBodyBytes: 1_000_000,
  maxFilesPerBatch: 100,
  maxDeletesPerBatch: 200,
} as const

/** Hex sha256 of a UTF-8 string — `contentHash` / `modelHash` values. */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/**
 * First thing both sync handlers do — before any body read, DB or parse work.
 * Throws 401 unless `Authorization: Bearer <NUXT_ZWIFT_SYNC_TOKEN>` matches
 * (constant-time). An unset token ⇒ always 401.
 */
export function requireZwiftSyncToken(event: Parameters<typeof getHeader>[0]) {
  const expected = useRuntimeConfig().zwiftSyncToken as string | undefined
  const provided = getHeader(event, 'authorization')?.replace(/^Bearer\s+/i, '')
  if (!secretMatches(provided, expected)) {
    log.warn('zwift.sync_unauthorized', { requestId: event.context.requestId })
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized.' })
  }
}

const SyncBodySchema = z.object({
  files: z.array(z.object({
    path: z.string(),
    xml: z.string(),
    mtime: z.string().optional(),
  })).max(ZWIFT_SYNC_LIMITS.maxFilesPerBatch).default([]),
  deletes: z.array(z.string()).max(ZWIFT_SYNC_LIMITS.maxDeletesPerBatch).default([]),
})

export type ZwiftSyncBody = z.infer<typeof SyncBodySchema>

/** Reads the request body with a hard size cap and validates its shape. */
export async function readSyncBody(event: Parameters<typeof readRawBody>[0]): Promise<ZwiftSyncBody> {
  const declared = Number(getHeader(event, 'content-length'))
  if (Number.isFinite(declared) && declared > ZWIFT_SYNC_LIMITS.maxBodyBytes) {
    throw createError({ statusCode: 413, statusMessage: 'Payload too large.' })
  }
  const raw = await readRawBody(event, 'utf-8')
  if (!raw) throw createError({ statusCode: 400, statusMessage: 'Empty body.' })
  if (Buffer.byteLength(raw, 'utf8') > ZWIFT_SYNC_LIMITS.maxBodyBytes) {
    throw createError({ statusCode: 413, statusMessage: 'Payload too large.' })
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  }
  catch {
    throw createError({ statusCode: 400, statusMessage: 'Body must be JSON.' })
  }
  const parsed = SyncBodySchema.safeParse(json)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid body.' })
  }
  return parsed.data
}

/** Per-batch counters returned to the daemon (and logged as `zwift.sync_applied`). */
export interface ZwiftSyncResult {
  /** Files inserted or updated (content changed). */
  upserted: number
  /** Files whose contentHash already matched. */
  unchanged: number
  /** Soft-deleted files that reappeared unchanged. */
  restored: number
  /** Files soft-deleted by this batch. */
  deleted: number
  /** Drafts removed because the saved file now equals them (modelHash match). */
  draftsCleared: number
  /** Files skipped (invalid path/too large/unparseable); capped at 20 entries. */
  rejected: Array<{ path: string, reason: string }>
}

const MAX_REPORTED_REJECTIONS = 20

/**
 * Applies one validated batch for `userId` in a single transaction. Idempotent:
 * re-sending the same batch changes nothing.
 */
export async function applyZwiftSyncBatch(userId: number, body: ZwiftSyncBody): Promise<ZwiftSyncResult> {
  const db = useDB()
  const result: ZwiftSyncResult = { upserted: 0, unchanged: 0, restored: 0, deleted: 0, draftsCleared: 0, rejected: [] }
  const reject = (path: string, reason: string) => {
    if (result.rejected.length < MAX_REPORTED_REJECTIONS) result.rejected.push({ path: path.slice(0, 255), reason })
  }

  // Last occurrence of a path wins within a batch.
  const files = new Map<string, { xml: string, mtime: string | undefined }>()
  for (const f of body.files) {
    const path = normalizeZwoPath(f.path)
    if (!path) { reject(f.path, 'invalid path'); continue }
    if (f.xml.length > ZWO_LIMITS.maxXmlLength) { reject(path, 'file too large'); continue }
    files.set(path, { xml: f.xml, mtime: f.mtime })
  }
  const deletePaths = [...new Set(body.deletes.map(normalizeZwoPath).filter((p): p is string => p !== null))]
    .filter(p => !files.has(p))

  await db.transaction(async (tx) => {
    if (deletePaths.length) {
      const gone = await tx.update(zwiftWorkouts)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(zwiftWorkouts.userId, userId),
          inArray(zwiftWorkouts.path, deletePaths),
          isNull(zwiftWorkouts.deletedAt),
        ))
        .returning({ id: zwiftWorkouts.id })
      result.deleted = gone.length
    }

    if (files.size === 0) return

    const existing = await tx
      .select({ id: zwiftWorkouts.id, path: zwiftWorkouts.path, contentHash: zwiftWorkouts.contentHash, deletedAt: zwiftWorkouts.deletedAt })
      .from(zwiftWorkouts)
      .where(and(eq(zwiftWorkouts.userId, userId), inArray(zwiftWorkouts.path, [...files.keys()])))
    const byPath = new Map(existing.map(r => [r.path, r]))

    for (const [path, file] of files) {
      const contentHash = sha256Hex(file.xml)
      const prior = byPath.get(path)

      if (prior && prior.contentHash === contentHash) {
        if (prior.deletedAt) {
          await tx.update(zwiftWorkouts)
            .set({ deletedAt: null, updatedAt: new Date() })
            .where(and(eq(zwiftWorkouts.id, prior.id), eq(zwiftWorkouts.userId, userId)))
          result.restored += 1
        }
        else {
          result.unchanged += 1
        }
        continue
      }

      const parsed = parseZwo(file.xml)
      if (!parsed.ok) { reject(path, parsed.error); continue }
      const { workout } = parsed

      const mtime = file.mtime ? new Date(file.mtime) : null
      const modelHash = sha256Hex(zwoCanonicalString(workout))
      const values = {
        name: workout.meta.name || path.split('/').pop()!.replace(/\.zwo$/i, ''),
        xml: file.xml,
        contentHash,
        modelHash,
        durationSec: Math.round(workout.durationSec),
        tss: workout.tss,
        zone: zoneFromTags(workout.meta.tags),
        editable: workout.editable,
        unsupported: workout.unsupported,
        fileMtime: mtime && !Number.isNaN(mtime.getTime()) ? mtime : null,
        deletedAt: null,
        updatedAt: new Date(),
      }

      const [row] = await tx
        .insert(zwiftWorkouts)
        .values({ userId, path, ...values })
        .onConflictDoUpdate({ target: [zwiftWorkouts.userId, zwiftWorkouts.path], set: values })
        .returning({ id: zwiftWorkouts.id })
      result.upserted += 1

      // The user saved a web edit back into the folder: the draft now equals disk.
      const cleared = await tx.delete(zwiftWorkoutDrafts)
        .where(and(
          eq(zwiftWorkoutDrafts.userId, userId),
          eq(zwiftWorkoutDrafts.workoutId, row!.id),
          eq(zwiftWorkoutDrafts.modelHash, modelHash),
        ))
        .returning({ id: zwiftWorkoutDrafts.id })
      result.draftsCleared += cleared.length
    }
  })

  return result
}
