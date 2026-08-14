/**
 * Coach store (Pinia)
 *
 * Carries an AI-generated workout (POST /api/coach/generate) from the
 * training log's "Auto-build" action across to the Workout Builder tab.
 *
 * `/` and `/builder` are separate route records under the `[[tab]]`
 * catch-all page, so navigating between them remounts the whole page —
 * an imperative call on WorkoutBuilderTab's instance right after
 * navigateTo() would land on the dying instance, not the new one (see
 * the comment on goToBuilder() in app/pages/[[tab]].vue). Pinia store
 * state isn't tied to component lifecycle, so it survives the remount —
 * WorkoutBuilderTab reads it on mount instead, same idiom as the
 * `planName` query param it already reads.
 *
 * Read-once: consumePendingWorkout() clears the value so navigating back
 * to the builder later doesn't reapply stale data.
 */

import { defineStore } from 'pinia'

/** Mirrors WorkoutBuilderTab.vue's Block union, minus the client-only `id` field. */
export type CoachRampBlock = { type: 'warmup' | 'cooldown', duration: number, powerStart: number, powerEnd: number, cadence: number | null }
export type CoachSteadyBlock = { type: 'steady', duration: number, power: number, cadence: number | null }
export type CoachIntervalBlock = { type: 'interval', reps: number, onDuration: number, onPower: number, onCadence: number | null, offDuration: number, offPower: number, offCadence: number | null }
export type CoachBlock = CoachRampBlock | CoachSteadyBlock | CoachIntervalBlock

export interface CoachWorkout {
  name: string
  blocks: CoachBlock[]
  fuellingGuide: string
}

export const useCoachStore = defineStore('coach', () => {
  const pendingWorkout = ref<CoachWorkout | null>(null)

  function setPendingWorkout(workout: CoachWorkout) {
    pendingWorkout.value = workout
  }

  /** Returns the pending workout (if any) and clears it — read-once. */
  function consumePendingWorkout(): CoachWorkout | null {
    const workout = pendingWorkout.value
    pendingWorkout.value = null
    return workout
  }

  return { pendingWorkout, setPendingWorkout, consumePendingWorkout }
})
