/**
 * POST /api/zwift/sync  —  PUBLIC (no session), secret-authed
 *
 * Receives batches of changed/removed `.zwo` files from the local sync daemon
 * (scripts/zwift-sync.ts). The local Zwift folder is the source of truth, so
 * this is a one-way mirror: upsert by path, soft-delete on removal.
 *
 * Auth (first thing, before the body is read): `Authorization: Bearer
 * <NUXT_ZWIFT_SYNC_TOKEN>`, constant-time compared. Same no-middleware
 * precedent as the Wahoo webhook / segments reconcile — never calls
 * `requireUserSession`.
 *
 * Unlike the third-party webhooks, malformed input gets honest 4xx codes: the
 * only caller is our own daemon, which owns its retry/backoff.
 *
 * Body: { files?: [{ path, xml, mtime? }], deletes?: [path] }
 * Caps: 1 MB body, 100 files, 200 deletes, 256 KB per file (see zwiftSync.ts).
 */

import { useDB } from '../../db'
import { applyZwiftSyncBatch, readSyncBody, requireZwiftSyncToken } from '../../utils/zwiftSync'
import { resolveWebhookUserId } from '../../utils/webhookUser'

const log = getLogger('zwift')

export default defineEventHandler(async (event) => {
  const requestId = event.context.requestId
  requireZwiftSyncToken(event)

  const body = await readSyncBody(event)

  const { userId, matched } = await resolveWebhookUserId(useDB())
  if (userId === null) {
    log.warn('zwift.sync_user_unresolved', { requestId, matched })
    throw createError({ statusCode: 409, statusMessage: 'No unambiguous target user.' })
  }

  const result = await applyZwiftSyncBatch(userId, body)

  log.info('zwift.sync_applied', {
    requestId,
    upserted: result.upserted,
    unchanged: result.unchanged,
    restored: result.restored,
    deleted: result.deleted,
    draftsCleared: result.draftsCleared,
    rejected: result.rejected.length,
  })
  for (const r of result.rejected) {
    log.warn('zwift.sync_rejected', { requestId, path: r.path, reason: r.reason })
  }

  return { ok: true, ...result }
})
