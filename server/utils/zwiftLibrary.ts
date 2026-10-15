/**
 * Shared shaping for the Workout builder's Zwift library (session-authed
 * endpoints under server/api/zwift/library and server/api/zwift/drafts).
 *
 * The mirror rows (`zwift_workouts`) are written only by the sync daemon; what
 * the web UI adds is `zwift_workout_drafts`. A draft is *stale* when the file
 * on disk changed after the draft was started (`baseHash` ≠ `contentHash`)
 * AND the two describe different workouts (`modelHash` differs) — if only the
 * bytes differ the model is the same and there is nothing to resolve.
 */

import {
  flattenTextEvents,
  parseZwo,
  zwoSegments,
  type ZwoBlock,
  type ZwoMeta,
  type ZwoTimelineEvent,
} from '../../shared/utils/zwo'
import type { ZwiftWorkout, ZwiftWorkoutDraft } from '../db/schema'

/** One version (disk or draft) of a workout, in the builder's absolute-time event model. */
export interface LibraryVersion {
  meta: ZwoMeta
  /** Blocks with `textEvents` stripped — they live in `events` as absolute times. */
  blocks: ZwoBlock[]
  events: ZwoTimelineEvent[]
  durationSec: number
  tss: number
  editable: boolean
}

export function parseVersion(xml: string): LibraryVersion | null {
  const parsed = parseZwo(xml)
  if (!parsed.ok) return null
  const { workout } = parsed
  const flat = flattenTextEvents(workout.blocks)
  return {
    meta: workout.meta,
    blocks: flat.blocks,
    events: flat.events,
    durationSec: Math.round(workout.durationSec),
    tss: workout.tss,
    editable: workout.editable,
  }
}

export function isStaleDraft(workout: Pick<ZwiftWorkout, 'contentHash' | 'modelHash'>, draft: Pick<ZwiftWorkoutDraft, 'baseHash' | 'modelHash'> | null | undefined): boolean {
  return !!draft && draft.baseHash !== workout.contentHash && draft.modelHash !== workout.modelHash
}

/** Compact drawable form used by the list thumbnails / preview. */
export function timelineOf(version: LibraryVersion) {
  const segs = zwoSegments(version.blocks).map(s => ({
    d: s.duration,
    a: s.powerStart,
    b: s.powerEnd,
    t: s.free ? 'f' as const : 's' as const,
  }))
  return {
    segs,
    tot: Math.max(1, segs.reduce((sum, s) => sum + s.d, 0)),
    ev: version.events.map(e => ({ at: e.at, text: e.text })),
  }
}
