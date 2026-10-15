/**
 * Zwift library store (Pinia)
 *
 * Hand-off from the library panel's "Open in builder" to WorkoutBuilderTab,
 * same shape of problem as `coach.ts`: `/builder` is a `[[tab]]` route record
 * that remounts, so the builder reads the pending workout from here on mount
 * (and when the panel asks it to apply one) instead of via a prop.
 *
 * Read-once: consumePendingOpen() clears the value.
 */

import { defineStore } from 'pinia'
import type { ZwoBlock, ZwoMeta, ZwoTimelineEvent } from '#shared/utils/zwo'

/** One version of a library workout in the builder's absolute-time event model. */
export interface LibraryVersion {
  meta: ZwoMeta
  /** Blocks without `textEvents` — those are in `events`. */
  blocks: ZwoBlock[]
  events: ZwoTimelineEvent[]
}

export interface LibraryPendingOpen {
  workoutId: number
  path: string
  /** Disk `contentHash` the edit starts from. */
  baseHash: string
  /** The version to show: the draft when one exists, otherwise disk. */
  meta: ZwoMeta
  blocks: ZwoBlock[]
  events: ZwoTimelineEvent[]
  hasDraft: boolean
  /** Disk changed under the draft and the two differ — must be resolved before saving/downloading. */
  stale: boolean
  /** The on-disk version, for "Revert to disk" / "Discard my edit". */
  disk: LibraryVersion
}

export const useZwiftLibraryStore = defineStore('zwiftLibrary', () => {
  const pendingOpen = ref<LibraryPendingOpen | null>(null)

  function setPendingOpen(open: LibraryPendingOpen) {
    pendingOpen.value = open
  }

  function consumePendingOpen(): LibraryPendingOpen | null {
    const open = pendingOpen.value
    pendingOpen.value = null
    return open
  }

  return { pendingOpen, setPendingOpen, consumePendingOpen }
})
