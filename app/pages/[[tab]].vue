<script setup lang="ts">
/**
 * Homepage / Dashboard
 *
 * The main view of the app. Requires the user to be logged in.
 *
 * Layout:
 *  ┌─────────────────────────────────────────────────────┐
 *  │  Header: app name + username + logout button         │
 *  ├─────────────────────────────────────────────────────┤
 *  │  MetricsSummary: weekly TSS, hours, CTL, TSB         │
 *  ├─────────────────────────────────────────────────────┤
 *  │  "Add workout" button                                │
 *  ├─────────────────────────────────────────────────────┤
 *  │  WorkoutCard list (paginated, newest first)          │
 *  │    — workouts show name, duration, TSS, metrics      │
 *  │    — rest days show "Rest day" badge                 │
 *  ├─────────────────────────────────────────────────────┤
 *  │  Pagination controls                                 │
 *  └─────────────────────────────────────────────────────┘
 *
 * Data flow:
 *  - On mount: workoutsStore.fetchPage(1) loads first page + summary stats
 *  - AddWorkoutModal emits 'saved' → store.fetchPage(1) refreshes everything
 *  - WorkoutCard emits 'delete' → store.deleteWorkout(id)
 */

import { useAuthStore } from '~/stores/auth'
import { useWorkoutsStore, type LogFilters } from '~/stores/workouts'
import { usePlanningStore } from '~/stores/planning'
import type { WorkoutPrefill } from '~/components/AddWorkoutModal.vue'

interface StravaRideSummary {
  id: number
  name: string
  startDateLocal: string
  movingTimeSeconds: number
  distanceMeters: number
}

// Protect this page — unauthenticated users are sent to /login
definePageMeta({ middleware: 'auth' })

// ── Tab navigation ────────────────────────────────────────────────────────
// This page matches both `/` and `/:tab` (optional catch-all route file
// `[[tab]].vue`), so the active tab is driven by the URL — `/planning` loads
// straight into the planning tab, and clicking a tab pushes a matching URL.
const tabs = [
  { id: 'log', label: 'Training log' },
  { id: 'planning', label: 'Planning' },
  { id: 'builder', label: 'Workout builder' },
  { id: 'history', label: 'History' },
] as const

type TabId = typeof tabs[number]['id']
const tabIds = tabs.map(t => t.id)

const route = useRoute()
const routeTab = computed<TabId>(() => {
  const param = route.params.tab
  const value = Array.isArray(param) ? param[0] : param
  return tabIds.includes(value as TabId) ? (value as TabId) : 'log'
})

const activeTab = ref<TabId>(routeTab.value)
watch(routeTab, (tab) => { activeTab.value = tab })

/** Sets the active tab and pushes the matching URL (`/` for the default log tab) */
function setTab(id: TabId) {
  activeTab.value = id
  navigateTo(id === 'log' ? '/' : `/${id}`)
}

const auth = useAuthStore()
const workouts = useWorkoutsStore()
const planning = usePlanningStore()
const toast = useToast()

// Today's date as YYYY-MM-DD (local time, matches DayEntry.date format)
const todayStr = computed(() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})

// Today's planned day entry (null if nothing planned or plan is a rest day)
// Pass the full PlannedDay so WorkoutCard can use projected CTL/TSB values
const todayPlan = computed(() => {
  const entry = planning.plans.find(p => p.date === todayStr.value)
  if (!entry?.plan || entry.plan.type === 'rest') return null
  return entry
})

// ── Add-workout modal ────────────────────────────────────────────────────
// UModal lives here (same component that owns the open state) — this matches
// the documented pattern and avoids prop-forwarding reactivity issues.
const showAddWorkout = ref(false)
const addWorkoutForm = ref<{ reset: () => void } | null>(null)
const pendingPrefill = ref<WorkoutPrefill | null>(null)

// ── CTL/TSB history chart modal ──────────────────────────────────────────
const showHistoryChart = ref(false)
const historyLoading = ref(false)
const historySeries = ref<{ date: string, ctl: number, tsb: number }[]>([])

async function openHistoryChart() {
  showHistoryChart.value = true
  historyLoading.value = true
  try {
    const data = await $fetch<{ series: { date: string, ctl: number, tsb: number }[] }>('/api/metrics/series', {
      query: { weeks: 8 },
    })
    historySeries.value = data.series
  }
  finally {
    historyLoading.value = false
  }
}

function closeHistoryChart() {
  showHistoryChart.value = false
}

/** "Planned" icon on a planned day — switch to the builder tab pre-filled with the plan's name.
 *  Builder tab is hidden below `lg` (see nav below), so skip on phone-sized viewports.
 *
 *  The name travels via a `planName` query param rather than a template ref + setName()
 *  call: `[[tab]]` compiles `/` and `/builder` to separate route records, so navigateTo()
 *  here remounts the whole page (and WorkoutBuilderTab with it) — a ref call made right
 *  after would land on the instance that's about to be destroyed, not the one that
 *  survives. WorkoutBuilderTab reads the query itself on mount instead. */
function goToBuilder() {
  if (window.innerWidth < 1024) return
  const name = todayPlan.value?.plan?.name
  activeTab.value = 'builder'
  navigateTo({ path: '/builder', query: name ? { planName: name } : undefined })
}

function openAddWorkout() {
  pendingPrefill.value = null
  showAddWorkout.value = true
}

function closeAddWorkout() {
  showAddWorkout.value = false
}

// ── "Mark as completed" — Strava activity picker ────────────────────────
const showActivityPicker = ref(false)
const activityPickerLoading = ref(false)
const activityPickerError = ref<string | null>(null)
const recentRides = ref<StravaRideSummary[]>([])

async function onMarkCompleted() {
  showActivityPicker.value = true
  activityPickerLoading.value = true
  activityPickerError.value = null
  recentRides.value = []

  try {
    const { activities } = await $fetch<{ activities: StravaRideSummary[] }>('/api/strava/recent-rides')
    recentRides.value = activities
  }
  catch {
    activityPickerError.value = "Couldn't reach Strava. Try again in a moment."
  }
  finally {
    activityPickerLoading.value = false
  }
}

function closeActivityPicker() {
  showActivityPicker.value = false
}

/** "Xh Ym" duration display, matching WorkoutCard's formatting */
function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

function formatRideDate(startDateLocal: string): string {
  return new Date(startDateLocal).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function selectActivity(activity: StravaRideSummary) {
  pendingPrefill.value = {
    date: activity.startDateLocal.slice(0, 10),
    name: activity.name,
    durationMinutes: Math.round(activity.movingTimeSeconds / 60),
    distanceKm: Math.round((activity.distanceMeters / 1000) * 10) / 10,
    tss: todayPlan.value?.plan?.tss ?? null,
  }
  showActivityPicker.value = false
  showAddWorkout.value = true
}

// ── Lifecycle ────────────────────────────────────────────────────────────

// Initial load runs during SSR so the dashboard's first paint already has
// data — no client-side loading flash, no extra round trips after hydration.
// useRequestFetch() forwards the incoming request's session cookie, which
// plain $fetch doesn't do automatically in a server context.
const requestFetch = useRequestFetch()
await useAsyncData('dashboard-initial-load', async () => {
  await Promise.all([
    workouts.fetchPage(1, requestFetch),
    planning.fetchPlans(requestFetch),
  ])
  return true
})

// ── Actions ──────────────────────────────────────────────────────────────

/** Called after the form saves a workout — close modal and refresh list */
async function onWorkoutSaved() {
  closeAddWorkout()
  await workouts.fetchPage(1)
}

/** Called by WorkoutCard's delete event */
async function onDeleteWorkout(id: number) {
  try {
    await workouts.deleteWorkout(id)
    toast.add({ title: 'Workout deleted', color: 'success' })
  }
  catch {
    toast.add({ title: 'Could not delete workout', color: 'error' })
  }
}

/** Pagination handler */
async function onPageChange(page: number) {
  await workouts.goToPage(page)
  // Scroll to top of list on page change
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// ── Training log filter bar — UI only, not yet wired to the workout list ──
type LogFilterType = 'all' | 'zwift' | 'outdoor'
type LogPanel = null | 'type' | 'tss' | 'dist' | 'dur' | 'dates'

const logSearch = ref('')
const logFilterType = ref<LogFilterType>('all')
const logMinTSS = ref(0)
const logMinDistance = ref(0)
const logMinDuration = ref(0)
const logDateFrom = ref('')
const logDateTo = ref('')

const activeLogPanel = ref<LogPanel>(null)
const logFilterGroupRef = ref<HTMLElement | null>(null)
const draftMinTSS = ref(0)
const draftMinDistance = ref(0)
const draftMinDuration = ref(0)
const draftDateFrom = ref('')
const draftDateTo = ref('')

const hasActiveLogFilters = computed(() =>
  logSearch.value !== ''
  || logFilterType.value !== 'all'
  || logMinTSS.value > 0
  || logMinDistance.value > 0
  || logMinDuration.value > 0
  || logDateFrom.value !== ''
  || logDateTo.value !== '',
)

function formatChipDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const typeChipLabel = computed(() => {
  if (logFilterType.value === 'zwift') return 'Zwift'
  if (logFilterType.value === 'outdoor') return 'Outdoor'
  return 'Type'
})
const tssChipLabel = computed(() => logMinTSS.value > 0 ? `≥${logMinTSS.value} TSS` : 'TSS')
const distChipLabel = computed(() => logMinDistance.value > 0 ? `≥${logMinDistance.value} km` : 'Distance')
const durChipLabel = computed(() => logMinDuration.value > 0 ? `≥${logMinDuration.value} min` : 'Duration')
const datesChipLabel = computed(() => {
  if (logDateFrom.value && logDateTo.value) return `${formatChipDate(logDateFrom.value)} – ${formatChipDate(logDateTo.value)}`
  if (logDateFrom.value) return `From ${formatChipDate(logDateFrom.value)}`
  if (logDateTo.value) return `Until ${formatChipDate(logDateTo.value)}`
  return 'Dates'
})

const draftTSSLabel = computed(() => draftMinTSS.value > 0 ? `${draftMinTSS.value} TSS` : 'Any')
const draftDistLabel = computed(() => draftMinDistance.value > 0 ? `${draftMinDistance.value} km` : 'Any')
const draftDurLabel = computed(() => draftMinDuration.value > 0 ? `${draftMinDuration.value} min` : 'Any')

/** Opens a chip's panel, seeding its draft from the currently applied values; toggles closed if already open */
function toggleLogPanel(panel: Exclude<LogPanel, null>) {
  if (activeLogPanel.value === panel) {
    activeLogPanel.value = null
    return
  }
  draftMinTSS.value = logMinTSS.value
  draftMinDistance.value = logMinDistance.value
  draftMinDuration.value = logMinDuration.value
  draftDateFrom.value = logDateFrom.value
  draftDateTo.value = logDateTo.value
  activeLogPanel.value = panel
}

function closeLogPanel() {
  activeLogPanel.value = null
}

/** Type filter commits and closes immediately — no draft/Apply step */
function setLogType(type: LogFilterType) {
  logFilterType.value = type
  activeLogPanel.value = null
  applyLogFiltersToStore()
}

function applyLogPanel() {
  if (activeLogPanel.value === 'tss') logMinTSS.value = draftMinTSS.value
  else if (activeLogPanel.value === 'dist') logMinDistance.value = draftMinDistance.value
  else if (activeLogPanel.value === 'dur') logMinDuration.value = draftMinDuration.value
  else if (activeLogPanel.value === 'dates') {
    logDateFrom.value = draftDateFrom.value
    logDateTo.value = draftDateTo.value
  }
  activeLogPanel.value = null
  applyLogFiltersToStore()
}

function resetTSSDraft() {
  draftMinTSS.value = 0
}

function resetDistDraft() {
  draftMinDistance.value = 0
}

function resetDurDraft() {
  draftMinDuration.value = 0
}

function resetDatesDraft() {
  draftDateFrom.value = ''
  draftDateTo.value = ''
}

/** Clears every filter (search text, type, TSS, distance, duration, dates) and closes any open panel */
function clearLogFilters() {
  logSearch.value = ''
  logFilterType.value = 'all'
  logMinTSS.value = 0
  logMinDistance.value = 0
  logMinDuration.value = 0
  logDateFrom.value = ''
  logDateTo.value = ''
  activeLogPanel.value = null
  applyLogFiltersToStore()
}

/** Closes an open filter panel when the user clicks anywhere outside the chip group */
function onDocumentClickForLogPanel(event: MouseEvent) {
  if (activeLogPanel.value === null) return
  if (logFilterGroupRef.value && !logFilterGroupRef.value.contains(event.target as Node)) {
    activeLogPanel.value = null
  }
}

onMounted(() => document.addEventListener('click', onDocumentClickForLogPanel))
onUnmounted(() => document.removeEventListener('click', onDocumentClickForLogPanel))

// ── Push the filter bar's applied state to the store — this drives the ──────
// live list update. Search text is debounced so we don't hit the API on
// every keystroke; every other filter commits immediately (type on select,
// TSS/distance/duration/dates on Apply, everything on reset-all).
function currentLogFilters(): LogFilters {
  return {
    name: logSearch.value.trim(),
    type: logFilterType.value,
    minTss: logMinTSS.value,
    minDistance: logMinDistance.value,
    minDuration: logMinDuration.value,
    dateFrom: logDateFrom.value,
    dateTo: logDateTo.value,
  }
}

function applyLogFiltersToStore() {
  workouts.setFilters(currentLogFilters())
}

const SEARCH_DEBOUNCE_MS = 300
let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined

watch(logSearch, () => {
  clearTimeout(searchDebounceTimer)
  searchDebounceTimer = setTimeout(applyLogFiltersToStore, SEARCH_DEBOUNCE_MS)
})

onUnmounted(() => clearTimeout(searchDebounceTimer))
</script>

<template>
  <div class="min-h-screen" style="background-color: #fafaf9;">
    <title>Sprocket</title>

    <!-- ── Header + tab nav — pinned together to the top on scroll ──── -->
    <div class="sticky top-0 z-10">
      <!-- Header — minimal, borderless top bar -->
      <header class="bg-white border-b border-stone-100">
        <div class="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <span class="flex items-center gap-2.5 text-lg font-extrabold tracking-tight text-stone-900">
            <BikeLogo :size="26" class="shrink-0 text-orange-600" />
            Sprocket
          </span>
          <div class="flex items-center gap-4">
            <span class="text-sm text-stone-500 hidden sm:inline">
              {{ auth.user?.username }}
            </span>
            <button
              class="text-sm text-stone-400 hover:text-stone-700 transition-colors"
              @click="auth.logout"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <!-- Tab navigation — full-width justified bar. Workout builder needs
           real screen space for its timeline, so it's dropped below `lg`
           (covers phones in both portrait and landscape); the remaining
           3 tabs re-space evenly via grid-cols-3, going to 4-up at lg+. -->
      <nav class="grid grid-cols-3 lg:grid-cols-4 bg-white border-b border-stone-100">
        <button
          v-for="(tab, i) in tabs"
          :key="tab.id"
          class="px-2 py-3.5 text-center text-[13px] sm:text-[15px] whitespace-nowrap border-b-[3px] transition-colors"
          :class="[
            tab.id === 'builder' ? 'hidden lg:block' : '',
            i > 0 ? 'border-l border-l-[#f5f4f2]' : '',
            activeTab === tab.id
              ? 'font-bold text-stone-900 border-b-orange-600'
              : 'font-medium text-stone-500 border-b-transparent hover:text-stone-700',
          ]"
          @click="setTab(tab.id)"
        >
          {{ tab.label }}
        </button>
      </nav>
    </div>

    <!-- ── Main content ────────────────────────────────────────────── -->
    <!-- Workout builder gets a wider container so its timeline can be wider
         than the other tabs' content column; the tab itself re-narrows its
         name/stat row and toolbar row back down to match. -->
    <main
      class="mx-auto px-6 py-10 space-y-10"
      :class="activeTab === 'builder' ? 'max-w-6xl' : 'max-w-3xl'"
    >

      <!-- ── Planning tab ────────────────────────────────────────── -->
      <PlanningTab v-if="activeTab === 'planning'" />

      <!-- ── Workout builder tab ──────────────────────────────────── -->
      <WorkoutBuilderTab v-if="activeTab === 'builder'" />

      <!-- ── History tab ────────────────────────────────────────── -->
      <HistoryTab v-if="activeTab === 'history'" />

      <!-- ── Training log tab ────────────────────────────────────── -->
      <template v-if="activeTab === 'log'">

      <!-- Headline metrics strip -->
      <MetricsSummary
        :weekly-tss="workouts.weeklyStats.tssTotal"
        :weekly-hours="workouts.weeklyStats.hoursTotal"
        :weekly-km="workouts.weeklyStats.kmTotal"
        :today-c-t-l="workouts.todayMetrics.ctl"
        :today-a-t-l="workouts.todayMetrics.atl"
        :today-t-s-b="workouts.todayMetrics.tsb"
        :yesterday-c-t-l="workouts.yesterdayMetrics?.ctl"
        :yesterday-t-s-b="workouts.yesterdayMetrics?.tsb"
        @open-history="openHistoryChart"
      />

      <!-- Section header + Add button, and the content directly below it —
           grouped so their shared spacing can be tightened on narrow/vertical
           screens independently of the rest of main's space-y-10 rhythm. -->
      <div class="!mt-4 sm:!mt-10 space-y-4 sm:space-y-10">
        
      <!-- Filter bar: search + filter chips + Add workout button.
           On narrow/vertical screens this stacks into two rows: search + Add
           workout on row 1, filter chips evenly spaced on row 2. From `sm`
           up it collapses back into a single row via `sm:contents`. -->
      <div class="flex flex-col gap-2.5 sm:flex-row sm:flex-nowrap sm:items-center" style="margin: 32px 0 16px;">
        <div class="flex items-center gap-2.5 sm:contents">
          <div class="relative min-w-0 flex-1 basis-[160px] sm:order-1">
            <span class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[15px] text-stone-400">⌕</span>
            <input
              v-model="logSearch"
              type="text"
              placeholder="Search workouts…"
              class="w-full rounded-xl border-[1.5px] border-stone-200 bg-stone-50 py-3 pl-10 pr-4 text-[15px] text-stone-900 outline-none"
            >
          </div>

          <button
            class="shrink-0 rounded-xl bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-orange-600/20 transition-colors hover:bg-orange-700 sm:order-3"
            @click="openAddWorkout"
          >
            Add workout
          </button>
        </div>

        <div ref="logFilterGroupRef" class="relative flex w-full items-center justify-between gap-2 sm:order-2 sm:w-auto sm:flex-wrap sm:justify-start">
          <button
            type="button"
            :title="typeChipLabel"
            class="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border-[1.5px]"
            :class="logFilterType !== 'all'
              ? 'border-orange-300 bg-orange-50 text-orange-600'
              : 'border-stone-200 bg-white text-stone-600'"
            @click="toggleLogPanel('type')"
          >
            <UIcon name="i-heroicons-tag" class="h-4 w-4" />
          </button>
          <button
            type="button"
            :title="tssChipLabel"
            class="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border-[1.5px]"
            :class="logMinTSS > 0
              ? 'border-orange-300 bg-orange-50 text-orange-600'
              : 'border-stone-200 bg-white text-stone-600'"
            @click="toggleLogPanel('tss')"
          >
            <UIcon name="i-heroicons-bolt" class="h-4 w-4" />
          </button>
          <button
            type="button"
            :title="distChipLabel"
            class="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border-[1.5px]"
            :class="logMinDistance > 0
              ? 'border-orange-300 bg-orange-50 text-orange-600'
              : 'border-stone-200 bg-white text-stone-600'"
            @click="toggleLogPanel('dist')"
          >
            <UIcon name="i-heroicons-map-pin" class="h-4 w-4" />
          </button>
          <button
            type="button"
            :title="durChipLabel"
            class="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border-[1.5px]"
            :class="logMinDuration > 0
              ? 'border-orange-300 bg-orange-50 text-orange-600'
              : 'border-stone-200 bg-white text-stone-600'"
            @click="toggleLogPanel('dur')"
          >
            <UIcon name="i-heroicons-clock" class="h-4 w-4" />
          </button>
          <button
            type="button"
            :title="datesChipLabel"
            class="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border-[1.5px]"
            :class="(logDateFrom || logDateTo)
              ? 'border-orange-300 bg-orange-50 text-orange-600'
              : 'border-stone-200 bg-white text-stone-600'"
            @click="toggleLogPanel('dates')"
          >
            <UIcon name="i-heroicons-calendar-days" class="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Reset all filters"
            class="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-[#f5f4f2]"
            :class="hasActiveLogFilters ? 'text-stone-600' : 'text-[#cbc8c4]'"
            @click="clearLogFilters"
          >
            <UIcon name="i-heroicons-arrow-path" class="h-4 w-4" />
          </button>

          <!-- Type panel — commits and closes immediately, no draft step -->
          <div
            v-if="activeLogPanel === 'type'"
            class="absolute left-0 top-[calc(100%+8px)] z-20 w-[260px] rounded-2xl border border-[#f0eeec] bg-white p-3.5 shadow-[0_16px_40px_rgba(28,25,23,.18)]"
          >
            <button
              type="button"
              class="mb-0.5 block w-full rounded-[10px] px-3 py-2.5 text-left text-[13px] font-semibold"
              :class="logFilterType === 'all' ? 'bg-[#faf9f7] text-orange-600' : 'text-stone-600'"
              @click="setLogType('all')"
            >
              All
            </button>
            <button
              type="button"
              class="mb-0.5 block w-full rounded-[10px] px-3 py-2.5 text-left text-[13px] font-semibold"
              :class="logFilterType === 'zwift' ? 'bg-[#faf9f7] text-orange-600' : 'text-stone-600'"
              @click="setLogType('zwift')"
            >
              Zwift
            </button>
            <button
              type="button"
              class="block w-full rounded-[10px] px-3 py-2.5 text-left text-[13px] font-semibold"
              :class="logFilterType === 'outdoor' ? 'bg-[#faf9f7] text-orange-600' : 'text-stone-600'"
              @click="setLogType('outdoor')"
            >
              Outdoor
            </button>
          </div>

          <!-- TSS panel -->
          <div
            v-if="activeLogPanel === 'tss'"
            class="absolute left-0 top-[calc(100%+8px)] z-20 w-[300px] rounded-2xl border border-[#f0eeec] bg-white p-5 shadow-[0_16px_40px_rgba(28,25,23,.18)]"
          >
            <p class="mb-1 text-[15px] font-bold text-stone-900">
              Minimum TSS
            </p>
            <p class="mb-[18px] text-sm font-semibold text-orange-600">
              {{ draftTSSLabel }}
            </p>
            <input
              v-model.number="draftMinTSS"
              type="range"
              min="0"
              max="150"
              step="5"
              class="mb-5 w-full accent-orange-600"
            >
            <div class="flex items-center justify-between">
              <button
                type="button"
                class="rounded-[9px] border-[1.5px] border-orange-300 bg-white px-4 py-2.5 text-[13px] font-semibold text-orange-600"
                @click="resetTSSDraft"
              >
                Reset
              </button>
              <div class="flex gap-2.5">
                <button
                  type="button"
                  class="rounded-[9px] bg-[#f5f4f2] px-4 py-2.5 text-[13px] font-semibold text-stone-500"
                  @click="closeLogPanel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="rounded-[9px] bg-orange-600 px-[18px] py-2.5 text-[13px] font-bold text-white"
                  @click="applyLogPanel"
                >
                  Apply
                </button>
              </div>
            </div>
          </div>

          <!-- Distance panel -->
          <div
            v-if="activeLogPanel === 'dist'"
            class="absolute left-0 top-[calc(100%+8px)] z-20 w-[300px] rounded-2xl border border-[#f0eeec] bg-white p-5 shadow-[0_16px_40px_rgba(28,25,23,.18)]"
          >
            <p class="mb-1 text-[15px] font-bold text-stone-900">
              Minimum distance
            </p>
            <p class="mb-[18px] text-sm font-semibold text-orange-600">
              {{ draftDistLabel }}
            </p>
            <input
              v-model.number="draftMinDistance"
              type="range"
              min="0"
              max="60"
              step="1"
              class="mb-5 w-full accent-orange-600"
            >
            <div class="flex items-center justify-between">
              <button
                type="button"
                class="rounded-[9px] border-[1.5px] border-orange-300 bg-white px-4 py-2.5 text-[13px] font-semibold text-orange-600"
                @click="resetDistDraft"
              >
                Reset
              </button>
              <div class="flex gap-2.5">
                <button
                  type="button"
                  class="rounded-[9px] bg-[#f5f4f2] px-4 py-2.5 text-[13px] font-semibold text-stone-500"
                  @click="closeLogPanel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="rounded-[9px] bg-orange-600 px-[18px] py-2.5 text-[13px] font-bold text-white"
                  @click="applyLogPanel"
                >
                  Apply
                </button>
              </div>
            </div>
          </div>

          <!-- Duration panel -->
          <div
            v-if="activeLogPanel === 'dur'"
            class="absolute left-0 top-[calc(100%+8px)] z-20 w-[300px] rounded-2xl border border-[#f0eeec] bg-white p-5 shadow-[0_16px_40px_rgba(28,25,23,.18)]"
          >
            <p class="mb-1 text-[15px] font-bold text-stone-900">
              Minimum duration
            </p>
            <p class="mb-[18px] text-sm font-semibold text-orange-600">
              {{ draftDurLabel }}
            </p>
            <input
              v-model.number="draftMinDuration"
              type="range"
              min="0"
              max="150"
              step="5"
              class="mb-5 w-full accent-orange-600"
            >
            <div class="flex items-center justify-between">
              <button
                type="button"
                class="rounded-[9px] border-[1.5px] border-orange-300 bg-white px-4 py-2.5 text-[13px] font-semibold text-orange-600"
                @click="resetDurDraft"
              >
                Reset
              </button>
              <div class="flex gap-2.5">
                <button
                  type="button"
                  class="rounded-[9px] bg-[#f5f4f2] px-4 py-2.5 text-[13px] font-semibold text-stone-500"
                  @click="closeLogPanel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="rounded-[9px] bg-orange-600 px-[18px] py-2.5 text-[13px] font-bold text-white"
                  @click="applyLogPanel"
                >
                  Apply
                </button>
              </div>
            </div>
          </div>

          <!-- Dates panel -->
          <div
            v-if="activeLogPanel === 'dates'"
            class="absolute left-0 top-[calc(100%+8px)] z-20 w-[300px] rounded-2xl border border-[#f0eeec] bg-white p-5 shadow-[0_16px_40px_rgba(28,25,23,.18)]"
          >
            <p class="mb-4 text-[15px] font-bold text-stone-900">
              Date range
            </p>
            <div class="mb-5 flex flex-col gap-3">
              <div>
                <label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-stone-400">From</label>
                <input
                  v-model="draftDateFrom"
                  type="date"
                  class="w-full rounded-[9px] border-[1.5px] border-stone-200 bg-stone-50 px-2.5 py-2.5 text-sm text-stone-900 outline-none"
                >
              </div>
              <div>
                <label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-stone-400">To</label>
                <input
                  v-model="draftDateTo"
                  type="date"
                  class="w-full rounded-[9px] border-[1.5px] border-stone-200 bg-stone-50 px-2.5 py-2.5 text-sm text-stone-900 outline-none"
                >
              </div>
            </div>
            <div class="flex items-center justify-between">
              <button
                type="button"
                class="rounded-[9px] border-[1.5px] border-orange-300 bg-white px-4 py-2.5 text-[13px] font-semibold text-orange-600"
                @click="resetDatesDraft"
              >
                Reset
              </button>
              <div class="flex gap-2.5">
                <button
                  type="button"
                  class="rounded-[9px] bg-[#f5f4f2] px-4 py-2.5 text-[13px] font-semibold text-stone-500"
                  @click="closeLogPanel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="rounded-[9px] bg-orange-600 px-[18px] py-2.5 text-[13px] font-bold text-white"
                  @click="applyLogPanel"
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Loading state ─────────────────────────────────────────── -->
      <div v-if="workouts.isLoading" class="flex justify-center py-16">
        <BikeSpinner :size="24" class="text-stone-300" />
      </div>

      <!-- ── Error state ───────────────────────────────────────────── -->
      <UAlert
        v-else-if="workouts.error"
        color="error"
        variant="subtle"
        title="Failed to load workouts"
        :description="workouts.error"
      />

      <!-- ── Empty state — no matches for the active filters ──────────── -->
      <div
        v-else-if="workouts.days.length === 0 && hasActiveLogFilters"
        class="text-center py-20"
      >
        <p class="text-sm font-medium text-stone-500">No workouts match these filters</p>
        <p class="text-xs text-stone-400 mt-1.5">
          Try widening your date range or clearing a filter.
        </p>
      </div>

      <!-- ── Empty state — no workouts logged at all ──────────────────── -->
      <div
        v-else-if="workouts.days.length === 0"
        class="text-center py-20"
      >
        <p class="text-stone-300 text-4xl mb-4">○</p>
        <p class="text-sm font-medium text-stone-500">No workouts yet</p>
        <p class="text-xs text-stone-400 mt-1.5">
          Click "Add workout" to log your first session.
        </p>
      </div>

      <!-- ── Day list — rendered as a seamless list, not individual cards ── -->
      <div v-else class="bg-white rounded-xl border border-stone-100 overflow-hidden divide-y divide-[#f7f5f3]">
        <WorkoutCard
          v-for="day in workouts.days"
          :key="day.date"
          :day="day"
          :planned-workout="day.date === todayStr ? todayPlan : null"
          @delete="onDeleteWorkout"
          @mark-completed="onMarkCompleted"
          @go-to-builder="goToBuilder"
        />
      </div>

      </div>

      <!-- ── Pagination ────────────────────────────────────────────── -->
      <div
        v-if="workouts.pagination.totalPages > 1"
        class="flex items-center justify-center gap-6"
      >
        <button
          class="text-sm text-stone-400 hover:text-stone-700 disabled:opacity-30 transition-colors"
          :disabled="workouts.pagination.page <= 1"
          @click="onPageChange(workouts.pagination.page - 1)"
        >
          ← Newer
        </button>
        <span class="text-sm text-stone-300">
          {{ workouts.pagination.page }} / {{ workouts.pagination.totalPages }}
        </span>
        <button
          class="text-sm text-stone-400 hover:text-stone-700 disabled:opacity-30 transition-colors"
          :disabled="workouts.pagination.page >= workouts.pagination.totalPages"
          @click="onPageChange(workouts.pagination.page + 1)"
        >
          Older →
        </button>
      </div>

      <!-- Footer formula note -->
      <p class="text-center text-xs text-stone-300">
        CTL = 42-day avg &nbsp;·&nbsp; ATL = 7-day avg &nbsp;·&nbsp; TSB = CTL − ATL
      </p>

      </template><!-- end training log tab -->

    </main>

    <!-- ── Add Workout Modal ─────────────────────────────────────── -->
    <!--
      Hand-rolled modal using Teleport + v-if.
      Teleport renders the overlay in <body> so z-index is never an issue.
      A simple v-if is 100% reliable — no third-party open-state quirks.
    -->
    <Teleport to="body">
      <div
        v-if="showAddWorkout"
        class="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label="Log a workout"
      >
        <!-- Backdrop — click to dismiss -->
        <div
          class="fixed inset-0 bg-black/25 backdrop-blur-sm"
          @click="closeAddWorkout"
        />

        <!-- Panel — overflow-visible so dropdowns inside aren't clipped -->
        <div class="relative bg-white rounded-2xl shadow-xl w-full max-w-md p-6 my-8 overflow-visible">
          <!-- Header -->
          <div class="flex items-start justify-between mb-6">
            <div>
              <h2 class="text-lg font-semibold text-stone-900">Log a workout</h2>
              <p class="text-sm text-stone-400 mt-0.5">Record your training session details.</p>
            </div>
            <button
              class="text-stone-300 hover:text-stone-600 transition-colors ml-4 mt-0.5"
              aria-label="Close"
              @click="closeAddWorkout"
            >
              <UIcon name="i-heroicons-x-mark" class="w-5 h-5" />
            </button>
          </div>

          <!-- Form -->
          <AddWorkoutModal
            ref="addWorkoutForm"
            :prefill="pendingPrefill"
            @saved="onWorkoutSaved"
            @close="closeAddWorkout"
          />
        </div>
      </div>
    </Teleport>

    <!-- ── Strava Activity Picker ────────────────────────────────────── -->
    <Teleport to="body">
      <div
        v-if="showActivityPicker"
        class="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label="Pick a Strava ride"
      >
        <div
          class="fixed inset-0 bg-black/25 backdrop-blur-sm"
          @click="closeActivityPicker"
        />

        <div class="relative bg-white rounded-2xl shadow-xl w-full max-w-md p-6 my-8">
          <div class="flex items-start justify-between mb-6">
            <div>
              <h2 class="text-lg font-semibold text-stone-900">Mark as completed</h2>
              <p class="text-sm text-stone-400 mt-0.5">Pick the Strava ride that matches this workout.</p>
            </div>
            <button
              class="text-stone-300 hover:text-stone-600 transition-colors ml-4 mt-0.5"
              aria-label="Close"
              @click="closeActivityPicker"
            >
              <UIcon name="i-heroicons-x-mark" class="w-5 h-5" />
            </button>
          </div>

          <!-- Loading -->
          <div v-if="activityPickerLoading" class="flex justify-center py-10">
            <BikeSpinner :size="24" class="text-stone-300" />
          </div>

          <!-- Error -->
          <div v-else-if="activityPickerError" class="text-center py-6">
            <p class="text-sm text-stone-500">{{ activityPickerError }}</p>
            <button
              class="mt-3 text-sm font-medium text-orange-600 hover:text-orange-700"
              @click="onMarkCompleted"
            >
              Retry
            </button>
          </div>

          <!-- Empty -->
          <div v-else-if="recentRides.length === 0" class="text-center py-6">
            <p class="text-sm text-stone-500">No recent rides found on Strava.</p>
          </div>

          <!-- Activity list -->
          <ul v-else class="divide-y divide-stone-100">
            <li
              v-for="activity in recentRides"
              :key="activity.id"
              class="flex items-center justify-between gap-4 py-3"
            >
              <div class="min-w-0">
                <p class="text-sm font-medium text-stone-800 truncate">{{ activity.name }}</p>
                <p class="text-xs text-stone-400 mt-0.5">
                  {{ formatRideDate(activity.startDateLocal) }}
                  &nbsp;·&nbsp;
                  {{ formatDuration(Math.round(activity.movingTimeSeconds / 60)) }}
                  &nbsp;·&nbsp;
                  {{ (activity.distanceMeters / 1000).toFixed(1) }} km
                </p>
              </div>
              <button
                class="shrink-0 text-sm font-semibold text-orange-600 hover:text-orange-700 transition-colors"
                @click="selectActivity(activity)"
              >
                Use this
              </button>
            </li>
          </ul>
        </div>
      </div>
    </Teleport>

    <!-- ── CTL/TSB history chart ─────────────────────────────────────── -->
    <Teleport to="body">
      <div
        v-if="showHistoryChart"
        class="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label="CTL/TSB history"
      >
        <div
          class="fixed inset-0 bg-black/25 backdrop-blur-sm"
          @click="closeHistoryChart"
        />

        <div class="relative bg-white rounded-2xl shadow-xl w-full max-w-2xl p-6 my-8">
          <div class="flex items-start justify-between mb-6">
            <div>
              <h2 class="text-lg font-semibold text-stone-900">CTL / TSB history</h2>
              <p class="text-sm text-stone-400 mt-0.5">Last 8 weeks.</p>
            </div>
            <button
              class="text-stone-300 hover:text-stone-600 transition-colors ml-4 mt-0.5"
              aria-label="Close"
              @click="closeHistoryChart"
            >
              <UIcon name="i-heroicons-x-mark" class="w-5 h-5" />
            </button>
          </div>

          <div v-if="historyLoading" class="flex justify-center py-16">
            <BikeSpinner :size="24" class="text-stone-300" />
          </div>
          <MetricsHistoryChart v-else :series="historySeries" />
        </div>
      </div>
    </Teleport>

  </div>
</template>
