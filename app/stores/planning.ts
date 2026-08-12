/**
 * Planning store (Pinia)
 *
 * Manages the 4-week training plan grid:
 *   - The list of planned days (28 days, current Monday + 3 weeks ahead)
 *   - Current CTL and ATL from the actual training history (used as the seed)
 *   - Projected CTL and TSB computed locally without a round-trip
 *
 * Actions:
 *   fetchPlans()         — loads the plan grid from the API
 *   savePlan(date, entry)— upserts a planned workout and recomputes projections
 *   clearPlan(date)      — removes a planned workout and recomputes projections
 *
 * The local recompute (recomputeProjections) uses the same EMA formula as the
 * server so draft TSS values update the projected numbers as the user types,
 * before anything is saved.
 */

import { defineStore } from 'pinia'

/** A single planned workout row as returned by the API */
export interface PlanEntry {
  id?: number
  name: string | null
  /** Training zone: 'zone2' | 'zone4' | 'zone5' | 'zone6' | 'rest' | 'outdoor' */
  type: string | null
  tss: number | null
  durationMinutes: number | null
  notes: string | null
}

/** One day in the 4-week planning grid */
export interface PlannedDay {
  /** ISO date string "YYYY-MM-DD" */
  date: string
  /** True when the date is before today (historical, read-only) */
  isPast: boolean
  /** Planned workout for this day, or null for an unplanned rest day */
  plan: PlanEntry | null
  /** Actually logged totals for this day. null for future days. */
  actual: { tss: number, durationMinutes: number } | null
  /** Projected Chronic Training Load after applying this day's planned TSS */
  projectedCtl: number
  /** Projected Training Stress Balance (CTL − ATL) at the start of this day */
  projectedTsb: number
}

/** EMA decay factors — must match the server-side constants in tss.ts (TrainingPeaks/Coggan PMC standard: TSS delta / N) */
const CTL_DECAY = 1 / 42
const ATL_DECAY = 1 / 7

export const usePlanningStore = defineStore('planning', () => {
  const plans = ref<PlannedDay[]>([])
  /** Current CTL from the actual training history — seed for future projections */
  const currentCtl = ref(0)
  /** Current ATL from the actual training history — seed for future projections */
  const currentAtl = ref(0)
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  /**
   * Loads the 4-week plan grid from GET /api/planned-workouts.
   * Populates plans, currentCtl, and currentAtl.
   *
   * `fetcher` defaults to the global `$fetch` for ordinary client-triggered
   * calls. The initial page load passes `useRequestFetch()` instead so the
   * call can run during SSR — plain `$fetch` in a server context doesn't
   * forward the incoming request's session cookie, so `requireUserSession`
   * would 401.
   */
  async function fetchPlans(fetcher: ReturnType<typeof useRequestFetch> = $fetch) {
    isLoading.value = true
    error.value = null
    try {
      const data = await fetcher<{ plans: PlannedDay[], currentCtl: number, currentAtl: number }>(
        '/api/planned-workouts',
      )
      plans.value = data.plans
      currentCtl.value = data.currentCtl
      currentAtl.value = data.currentAtl
    }
    catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to load plans'
    }
    finally {
      isLoading.value = false
    }
  }

  /**
   * Recomputes projected CTL/TSB for all future days in-place, without a fetch.
   * Past days keep their historical projections; the seed CTL/ATL for future days
   * is derived from the last past day (or currentCtl/currentAtl if none exist).
   *
   * Called after every save/clear so the grid reflects the latest planned load
   * immediately — no round-trip required.
   */
  function recomputeProjections() {
    let ctl = currentCtl.value
    let atl = currentAtl.value

    for (let i = 0; i < plans.value.length; i++) {
      const day = plans.value[i]!
      if (day.isPast) {
        // Carry the actual historical values forward as the seed
        ctl = day.projectedCtl
        atl = day.projectedCtl - day.projectedTsb
      }
      else {
        const tss = day.plan?.tss ?? 0
        ctl = tss * CTL_DECAY + ctl * (1 - CTL_DECAY)
        atl = tss * ATL_DECAY + atl * (1 - ATL_DECAY)
        plans.value[i] = {
          ...day,
          projectedCtl: Math.round(ctl * 10) / 10,
          projectedTsb: Math.round((ctl - atl) * 10) / 10,
        }
      }
    }
  }

  /**
   * Upserts a planned workout via PUT /api/planned-workouts, then updates the
   * affected day in-place and recomputes all future projections.
   */
  async function savePlan(date: string, entry: PlanEntry) {
    await $fetch('/api/planned-workouts', {
      method: 'PUT',
      body: { date, ...entry },
    })
    // Update only the affected row in-place to avoid a full re-render
    const idx = plans.value.findIndex(p => p.date === date)
    if (idx !== -1) {
      plans.value[idx] = { ...plans.value[idx]!, plan: { ...entry } }
    }
    recomputeProjections()
  }

  /**
   * Deletes the planned workout for a given date via DELETE /api/planned-workouts/:date,
   * clears the plan in-place, and recomputes all future projections.
   */
  async function clearPlan(date: string) {
    await $fetch(`/api/planned-workouts/${date}`, { method: 'DELETE' })
    const idx = plans.value.findIndex(p => p.date === date)
    if (idx !== -1) {
      plans.value[idx] = { ...plans.value[idx]!, plan: null }
    }
    recomputeProjections()
  }

  return { plans, currentCtl, currentAtl, isLoading, error, fetchPlans, savePlan, clearPlan }
})
