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

  async function savePlan(date: string, entry: PlanEntry) {
    await $fetch('/api/planned-workouts', {
      method: 'PUT',
      body: { date, ...entry },
    })
    await fetchPlans()
  }

  async function clearPlan(date: string) {
    await $fetch(`/api/planned-workouts/${date}`, { method: 'DELETE' })
    await fetchPlans()
  }

  return { plans, currentCtl, currentAtl, isLoading, error, fetchPlans, savePlan, clearPlan }
})
