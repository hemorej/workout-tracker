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
import { useWorkoutsStore, type LogFilters, type WorkoutDetail, type WorkoutFitData, type WorkoutLap, type DayEntry } from '~/stores/workouts'
import { usePlanningStore } from '~/stores/planning'
import { useCoachStore, type CoachWorkout } from '~/stores/coach'
import type { WorkoutPrefill } from '~/components/AddWorkoutModal.vue'

interface StravaRideSummary {
  id: number
  name: string
  startDateLocal: string
  movingTimeSeconds: number
  distanceMeters: number
  rideType: 'trainer' | 'outdoor'
}

/** Shape shared by both FIT-parsing endpoints (Wahoo by-date and manual upload). */
interface ParsedFitPrefill {
  tss: number
  powerBests: { duration: string, watts: number }[]
  durationSeconds: number
  distanceMeters: number
  fitData: WorkoutFitData
  laps: WorkoutLap[] | null
}

interface WahooByDateResponse extends ParsedFitPrefill {
  ride: { startDateLocal: string }
}

// Protect this page — unauthenticated users are sent to /login
definePageMeta({ middleware: 'auth' })

// ── Tab navigation ────────────────────────────────────────────────────────
// This page matches both `/` and `/:tab` (optional catch-all route file
// `[[tab]].vue`), so the active tab is driven by the URL — `/planning` loads
// straight into the planning tab, and clicking a tab pushes a matching URL.
const tabs = [
  { id: 'log', label: 'Training log', title: 'Training Log' },
  { id: 'planning', label: 'Planning', title: 'Planning' },
  { id: 'builder', label: 'Workout builder', title: 'Workout Builder' },
  { id: 'history', label: 'History', title: 'History' },
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

useHead({
  title: computed(() => tabs.find(t => t.id === activeTab.value)?.title ?? 'Training Log'),
})

/** Sets the active tab and pushes the matching URL (`/` for the default log tab) */
function setTab(id: TabId) {
  activeTab.value = id
  navigateTo(id === 'log' ? '/' : `/${id}`)
}

const auth = useAuthStore()
const workouts = useWorkoutsStore()
const planning = usePlanningStore()
const coach = useCoachStore()
const toast = useToast()

// Today's date as YYYY-MM-DD (local time, matches DayEntry.date format)
const todayStr = computed(() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})

/** Today's date split for the fixed date cell: weekday ("Mon") + rest (", Aug 31") */
const todayWeekday = computed(() =>
  new Date().toLocaleDateString('en-US', { weekday: 'short' }),
)
const todayDatePart = computed(() =>
  new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
)

/**
 * The standalone date cell is `position: fixed` (stays put while the page
 * scrolls). Its initial `top` is set once to line up with the headline
 * metrics card's top edge — recomputed on resize / tab change but NOT on
 * scroll, so it doesn't drift upward with the page.
 */
const headlineRef = ref<HTMLElement | null>(null)
const dateCellTop = ref(0)
const syncDateCellTop = () => {
  if (headlineRef.value) {
    dateCellTop.value = headlineRef.value.getBoundingClientRect().top + window.scrollY
  }
}
onMounted(() => {
  syncDateCellTop()
  window.addEventListener('resize', syncDateCellTop)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', syncDateCellTop)
})
watch(() => activeTab.value, () => nextTick(syncDateCellTop))

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
// Set only by the "refresh ride data" flow — when non-null, the Add Workout
// modal opens in edit mode (PATCH this workout) instead of create mode.
const editingWorkoutId = ref<number | null>(null)
// Distinguishes the two ways the Add Workout modal enters edit mode: after a
// FIT re-parse ('refresh' — "Review refreshed ride data") vs. a plain manual
// "Edit ride" ('manual' — "Edit ride"). Only affects header copy.
const editModalMode = ref<'refresh' | 'manual'>('refresh')

// ── User settings modal (weight + training plan) ─────────────────────────
const showUserSettings = ref(false)

function openUserSettings() {
  showUserSettings.value = true
}

function closeUserSettings() {
  showUserSettings.value = false
}

// ── Ride stats overlay ("brief ride stats" on a logged workout's title) ──
const fitOverlayWorkout = ref<WorkoutDetail | null>(null)

function openFitOverlay(day: DayEntry) {
  fitOverlayWorkout.value = day.workout
}

function closeFitOverlay() {
  fitOverlayWorkout.value = null
}

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

// ── "Auto-build" — AI-generated workout via the coach endpoint ───────────
// Only today's row can ever show the Planned pill (plannedWorkout is only
// passed for day.date === todayStr, see the WorkoutCard usage below), so a
// single flag is enough — no per-row keying needed.
const isAutoBuilding = ref(false)

// Guards against an accidental tab close/refresh while the request is in
// flight — the overlay above already blocks in-app navigation.
function preventUnloadDuringAutoBuild(e: BeforeUnloadEvent) {
  e.preventDefault()
}

async function onAutoBuild() {
  if (window.innerWidth < 1024) return
  isAutoBuilding.value = true
  window.addEventListener('beforeunload', preventUnloadDuringAutoBuild)
  try {
    const workout = await $fetch<CoachWorkout>('/api/coach/generate', { method: 'POST' })
    coach.setPendingWorkout(workout)
    // Don't set activeTab.value = 'builder' here: `/` and `/builder` are separate
    // route records (see coach.ts), so that would synchronously mount a throwaway
    // WorkoutBuilderTab on the current page that immediately consumes and clears
    // the pending workout before the real navigation/remount even happens. The
    // watch(routeTab, ...) above syncs activeTab once navigateTo() actually lands.
    navigateTo({ path: '/builder' })
  }
  catch {
    toast.add({
      title: "Couldn't generate a workout",
      description: 'Make sure a training plan is set for your account, then try again.',
      color: 'error',
    })
  }
  finally {
    isAutoBuilding.value = false
    window.removeEventListener('beforeunload', preventUnloadDuringAutoBuild)
  }
}

function openAddWorkout() {
  pendingPrefill.value = null
  editingWorkoutId.value = null
  showAddWorkout.value = true
}

function closeAddWorkout() {
  showAddWorkout.value = false
  editingWorkoutId.value = null
  editModalMode.value = 'refresh'
}

// ── "Mark as completed" — Strava activity picker ─────────────────────────
// The picker lists Strava activities (title + day are reliable there for
// both outdoor and Zwift rides); the actual ride data (duration, distance,
// TSS, power bests) always comes from a parsed FIT file, sourced from Wahoo
// for outdoor rides or a manual upload for indoor/virtual ones — Wahoo never
// has a FIT file for Zwift activities (see CLAUDE.md). Strava's own
// NP/TSS numbers are never used.
const showActivityPicker = ref(false)
const activityPickerLoading = ref(false)
const activityPickerError = ref<string | null>(null)
const recentRides = ref<StravaRideSummary[]>([])
// Set to the ride being resolved (Wahoo FIT download + parse) while the user
// waits to enter the Add Workout modal — used to show a per-row loading
// state and block picking a second ride mid-fetch.
const resolvingActivityId = ref<number | null>(null)

// Picker switches into this mode when an indoor/virtual ride is picked —
// Wahoo has no FIT file for it, so we need the user to upload their local one.
const activityPickerMode = ref<'list' | 'upload'>('list')
/** Just the subset of StravaRideSummary the upload step needs — the "refresh ride data"
 *  flow (below) has no Strava activity, only an existing WorkoutDetail, and synthesizes one. */
interface UploadTarget {
  name: string
  rideType: 'trainer' | 'outdoor'
  startDateLocal: string
  /** Absent for the "refresh ride data" flow, which synthesizes an UploadTarget with no Strava activity. */
  id?: number
}
const pendingUploadActivity = ref<UploadTarget | null>(null)
const isUploadingFit = ref(false)
const uploadError = ref<string | null>(null)
const fitFileInput = ref<HTMLInputElement | null>(null)

// Whether the (shared) activity picker is being driven by "Mark as completed"
// (creates a new workout) or by a per-row "Refresh ride data" click (re-parses
// FIT data for an existing workout, then reopens Add Workout in edit mode).
const pickerPurpose = ref<'create' | 'refresh'>('create')
const refreshTargetWorkout = ref<WorkoutDetail | null>(null)
// Per-row loading state for the outdoor "refresh ride data" fetch (mirrors
// resolvingActivityId above, but keyed by workout id instead of Strava activity id).
const refreshingWorkoutId = ref<number | null>(null)

async function onMarkCompleted() {
  pickerPurpose.value = 'create'
  refreshTargetWorkout.value = null
  showActivityPicker.value = true
  activityPickerMode.value = 'list'
  pendingUploadActivity.value = null
  uploadError.value = null
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
  activityPickerMode.value = 'list'
  pendingUploadActivity.value = null
  uploadError.value = null
  pickerPurpose.value = 'create'
  refreshTargetWorkout.value = null
}

function backToActivityList() {
  activityPickerMode.value = 'list'
  pendingUploadActivity.value = null
  uploadError.value = null
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

/** Builds a fallback prefill straight from Strava's summary data, used when FIT parsing fails. */
function fallbackPrefillFromStrava(activity: StravaRideSummary): WorkoutPrefill {
  return {
    date: activity.startDateLocal.slice(0, 10),
    name: activity.name,
    durationMinutes: Math.round(activity.movingTimeSeconds / 60),
    distanceKm: activity.distanceMeters > 0 ? Math.round((activity.distanceMeters / 1000) * 10) / 10 : null,
    tss: todayPlan.value?.plan?.tss ?? null,
    rideType: activity.rideType,
    stravaActivityId: activity.id,
  }
}

function prefillFromParsedFit(activity: UploadTarget, parsed: ParsedFitPrefill): WorkoutPrefill {
  return {
    date: activity.startDateLocal.slice(0, 10),
    name: activity.name, // title always comes from Strava, e.g. "Morning Ride", "Zwift - 3x4"
    durationMinutes: Math.round(parsed.durationSeconds / 60),
    distanceKm: parsed.distanceMeters > 0 ? Math.round((parsed.distanceMeters / 1000) * 10) / 10 : null,
    tss: parsed.tss,
    rideType: activity.rideType,
    powerBests: parsed.powerBests,
    fitData: parsed.fitData,
    laps: parsed.laps,
    stravaActivityId: activity.id ?? null,
  }
}

/**
 * Outdoor rides: fetches the matching Wahoo workout's FIT file (matched by
 * calendar day — see server/utils/wahoo.ts) and parses it before opening the
 * Add Workout modal, so TSS/power bests arrive already filled in —
 * AddWorkoutModal only reads `prefill` once at mount, so this has to resolve
 * before `showAddWorkout` flips to true, not after.
 *
 * Indoor/virtual rides (Zwift etc.) never have a FIT file on Wahoo, so this
 * instead switches the picker into upload mode and waits for the user to
 * supply their local FIT file via onFitFileSelected.
 *
 * Falls back to a base prefill (no TSS/power bests) if the FIT file can't be
 * read, rather than blocking the user from logging the ride manually.
 */
async function selectActivity(activity: StravaRideSummary) {
  if (activity.rideType === 'trainer') {
    pendingUploadActivity.value = activity
    activityPickerMode.value = 'upload'
    return
  }

  resolvingActivityId.value = activity.id

  try {
    const date = activity.startDateLocal.slice(0, 10)
    const detail = await $fetch<WahooByDateResponse>('/api/wahoo/by-date', { query: { date } })
    pendingPrefill.value = prefillFromParsedFit(activity, detail)
  }
  catch {
    toast.add({
      title: "Couldn't read power data",
      description: "This ride's Wahoo FIT file couldn't be found or parsed — fill in TSS and power bests manually.",
      color: 'warning',
    })
    pendingPrefill.value = fallbackPrefillFromStrava(activity)
  }
  finally {
    resolvingActivityId.value = null
  }

  showActivityPicker.value = false
  showAddWorkout.value = true
}

/** Called when the user picks a local FIT file in upload mode (indoor/virtual rides). */
async function onFitFileSelected(event: Event) {
  const activity = pendingUploadActivity.value
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!activity || !file) return

  isUploadingFit.value = true
  uploadError.value = null

  try {
    const formData = new FormData()
    formData.append('file', file)
    const parsed = await $fetch<ParsedFitPrefill>('/api/fit/upload', { method: 'POST', body: formData })
    if (pickerPurpose.value === 'refresh') {
      openEditModalFromRefresh(prefillFromParsedFit(activity, parsed))
    }
    else {
      pendingPrefill.value = prefillFromParsedFit(activity, parsed)
      showActivityPicker.value = false
      showAddWorkout.value = true
    }
  }
  catch (err: unknown) {
    uploadError.value = (err as { data?: { statusMessage?: string } })?.data?.statusMessage
      ?? "Couldn't parse that FIT file."
  }
  finally {
    isUploadingFit.value = false
    // Reset so picking the same file again still fires a change event.
    if (fitFileInput.value) fitFileInput.value.value = ''
  }
}

/** Skips FIT parsing entirely and opens Add Workout pre-filled from Strava's summary data only. */
function skipUploadAndEnterManually() {
  if (!pendingUploadActivity.value) return
  pendingPrefill.value = fallbackPrefillFromStrava(pendingUploadActivity.value as StravaRideSummary)
  showActivityPicker.value = false
  showAddWorkout.value = true
}

/**
 * "Refresh ride data" — re-runs the outdoor(Wahoo)/indoor(upload) FIT flow
 * above against an *existing* logged workout instead of creating a new one,
 * then opens Add Workout in edit mode so the user can review before saving
 * (see CLAUDE.md's Completed-workout picker / PATCH /api/workouts/:id).
 * Skips the Strava activity-list step entirely — the workout's own date and
 * rideType already tell us what to fetch, no need to pick which activity.
 */
async function onRefreshRideData(day: DayEntry, opts: { forceUpload?: boolean } = {}) {
  const workout = day.workout
  if (!workout) return

  pickerPurpose.value = 'refresh'
  refreshTargetWorkout.value = workout

  // forceUpload: the "Re-upload FIT file" action — always go to the manual
  // upload prompt regardless of ride type. Trainer rides always take this
  // path anyway (no Wahoo FIT file to fetch).
  if (opts.forceUpload || workout.rideType === 'trainer') {
    pendingUploadActivity.value = {
      name: workout.name,
      rideType: workout.rideType ?? 'outdoor',
      startDateLocal: day.date,
    }
    activityPickerMode.value = 'upload'
    uploadError.value = null
    showActivityPicker.value = true
    return
  }

  refreshingWorkoutId.value = workout.id
  try {
    const detail = await $fetch<WahooByDateResponse>('/api/wahoo/by-date', { query: { date: day.date } })
    openEditModalFromRefresh(prefillFromParsedFit({ name: workout.name, rideType: 'outdoor', startDateLocal: day.date }, detail))
  }
  catch {
    toast.add({
      title: "Couldn't read power data",
      description: "This ride's Wahoo FIT file couldn't be found or parsed.",
      color: 'warning',
    })
    pickerPurpose.value = 'create'
    refreshTargetWorkout.value = null
  }
  finally {
    refreshingWorkoutId.value = null
  }
}

/** Opens Add Workout in edit mode for the workout being refreshed, keeping its
 *  name/notes/RPE/FTP as-is and overwriting tss/duration/distance/powerBests/fitData
 *  with the freshly parsed values (still user-editable before saving). */
function openEditModalFromRefresh(parsedPrefill: WorkoutPrefill) {
  const workout = refreshTargetWorkout.value
  if (!workout) return

  pendingPrefill.value = {
    ...parsedPrefill,
    name: workout.name,
    notes: workout.notes,
    rpe: workout.rpe,
    ftpWatts: workout.ftpWatts,
  }
  editingWorkoutId.value = workout.id
  editModalMode.value = 'refresh'
  showActivityPicker.value = false
  showAddWorkout.value = true
  pickerPurpose.value = 'create'
  refreshTargetWorkout.value = null
}

/**
 * "Edit ride" — opens Add Workout in edit mode seeded straight from the
 * existing workout, with NO FIT re-parse or network call. Lets the user fix
 * the title, TSS, or any other field by hand. fitData/laps/stravaActivityId
 * ride through the prefill untouched (PATCH ignores stravaActivityId).
 */
function onEditWorkout(day: DayEntry) {
  const w = day.workout
  if (!w) return

  pendingPrefill.value = {
    date: day.date,
    name: w.name,
    durationMinutes: w.durationMinutes,
    distanceKm: w.distanceKm,
    tss: w.tss,
    rpe: w.rpe,
    rideType: w.rideType,
    notes: w.notes,
    ftpWatts: w.ftpWatts,
    powerBests: w.powerBests,
    fitData: w.fitData,
    laps: w.laps,
    stravaActivityId: w.stravaActivityId,
  }
  editingWorkoutId.value = w.id
  editModalMode.value = 'manual'
  showAddWorkout.value = true
}

/** "Re-upload FIT file" — the manual-upload branch of the refresh flow for any ride type. */
function onReuploadFit(day: DayEntry) {
  return onRefreshRideData(day, { forceUpload: true })
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
  // AddWorkoutModal's own submit already refetches via workoutsStore
  // (updateWorkout stays on the current page; the plain POST path below
  // still needs an explicit refresh since it calls $fetch directly).
  const wasEdit = editingWorkoutId.value !== null
  closeAddWorkout()
  if (!wasEdit) await workouts.fetchPage(1)
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

// ── Keyboard shortcut: Alt/Option+1..4 jumps to the matching tab ────────────
// Cmd/Ctrl+1..4 is reserved by Chrome/Safari for switching browser tabs and
// can't be reliably intercepted from page JS, so Alt is used instead.
function onKeydownTabShortcut(event: KeyboardEvent) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  // On macOS, Option+digit produces a special character in `event.key`
  // (e.g. Option+2 → '™'), so read the physical key via `event.code` instead.
  const match = /^Digit(\d)$/.exec(event.code)
  if (!match) return
  const index = Number(match[1]) - 1
  if (!Number.isInteger(index) || index < 0 || index >= tabs.length) return
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  event.preventDefault()
  setTab(tabs[index]!.id)
}

onMounted(() => document.addEventListener('keydown', onKeydownTabShortcut))
onUnmounted(() => document.removeEventListener('keydown', onKeydownTabShortcut))

// ── Sticky header height ─────────────────────────────────────────────────────
// Exposes the pinned header+tab-nav bar's height as a CSS var so other sticky
// elements further down the page (e.g. planning week labels) can offset below it.

const stickyBar = ref<HTMLElement | null>(null)
let stickyBarObserver: ResizeObserver | undefined

function updateStickyBarHeight() {
  if (stickyBar.value) {
    document.documentElement.style.setProperty('--app-sticky-h', `${stickyBar.value.offsetHeight}px`)
  }
}

onMounted(() => {
  updateStickyBarHeight()
  stickyBarObserver = new ResizeObserver(updateStickyBarHeight)
  if (stickyBar.value) stickyBarObserver.observe(stickyBar.value)
})
onUnmounted(() => stickyBarObserver?.disconnect())

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
    <!-- ── Auto-build overlay — blocks the page while the AI coach generates
         a workout, so an accidental click/back-nav can't interrupt the
         in-flight request before it lands in the builder ──────────────── -->
    <div
      v-if="isAutoBuilding"
      class="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Building your workout"
    >
      <!-- Backdrop — no click-to-dismiss: the overlay stays until the request lands -->
      <div class="fixed inset-0 bg-black/25 backdrop-blur-sm" />

      <div class="relative bg-white rounded-2xl shadow-xl w-full max-w-xs aspect-square my-8 p-6 flex flex-col items-center justify-center gap-5">
        <BikeSpinner :size="72" class="text-orange-600" />
        <p class="text-sm font-medium text-stone-500">Building your workout…</p>
      </div>
    </div>

    <!-- ── Header + tab nav — pinned together to the top on scroll ──── -->
    <div ref="stickyBar" class="sticky top-0 z-10">
      <!-- Header — minimal, borderless top bar -->
      <header class="bg-white border-b border-stone-100">
        <div class="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <span class="flex items-center gap-2.5 text-lg font-extrabold tracking-tight text-stone-900">
            <BikeLogo :size="26" class="shrink-0 text-orange-600" />
            Sprocket
          </span>
          <div class="flex items-center gap-4">
            <button
              class="text-sm text-stone-500 hidden sm:inline hover:text-stone-800 transition-colors"
              @click="openUserSettings"
            >
              {{ auth.user?.username }}
            </button>
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

      <!-- Standalone "today's date" cell — styled like a MetricsSummary
           headline cell but detached from that card and pinned to the left
           edge of the viewport. Hidden below xl where there's no room. -->
      <div
        class="hidden xl:block fixed left-6 z-10 pt-6"
        :style="{ top: dateCellTop + 'px' }"
      >
        <p class="text-[11px] font-semibold uppercase tracking-[0.13em] text-stone-400 mb-2.5">
          Today
        </p>
        <p class="text-[27px] font-bold text-stone-900 tabular whitespace-nowrap">
          <span class="text-primary">{{ todayWeekday }}</span> {{ todayDatePart }}
        </p>
      </div>

      <!-- Headline metrics strip -->
      <div ref="headlineRef">
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
      </div>

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
          :is-auto-building="isAutoBuilding"
          :is-refreshing-ride-data="refreshingWorkoutId !== null && day.workout?.id === refreshingWorkoutId"
          @delete="onDeleteWorkout"
          @mark-completed="onMarkCompleted"
          @go-to-builder="goToBuilder"
          @auto-build="onAutoBuild"
          @open-fit-overlay="openFitOverlay(day)"
          @refresh-ride-data="onRefreshRideData(day)"
          @edit="onEditWorkout(day)"
          @reupload-fit="onReuploadFit(day)"
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
              <h2 class="text-lg font-semibold text-stone-900">
                {{ !editingWorkoutId ? 'Log a workout' : (editModalMode === 'manual' ? 'Edit ride' : 'Review refreshed ride data') }}
              </h2>
              <p class="text-sm text-stone-400 mt-0.5">
                {{ !editingWorkoutId ? 'Record your training session details.' : (editModalMode === 'manual' ? 'Update any field, then save.' : 'Confirm the freshly parsed values before saving.') }}
              </p>
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
            :edit-workout-id="editingWorkoutId"
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
              <h2 class="text-lg font-semibold text-stone-900">
                {{ pickerPurpose === 'refresh' ? 'Refresh ride data' : 'Mark as completed' }}
              </h2>
              <p class="text-sm text-stone-400 mt-0.5">
                {{ activityPickerMode === 'list' ? 'Pick the Strava ride that matches this workout.' : 'Upload the FIT file for this ride.' }}
              </p>
            </div>
            <button
              class="text-stone-300 hover:text-stone-600 transition-colors ml-4 mt-0.5"
              aria-label="Close"
              @click="closeActivityPicker"
            >
              <UIcon name="i-heroicons-x-mark" class="w-5 h-5" />
            </button>
          </div>

          <template v-if="activityPickerMode === 'list'">
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
                    <span v-if="activity.rideType === 'trainer'">&nbsp;·&nbsp;Indoor</span>
                  </p>
                </div>
                <button
                  class="shrink-0 flex items-center gap-2 text-sm font-semibold text-orange-600 hover:text-orange-700 transition-colors disabled:opacity-50"
                  :disabled="resolvingActivityId !== null"
                  @click="selectActivity(activity)"
                >
                  <BikeSpinner v-if="resolvingActivityId === activity.id" :size="14" />
                  {{ resolvingActivityId === activity.id ? 'Reading FIT file…' : 'Use this' }}
                </button>
              </li>
            </ul>
          </template>

          <!-- Upload mode — indoor/virtual rides have no FIT file on Wahoo -->
          <template v-else>
            <div class="text-center py-4">
              <p class="text-sm text-stone-600 mb-1">
                <span class="font-medium text-stone-800">{{ pendingUploadActivity?.name }}</span>
                doesn't have a FIT file on Wahoo (Zwift/virtual rides never do).
              </p>
              <p class="text-xs text-stone-400 mb-6">
                Upload the FIT file saved by your trainer app to fill in TSS and power bests automatically.
              </p>

              <input
                ref="fitFileInput"
                type="file"
                accept=".fit"
                class="hidden"
                @change="onFitFileSelected"
              >

              <UButton
                :loading="isUploadingFit"
                :disabled="isUploadingFit"
                class="rounded-lg font-semibold"
                @click="fitFileInput?.click()"
              >
                {{ isUploadingFit ? 'Reading FIT file…' : 'Choose FIT file' }}
              </UButton>

              <p v-if="uploadError" class="text-xs text-rose-400 mt-3">{{ uploadError }}</p>

              <div v-if="pickerPurpose === 'create'" class="flex justify-center gap-4 mt-5">
                <button
                  type="button"
                  class="text-xs font-medium text-stone-400 hover:text-stone-600 transition-colors"
                  @click="backToActivityList"
                >
                  ← Back
                </button>
                <button
                  type="button"
                  class="text-xs font-medium text-stone-400 hover:text-stone-600 transition-colors"
                  @click="skipUploadAndEnterManually"
                >
                  Skip, enter manually
                </button>
              </div>
            </div>
          </template>
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

    <!-- ── User settings (weight + training plan) ────────────────────── -->
    <Teleport to="body">
      <div
        v-if="showUserSettings"
        class="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label="User settings"
      >
        <div
          class="fixed inset-0 bg-black/25 backdrop-blur-sm"
          @click="closeUserSettings"
        />

        <div class="relative bg-white rounded-2xl shadow-xl w-full max-w-md p-6 my-8">
          <div class="flex items-start justify-between mb-6">
            <div>
              <h2 class="text-lg font-semibold text-stone-900">Settings</h2>
              <p class="text-sm text-stone-400 mt-0.5">Weight and training plan used by the AI coach.</p>
            </div>
            <button
              class="text-stone-300 hover:text-stone-600 transition-colors ml-4 mt-0.5"
              aria-label="Close"
              @click="closeUserSettings"
            >
              <UIcon name="i-heroicons-x-mark" class="w-5 h-5" />
            </button>
          </div>

          <UserSettingsModal @saved="closeUserSettings" @close="closeUserSettings" />
        </div>
      </div>
    </Teleport>

    <!-- ── Ride stats overlay ─────────────────────────────────────────── -->
    <WorkoutFitOverlay :workout="fitOverlayWorkout" @close="closeFitOverlay" />

  </div>
</template>
