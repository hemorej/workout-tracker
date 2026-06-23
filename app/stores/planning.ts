import { defineStore } from 'pinia'

export interface PlanEntry {
  id?: number
  name: string | null
  type: string | null
  tss: number | null
  durationMinutes: number | null
}

export interface PlannedDay {
  date: string
  isPast: boolean
  plan: PlanEntry | null
  projectedCtl: number
  projectedTsb: number
}

const CTL_DECAY = 2 / 43
const ATL_DECAY = 2 / 8

export const usePlanningStore = defineStore('planning', () => {
  const plans = ref<PlannedDay[]>([])
  const currentCtl = ref(0)
  const currentAtl = ref(0)
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  async function fetchPlans() {
    isLoading.value = true
    error.value = null
    try {
      const data = await $fetch<{ plans: PlannedDay[], currentCtl: number, currentAtl: number }>(
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

  // Recomputes projected CTL/TSB for all future days in-place, without a fetch.
  // Past days keep their historical projections; the seed CTL/ATL for future days
  // is derived from the last past day (or currentCtl/currentAtl if none exist).
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
