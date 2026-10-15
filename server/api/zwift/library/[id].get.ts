/**
 * GET /api/zwift/library/:id
 *
 * Everything the builder needs to open one library workout: the on-disk
 * version, the saved draft (if any) and whether the draft is stale (see
 * server/utils/zwiftLibrary.ts). `baseHash` is the disk `contentHash` an edit
 * starts from — sent back on draft save so a concurrent disk change is caught.
 */

import { and, eq, isNull } from 'drizzle-orm'
import { useDB } from '../../../db'
import { zwiftWorkouts, zwiftWorkoutDrafts } from '../../../db/schema'
import { isStaleDraft, parseVersion } from '../../../utils/zwiftLibrary'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400, message: 'invalid id' })

  const db = useDB()
  const [workout] = await db.select().from(zwiftWorkouts)
    .where(and(eq(zwiftWorkouts.id, id), eq(zwiftWorkouts.userId, user.id), isNull(zwiftWorkouts.deletedAt)))
    .limit(1)
  if (!workout) throw createError({ statusCode: 404, message: 'Workout not found' })

  const [draft] = await db.select().from(zwiftWorkoutDrafts)
    .where(and(eq(zwiftWorkoutDrafts.workoutId, id), eq(zwiftWorkoutDrafts.userId, user.id)))
    .limit(1)

  const disk = parseVersion(workout.xml)
  if (!disk) throw createError({ statusCode: 422, message: 'Stored workout could not be parsed' })

  return {
    id: workout.id,
    path: workout.path,
    editable: workout.editable,
    unsupported: workout.unsupported,
    contentHash: workout.contentHash,
    disk,
    draft: draft ? { ...(parseVersion(draft.xml) ?? disk), baseHash: draft.baseHash } : null,
    stale: isStaleDraft(workout, draft),
  }
})
