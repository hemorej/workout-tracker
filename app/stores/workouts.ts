/**
 * Workouts store (Pinia)
 *
 * Manages the state for the homepage dashboard:
 *   - The paginated day list (workouts + rest days)
 *   - Weekly stats (TSS total, hours total)
 *   - Today's CTL / ATL / TSB snapshot
 *   - Pagination state
 *   - Loading / error state
 *
 * Actions:
 *   fetchPage(page)   — loads a page of the day list from the API
 *   addWorkout(data)  — posts a new workout, then refreshes the current page
 *   deleteWorkout(id) — deletes a workout by id, then refreshes the current page
 */

import { defineStore } from 'pinia'

// ── Types (mirror the API response shape) ───────────────────────────────────

export interface WorkoutDetail {
  id: number
  name: string
  durationMinutes: number
  tss: number
  rpe: number | null
  notes: string | null
}

export interface DayMetrics {
  ctl: number
  atl: number
  tsb: number
}

export interface DayEntry {
  date: string
  isRestDay: boolean
  metrics: DayMetrics
  workout: WorkoutDetail | null
}

export interface WeeklyStats {
  tssTotal: number
  hoursTotal: number
}

export interface Pagination {
  page: number
  limit: number
  totalDays: number
  totalPages: number
}

export interface NewWorkoutPayload {
  date: string
  name: string
  durationMinutes: number
  tss: number
  rpe?: number | null
  notes?: string | null
}

// ── Store ───────────────────────────────────────────────────────────────────

export const useWorkoutsStore = defineStore('workouts', () => {
  // State
  const days = ref<DayEntry[]>([])
  const weeklyStats = ref<WeeklyStats>({ tssTotal: 0, hoursTotal: 0 })
  const todayMetrics = ref<DayMetrics>({ ctl: 0, atl: 0, tsb: 0 })
  const pagination = ref<Pagination>({ page: 1, limit: 14, totalDays: 0, totalPages: 0 })
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  // ── Actions ──────────────────────────────────────────────────────────────

  /**
   * Fetches a page of the day list from GET /api/workouts.
   * Updates all reactive state including weekly stats and today's metrics.
   */
  async function fetchPage(page: number = 1) {
    isLoading.value = true
    error.value = null

    try {
      const data = await $fetch('/api/workouts', {
        query: { page, limit: pagination.value.limit },
      }) as {
        days: DayEntry[]
        weeklyStats: WeeklyStats
        todayMetrics: DayMetrics
        pagination: Pagination
      }

      days.value = data.days
      weeklyStats.value = data.weeklyStats
      todayMetrics.value = data.todayMetrics
      pagination.value = data.pagination
    }
    catch (err: unknown) {
      error.value = (err as { data?: { statusMessage?: string } })?.data?.statusMessage
        ?? 'Failed to load workouts.'
    }
    finally {
      isLoading.value = false
    }
  }

  /**
   * Submits a new workout to POST /api/workouts, then refreshes the current page
   * so the new entry appears immediately in the list.
   */
  async function addWorkout(payload: NewWorkoutPayload) {
    await $fetch('/api/workouts', {
      method: 'POST',
      body: payload,
    })
    // Refresh — go back to page 1 so the newly added workout is visible
    await fetchPage(1)
  }

  /**
   * Deletes a workout by id via DELETE /api/workouts/:id,
   * then refreshes the current page.
   */
  async function deleteWorkout(id: number) {
    await $fetch(`/api/workouts/${id}`, { method: 'DELETE' })
    await fetchPage(pagination.value.page)
  }

  /**
   * Navigates to a different page of results.
   */
  async function goToPage(page: number) {
    if (page < 1 || page > pagination.value.totalPages) return
    await fetchPage(page)
  }

  return {
    // State
    days,
    weeklyStats,
    todayMetrics,
    pagination,
    isLoading,
    error,
    // Actions
    fetchPage,
    addWorkout,
    deleteWorkout,
    goToPage,
  }
})
