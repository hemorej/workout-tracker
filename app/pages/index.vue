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
import { useWorkoutsStore } from '~/stores/workouts'
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
const activeTab = ref<'log' | 'planning' | 'builder' | 'history'>('log')

const tabs = [
  { id: 'log', label: 'Training log' },
  { id: 'planning', label: 'Planning' },
  { id: 'builder', label: 'Workout builder' },
  { id: 'history', label: 'History' },
] as const

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
const workoutBuilderRef = ref<{ setName: (name: string) => void } | null>(null)

/** "Planned" icon on a planned day — switch to the builder tab pre-filled with the plan's name */
async function goToBuilder() {
  const name = todayPlan.value?.plan?.name ?? ''
  activeTab.value = 'builder'
  await nextTick()
  workoutBuilderRef.value?.setName(name)
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

onMounted(() => {
  workouts.fetchPage(1)
  planning.fetchPlans()
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

      <!-- Tab navigation — full-width justified 4-up bar -->
      <nav class="grid grid-cols-4 bg-white border-b border-stone-100">
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
          @click="activeTab = tab.id"
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
      <WorkoutBuilderTab v-if="activeTab === 'builder'" ref="workoutBuilderRef" />

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
      />

      <!-- Section header + Add button, and the content directly below it —
           grouped so their shared spacing can be tightened on narrow/vertical
           screens independently of the rest of main's space-y-10 rhythm. -->
      <div class="!mt-4 sm:!mt-10 space-y-4 sm:space-y-10">

      <!-- Section header + Add button -->
      <div class="flex items-center justify-between">
        <h2 class="text-xs font-semibold uppercase tracking-widest text-stone-400">
          Training log
        </h2>
        <button
          class="flex items-center gap-1.5 rounded-xl bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-orange-600/20 transition-colors hover:bg-orange-700"
          @click="openAddWorkout"
        >
          <UIcon name="i-heroicons-plus" class="h-4 w-4" />
          Add workout
        </button>
      </div>

      <!-- ── Loading state ─────────────────────────────────────────── -->
      <div v-if="workouts.isLoading" class="flex justify-center py-16">
        <UIcon name="i-heroicons-arrow-path" class="animate-spin text-stone-300 text-2xl" />
      </div>

      <!-- ── Error state ───────────────────────────────────────────── -->
      <UAlert
        v-else-if="workouts.error"
        color="error"
        variant="subtle"
        title="Failed to load workouts"
        :description="workouts.error"
      />

      <!-- ── Empty state ───────────────────────────────────────────── -->
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
          v-for="(day, index) in workouts.days"
          :key="day.date"
          :day="day"
          :prev-metrics="workouts.days[index + 1]?.metrics ?? null"
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
            <UIcon name="i-heroicons-arrow-path" class="animate-spin text-stone-300 text-2xl" />
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

  </div>
</template>
