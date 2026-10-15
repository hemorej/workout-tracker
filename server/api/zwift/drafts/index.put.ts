/**
 * PUT /api/zwift/drafts
 *
 * Saves the builder's edit of a library workout as its (single) draft. The
 * disk mirror is never touched — a draft reaches the real file only when the
 * user downloads the .zwo and saves it into the Zwift folder.
 *
 * Body: { workoutId, baseHash, xml }. `baseHash` must equal the workout's
 * current `contentHash`; otherwise the file changed on disk since editing
 * began and the client has to resolve that first (409).
 */

import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { useDB } from '../../../db'
import { zwiftWorkouts, zwiftWorkoutDrafts } from '../../../db/schema'
import { parseZwo, zwoCanonicalString, ZWO_LIMITS } from '../../../../shared/utils/zwo'
import { sha256Hex } from '../../../utils/zwiftSync'

const Body = z.object({
  workoutId: z.number().int(),
  baseHash: z.string().min(1).max(128),
  xml: z.string().max(ZWO_LIMITS.maxXmlLength),
})

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const parsedBody = Body.safeParse(await readBody(event))
  if (!parsedBody.success) throw createError({ statusCode: 400, message: 'Invalid body' })
  const { workoutId, baseHash, xml } = parsedBody.data

  const parsed = parseZwo(xml)
  if (!parsed.ok) throw createError({ statusCode: 422, message: `Invalid workout: ${parsed.error}` })

  const db = useDB()
  const [workout] = await db.select({ id: zwiftWorkouts.id, contentHash: zwiftWorkouts.contentHash, editable: zwiftWorkouts.editable })
    .from(zwiftWorkouts)
    .where(and(eq(zwiftWorkouts.id, workoutId), eq(zwiftWorkouts.userId, user.id), isNull(zwiftWorkouts.deletedAt)))
    .limit(1)
  if (!workout) throw createError({ statusCode: 404, message: 'Workout not found' })
  if (!workout.editable) throw createError({ statusCode: 422, message: 'This workout cannot be edited in the builder.' })
  if (workout.contentHash !== baseHash) {
    throw createError({ statusCode: 409, message: 'The file on disk changed since you started editing.' })
  }

  const values = {
    baseHash: workout.contentHash,
    xml,
    modelHash: sha256Hex(zwoCanonicalString(parsed.workout)),
    updatedAt: new Date(),
  }
  await db.insert(zwiftWorkoutDrafts)
    .values({ userId: user.id, workoutId, ...values })
    .onConflictDoUpdate({ target: [zwiftWorkoutDrafts.userId, zwiftWorkoutDrafts.workoutId], set: values })

  getLogger('zwift').info('zwift.draft_saved', { requestId: event.context.requestId, workoutId })
  return { ok: true, baseHash: workout.contentHash }
})
