<script setup lang="ts">
/**
 * Dashboard shell — the app's only authenticated page.
 *
 * Matches `/` and `/:tab` (optional catch-all), so the URL drives the active
 * tab: Training (`/`), Workout builder (`/builder`), History (`/history`).
 * Alt/Option+1..3 jump between tabs; the retired `/planning` slug redirects to
 * `/`. Switching tabs remounts the page, which is why cross-tab hand-offs go
 * through Pinia stores (`coach`, `zwiftLibrary`).
 *
 * The Training tab is the TrainingTab component; this file owns the flows it
 * launches (it emits `DayAction`s):
 *  - "Mark as completed" — Strava activity picker → FIT from Wahoo (outdoor)
 *    or manual upload (indoor) → AddWorkoutModal prefill; "Refresh ride data"
 *    re-runs that for an existing workout (PATCH)
 *  - "Build workout" — AI coach (POST /api/coach/generate) → builder tab
 *  - ride-stats overlay (fitData/laps loaded on demand), CTL/TSB history
 *    chart modal, user settings modal
 *
 * The other tabs are components (WorkoutBuilderTab, HistoryTab). The initial
 * training load runs during SSR when the Training tab is the one being opened.
 */

import { useAuthStore } from '~/stores/auth'
import { useTrainingStore } from '~/stores/training'
import type { TrainingDay, WorkoutDetail, WorkoutFitData, WorkoutLap } from '#shared/types/training'
import { useCoachStore, type CoachWorkout } from '~/stores/coach'
import type { WorkoutPrefill } from '~/components/AddWorkoutModal.vue'

interface StravaRideSummary {
  id: string
  name: string
  startDateLocal: string
  startDate: string
  movingTimeSeconds: number
  distanceMeters: number
  rideType: 'trainer' | 'outdoor'
}

/** Shape shared by both FIT-parsing endpoints (Wahoo by-date and manual upload). */
interface ParsedFitPrefill {
  tss: number
  powerBests: { duration: string, watts: number }[]
  powerCurve: { duration: string, watts: number }[]
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
// `[[tab]].vue`), so the active tab is driven by the URL — `/builder` loads
// straight into the builder, and clicking a tab pushes a matching URL.
const tabs = [
  { id: 'training', label: 'Training', mobileLabel: 'Training', title: 'Training' },
  { id: 'builder', label: 'Workout builder', mobileLabel: 'Builder', title: 'Workout Builder' },
  { id: 'history', label: 'History', mobileLabel: 'History', title: 'History' },
] as const

type TabId = typeof tabs[number]['id']
const tabIds = tabs.map(t => t.id)

const route = useRoute()
const routeParam = computed(() => {
  const param = route.params.tab
  return Array.isArray(param) ? param[0] : param
})
const routeTab = computed<TabId>(() => (tabIds.includes(routeParam.value as TabId) ? routeParam.value as TabId : 'training'))

// The old Planning (and explicit Training log) slugs now live in the Training tab.
if (routeParam.value === 'planning' || routeParam.value === 'log') await navigateTo({ path: '/', query: route.query }, { replace: true })

const activeTab = ref<TabId>(routeTab.value)
watch(routeTab, (tab) => { activeTab.value = tab })

const showTodaysEvents = ref(false)

/** Content column width per tab (also used by the header so it lines up). */
const contentWidth = computed(() => ({
  training: 'max-w-[1040px]',
  builder: 'max-w-6xl',
  history: 'max-w-3xl',
})[activeTab.value])

useHead({
  title: computed(() => tabs.find(t => t.id === activeTab.value)?.title ?? 'Training'),
})

/** Sets the active tab and pushes the matching URL (`/` for the default Training tab) */
function setTab(id: TabId) {
  activeTab.value = id
  navigateTo(id === 'training' ? '/' : `/${id}`)
}

const auth = useAuthStore()
const training = useTrainingStore()
const coach = useCoachStore()
const toast = useToast()

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

// The list omits the heavy fitData/laps JSONB, so fetch them on demand and
// open the overlay once they're in (a single-row lookup, so near-instant).
async function openFitOverlay(day: TrainingDay) {
  if (!day.ride) return
  try {
    const detail = await $fetch<{ fitData: WorkoutFitData | null, laps: WorkoutLap[] | null }>(
      `/api/workouts/${day.ride.id}`,
    )
    fitOverlayWorkout.value = { ...day.ride, ...detail }
  }
  catch {
    toast.add({ title: 'Couldn\'t load ride stats', color: 'error' })
  }
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

// ── "Auto-build" — AI-generated workout via the coach endpoint ───────────
const isAutoBuilding = ref(false)

// Guards against an accidental tab close/refresh while the request is in
// flight — the overlay above already blocks in-app navigation.
function preventUnloadDuringAutoBuild(e: BeforeUnloadEvent) {
  e.preventDefault()
}

async function onAutoBuild(date: string) {
  isAutoBuilding.value = true
  window.addEventListener('beforeunload', preventUnloadDuringAutoBuild)
  try {
    const workout = await $fetch<CoachWorkout>('/api/coach/generate', {
      method: 'POST',
      query: { date },
    })
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

/** Opens the Add workout form, optionally on a given day. */
function openAddWorkout(date?: string) {
  pendingPrefill.value = date ? { date } : null
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
const resolvingActivityId = ref<string | null>(null)

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
  id?: string
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

/**
 * Formats a Strava ride's start time in the viewer's local timezone. Takes the
 * true UTC instant (`startDate`) — not `startDateLocal`, whose trailing "Z" is
 * bogus (it's already athlete-local wall-clock) and which renders as UTC on a
 * UTC host.
 */
function formatRideDate(startDate: string): string {
  return new Date(startDate).toLocaleString('en-US', {
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
    tss: training.days.find(d => d.date === activity.startDateLocal.slice(0, 10))?.plan?.tss ?? null,
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
    powerCurve: parsed.powerCurve,
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
    formData.append('date', activity.startDateLocal.slice(0, 10))
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
async function onRefreshRideData(day: TrainingDay, opts: { forceUpload?: boolean } = {}) {
  const workout = day.ride
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
function onEditWorkout(day: TrainingDay) {
  const w = day.ride
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
function onReuploadFit(day: TrainingDay) {
  return onRefreshRideData(day, { forceUpload: true })
}

// ── Lifecycle ────────────────────────────────────────────────────────────

// The Training tab's first load runs during SSR so its first paint already has
// data. useRequestFetch() forwards the incoming request's session cookie, which
// plain $fetch doesn't do in a server context. Other tabs load their own data.
if (routeTab.value === 'training') {
  const requestFetch = useRequestFetch()
  await useAsyncData('training-initial-load', async () => {
    await training.fetchInitial(requestFetch)
    return true
  })
}

// ── Actions ──────────────────────────────────────────────────────────────

/** The add/edit form saved a ride — the store already refreshed, so just close it. */
function onWorkoutSaved() {
  closeAddWorkout()
}

async function onDeleteWorkout(id: number) {
  try {
    await training.deleteWorkout(id)
    toast.add({ title: 'Workout deleted', color: 'success' })
  }
  catch {
    toast.add({ title: 'Could not delete workout', color: 'error' })
  }
}

/** Day-card actions that need this page's modals and flows. */
function onDayAction(action: PageAction) {
  switch (action.type) {
    case 'open-fit': return openFitOverlay(action.day)
    case 'edit': return onEditWorkout(action.day)
    case 'reupload-fit': return onReuploadFit(action.day)
    case 'refresh-ride': return onRefreshRideData(action.day)
    case 'delete-ride': return onDeleteWorkout(action.day.ride!.id)
    case 'mark-completed': return onMarkCompleted()
    case 'add-workout': return openAddWorkout(action.date)
    case 'build-workout': return onAutoBuild(action.date)
  }
}

// ── Keyboard shortcut: Alt/Option+1..3 jumps to the matching tab ────────────
// Cmd/Ctrl+1..3 is reserved by Chrome/Safari for switching browser tabs and
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
// elements further down the page (e.g. the Training grid's day header) can offset below it.

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
        <div class="mx-auto px-6 py-4 flex items-center justify-between" :class="contentWidth">
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

      <!-- Tab navigation — full-width justified bar -->
      <nav class="grid grid-cols-3 bg-white border-b border-stone-100">
        <button
          v-for="(tab, i) in tabs"
          :key="tab.id"
          class="px-2 py-3.5 text-center text-[13px] sm:text-[15px] whitespace-nowrap border-b-[3px] transition-colors"
          :class="[
            i > 0 ? 'border-l border-l-[#f5f4f2]' : '',
            activeTab === tab.id
              ? 'font-bold text-stone-900 border-b-orange-600'
              : 'font-medium text-stone-500 border-b-transparent hover:text-stone-700',
          ]"
          @click="setTab(tab.id)"
        >
          <span class="sm:hidden">{{ tab.mobileLabel }}</span><span class="hidden sm:inline">{{ tab.label }}</span>
        </button>
      </nav>
    </div>

    <!-- ── Main content ────────────────────────────────────────────── -->
    <!-- The Training grid and the workout builder get wider containers than the
         History column; the builder re-narrows its own name/stat row and toolbar. -->
    <main class="mx-auto px-6 py-6 sm:py-10" :class="contentWidth">
      <!-- `Lazy` prefix + `v-if`: each non-default tab's chunk is only fetched
           the first time that tab is opened. WorkoutBuilderTab in particular
           is ~1.3k lines. -->
      <TrainingTab
        v-if="activeTab === 'training'"
        :refreshing-ride-id="refreshingWorkoutId"
        @action="onDayAction"
        @open-history="openHistoryChart"
        @open-events="showTodaysEvents = true"
      />
      <LazyWorkoutBuilderTab v-else-if="activeTab === 'builder'" />
      <LazyHistoryTab v-else-if="activeTab === 'history'" />
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
          <LazyAddWorkoutModal
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
                    {{ formatRideDate(activity.startDate) }}
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
          <LazyMetricsHistoryChart v-else :series="historySeries" />
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

          <LazyUserSettingsModal @saved="closeUserSettings" @close="closeUserSettings" />
        </div>
      </div>
    </Teleport>

    <!-- ── Ride stats overlay ─────────────────────────────────────────── -->
    <!-- `v-if` guard added so the `Lazy` chunk only loads when a workout row
         with FIT data is actually opened (the component otherwise mounts
         eagerly and just renders nothing until `workout` is non-null). -->
    <LazyWorkoutFitOverlay
      v-if="fitOverlayWorkout"
      :workout="fitOverlayWorkout"
      @close="closeFitOverlay"
    />

    <!-- ── Today's Zwift events dialog (Training tab) ─────────────────── -->
    <LazyTodaysEventsDialog v-if="showTodaysEvents" open @close="showTodaysEvents = false" />

  </div>
</template>
