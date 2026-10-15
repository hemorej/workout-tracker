/**
 * GET /api/zwift/library
 *
 * The Workout builder's library panel: every live (not soft-deleted) mirrored
 * workout with the facts the list needs (duration, TSS, zone, thumbnail
 * segments) and its draft/stale state. Duration and TSS are computed from the
 * version that "Open in builder" would load — the draft, unless it is stale,
 * in which case the disk file.
 */

import { and, eq, isNull } from 'drizzle-orm'
import { useDB } from '../../../db'
import { zwiftWorkouts, zwiftWorkoutDrafts } from '../../../db/schema'
import { isStaleDraft, parseVersion, timelineOf } from '../../../utils/zwiftLibrary'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const db = useDB()

  const [rows, drafts] = await Promise.all([
    db.select().from(zwiftWorkouts)
      .where(and(eq(zwiftWorkouts.userId, user.id), isNull(zwiftWorkouts.deletedAt))),
    db.select().from(zwiftWorkoutDrafts)
      .where(eq(zwiftWorkoutDrafts.userId, user.id)),
  ])
  const draftByWorkout = new Map(drafts.map(d => [d.workoutId, d]))

  const workouts = rows.flatMap((w) => {
    const draft = draftByWorkout.get(w.id) ?? null
    const stale = isStaleDraft(w, draft)
    const shown = (draft && !stale ? parseVersion(draft.xml) : null) ?? parseVersion(w.xml)
    if (!shown) return []
    return [{
      id: w.id,
      name: shown.meta.name || w.name,
      path: w.path,
      durationSec: shown.durationSec,
      tss: shown.tss,
      zone: w.zone,
      editable: w.editable,
      hasDraft: !!draft,
      stale,
      updatedAt: w.updatedAt.toISOString(),
      timeline: timelineOf(shown),
    }]
  })

  workouts.sort((a, b) => a.name.localeCompare(b.name))
  return { workouts }
})
