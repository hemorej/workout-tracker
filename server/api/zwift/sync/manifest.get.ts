/**
 * GET /api/zwift/sync/manifest  —  PUBLIC (no session), secret-authed
 *
 * Returns `{ files: [{ path, contentHash }] }` for every live (not
 * soft-deleted) mirrored workout, so the daemon can diff its local folder
 * against the server on startup and periodically (fs events alone are lossy).
 * Same Bearer-token auth as POST /api/zwift/sync.
 */

import { and, eq, isNull } from 'drizzle-orm'
import { useDB } from '../../../db'
import { zwiftWorkouts } from '../../../db/schema'
import { requireZwiftSyncToken } from '../../../utils/zwiftSync'
import { resolveWebhookUserId } from '../../../utils/webhookUser'

export default defineEventHandler(async (event) => {
  requireZwiftSyncToken(event)

  const db = useDB()
  const { userId, matched } = await resolveWebhookUserId(db)
  if (userId === null) {
    getLogger('zwift').warn('zwift.sync_user_unresolved', { requestId: event.context.requestId, matched })
    throw createError({ statusCode: 409, statusMessage: 'No unambiguous target user.' })
  }

  const files = await db
    .select({ path: zwiftWorkouts.path, contentHash: zwiftWorkouts.contentHash })
    .from(zwiftWorkouts)
    .where(and(eq(zwiftWorkouts.userId, userId), isNull(zwiftWorkouts.deletedAt)))

  return { files }
})
