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

// Protect this page — unauthenticated users are sent to /login
definePageMeta({ middleware: 'auth' })

// ── Tab navigation ────────────────────────────────────────────────────────
const activeTab = ref<'log' | 'planning'>('log')

const auth = useAuthStore()
const workouts = useWorkoutsStore()
const toast = useToast()

// ── Add-workout modal ────────────────────────────────────────────────────
// UModal lives here (same component that owns the open state) — this matches
// the documented pattern and avoids prop-forwarding reactivity issues.
const showAddWorkout = ref(false)
const addWorkoutForm = ref<{ reset: () => void } | null>(null)

function openAddWorkout() {
  showAddWorkout.value = true
}

function closeAddWorkout() {
  showAddWorkout.value = false
}

// ── Lifecycle ────────────────────────────────────────────────────────────

onMounted(() => {
  workouts.fetchPage(1)
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

    <!-- ── Header — minimal, borderless top bar ───────────────────── -->
    <header class="bg-white border-b border-stone-100 sticky top-0 z-10">
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

    <!-- ── Tab navigation ────────────────────────────────────────────── -->
    <div class="bg-white border-b border-stone-100">
      <div class="max-w-3xl mx-auto px-6 py-3">
        <div class="inline-flex gap-1 rounded-xl bg-stone-100 p-1">
          <button
            v-for="tab in [{ id: 'log', label: 'Training log' }, { id: 'planning', label: 'Planning' }]"
            :key="tab.id"
            class="rounded-lg px-5 py-2 text-sm transition-colors"
            :class="activeTab === tab.id
              ? 'bg-white font-semibold text-stone-900 shadow-sm'
              : 'font-medium text-stone-500 hover:text-stone-700'"
            @click="activeTab = (tab.id as 'log' | 'planning')"
          >
            {{ tab.label }}
          </button>
        </div>
      </div>
    </div>

    <!-- ── Main content ────────────────────────────────────────────── -->
    <main class="max-w-3xl mx-auto px-6 py-10 space-y-10">

      <!-- ── Planning tab ────────────────────────────────────────── -->
      <PlanningTab v-if="activeTab === 'planning'" />

      <!-- ── Training log tab ────────────────────────────────────── -->
      <template v-if="activeTab === 'log'">

      <!-- Headline metrics strip -->
      <MetricsSummary
        :weekly-tss="workouts.weeklyStats.tssTotal"
        :weekly-hours="workouts.weeklyStats.hoursTotal"
        :today-c-t-l="workouts.todayMetrics.ctl"
        :today-a-t-l="workouts.todayMetrics.atl"
        :today-t-s-b="workouts.todayMetrics.tsb"
      />

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
      <div v-else class="bg-white rounded-xl border border-stone-100 overflow-hidden divide-y divide-stone-50">
        <WorkoutCard
          v-for="day in workouts.days"
          :key="day.date"
          :day="day"
          @delete="onDeleteWorkout"
        />
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
            @saved="onWorkoutSaved"
            @close="closeAddWorkout"
          />
        </div>
      </div>
    </Teleport>

  </div>
</template>
