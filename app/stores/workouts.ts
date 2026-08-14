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

export interface PowerBestEntry {
  duration: string
  watts: number
}

/** Extra stats from a parsed FIT file — mirrors WorkoutFitData in server/db/schema.ts */
export interface WorkoutFitData {
  avgPower: number
  maxPower: number
  normalizedPower: number
  intensityFactor: number
  avgHr: number | null
  maxHr: number | null
  avgCadence: number | null
  maxCadence: number | null
}

export interface WorkoutDetail {
  id: number
  name: string
  durationMinutes: number
  distanceKm: number | null
  tss: number
  rpe: number | null
  notes: string | null
  ftpWatts: number | null
  rideType: 'trainer' | 'outdoor' | null
  fitData: WorkoutFitData | null
  powerBests: PowerBestEntry[]
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
  kmTotal: number
}

export interface Pagination {
  page: number
  limit: number
  totalDays: number
  totalPages: number
}

/** Training-log filter bar state — mirrors the GET /api/workouts filter query params */
export interface LogFilters {
  name: string
  type: 'all' | 'zwift' | 'outdoor'
  minTss: number
  minDistance: number
  minDuration: number
  dateFrom: string
  dateTo: string
}

export const DEFAULT_LOG_FILTERS: LogFilters = {
  name: '',
  type: 'all',
  minTss: 0,
  minDistance: 0,
  minDuration: 0,
  dateFrom: '',
  dateTo: '',
}

export interface NewWorkoutPayload {
  date: string
  name: string
  durationMinutes: number
  distanceKm?: number | null
  tss: number
  rpe?: number | null
  notes?: string | null
  ftpWatts?: number | null
  rideType?: 'trainer' | 'outdoor' | null
  powerBests?: PowerBestEntry[]
  fitData?: WorkoutFitData | null
}

// ── Store ───────────────────────────────────────────────────────────────────

export const useWorkoutsStore = defineStore('workouts', () => {
  // State
  const days = ref<DayEntry[]>([])
  const weeklyStats = ref<WeeklyStats>({ tssTotal: 0, hoursTotal: 0, kmTotal: 0 })
  const todayMetrics = ref<DayMetrics>({ ctl: 0, atl: 0, tsb: 0 })
  const yesterdayMetrics = ref<DayMetrics | null>(null)
  const pagination = ref<Pagination>({ page: 1, limit: 14, totalDays: 0, totalPages: 0 })
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const filters = ref<LogFilters>({ ...DEFAULT_LOG_FILTERS })

  // ── Actions ──────────────────────────────────────────────────────────────

  /**
   * Fetches a page of the day list from GET /api/workouts, applying the
   * current `filters` state. Only non-default filter values are sent, so an
   * unfiltered fetch is identical to the original calendar-day request.
   *
   * `fetcher` defaults to the global `$fetch` for ordinary client-triggered
   * calls (pagination, filters, refresh-after-mutation). The initial page
   * load passes `useRequestFetch()` instead so the call can run during SSR —
   * plain `$fetch` in a server context doesn't forward the incoming
   * request's session cookie, so `requireUserSession` would 401.
   */
  async function fetchPage(page: number = 1, fetcher: ReturnType<typeof useRequestFetch> = $fetch) {
    isLoading.value = true
    error.value = null

    const f = filters.value
    const query: Record<string, string | number> = { page, limit: pagination.value.limit }
    if (f.name) query.name = f.name
    if (f.type !== 'all') query.type = f.type
    if (f.minTss > 0) query.minTss = f.minTss
    if (f.minDistance > 0) query.minDistance = f.minDistance
    if (f.minDuration > 0) query.minDuration = f.minDuration
    if (f.dateFrom) query.dateFrom = f.dateFrom
    if (f.dateTo) query.dateTo = f.dateTo

    try {
      const data = await fetcher('/api/workouts', {
        query,
      }) as {
        days: DayEntry[]
        weeklyStats: WeeklyStats
        todayMetrics: DayMetrics
        yesterdayMetrics: DayMetrics | null
        pagination: Pagination
      }

      days.value = data.days
      weeklyStats.value = data.weeklyStats
      todayMetrics.value = data.todayMetrics
      yesterdayMetrics.value = data.yesterdayMetrics
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
   * Updates an existing workout via PATCH /api/workouts/:id, then refreshes
   * the current page in place (unlike addWorkout, this stays on the current
   * page rather than jumping to page 1 — the edited workout is already visible).
   */
  async function updateWorkout(id: number, payload: NewWorkoutPayload) {
    await $fetch(`/api/workouts/${id}`, {
      method: 'PATCH',
      body: payload,
    })
    await fetchPage(pagination.value.page)
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

  /**
   * Replaces the active filter set and re-fetches from page 1 so the list
   * updates live as the filter bar changes.
   */
  async function setFilters(next: LogFilters) {
    filters.value = next
    await fetchPage(1)
  }

  return {
    // State
    days,
    weeklyStats,
    todayMetrics,
    yesterdayMetrics,
    pagination,
    isLoading,
    error,
    filters,
    // Actions
    fetchPage,
    addWorkout,
    updateWorkout,
    deleteWorkout,
    goToPage,
    setFilters,
  }
})
