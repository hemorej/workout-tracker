<script setup lang="ts">
/**
 * WorkoutCard component
 *
 * Renders a single row in the workout list. Each row represents one calendar
 * day — either an actual workout or a rest day.
 *
 * Displays:
 *   - Date (formatted, with "Today" / "Yesterday" relative labels)
 *   - Workout name (or "Rest day" badge)
 *   - Duration + distance + TSS + optional RPE
 *   - Optional notes (truncated, expandable)
 *   - A delete button for workout days
 *
 * Emits:
 *   delete — when the user confirms deletion (parent calls the store)
 */

import type { DayEntry } from '~/stores/workouts'
import type { PlannedDay } from '~/stores/planning'

interface Props {
  day: DayEntry
  plannedWorkout?: PlannedDay | null
  /** True while an auto-build (AI) request is in flight for this day's plan. */
  isAutoBuilding?: boolean
  /** True while a "refresh ride data" fetch/parse is in flight for this day's workout. */
  isRefreshingRideData?: boolean
  /** True while an AI "ride insights" generation request is in flight for this day's workout. */
  isGeneratingInsights?: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'delete', id: number): void
  (e: 'mark-completed'): void
  (e: 'go-to-builder'): void
  (e: 'auto-build'): void
  (e: 'open-fit-overlay'): void
  (e: 'refresh-ride-data'): void
  (e: 'generate-insights'): void
}>()

// ── Date formatting ──────────────────────────────────────────────────────

/**
 * Formats the date string for display.
 * Shows "Today" / "Yesterday" for recent days, full date otherwise.
 */
const formattedDate = computed(() => {
  // Parse as local date (add T00:00 to avoid UTC offset issues)
  const date = new Date(`${props.day.date}T00:00`)
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  if (date.getTime() === today.getTime()) return 'Today'
  if (date.getTime() === yesterday.getTime()) return 'Yesterday'

  return date.toLocaleDateString('en-US', { weekday: 'long' })
})

/** "Jul 13 2026" — shown as a second line under the weekday, omitted for Today/Yesterday */
const formattedMonthDayYear = computed(() => {
  const date = new Date(`${props.day.date}T00:00`)
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  if (date.getTime() === today.getTime() || date.getTime() === yesterday.getTime()) return null

  const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${monthDay} ${date.getFullYear()}`
})

/** Duration formatted as "Xh Ym" */
const durationDisplay = computed(() => {
  const mins = props.day.workout?.durationMinutes ?? 0
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
})

/** Distance formatted as "32.4 km" — omitted for older workouts logged before this field existed */
const distanceDisplay = computed(() => {
  const km = props.day.workout?.distanceKm
  return km != null ? `${km.toFixed(1)} km` : null
})

// ── Notes expansion ──────────────────────────────────────────────────────
const notesExpanded = ref(false)
const NOTES_PREVIEW_LENGTH = 80

const notesPreview = computed(() => {
  const notes = props.day.workout?.notes ?? ''
  if (notes.length <= NOTES_PREVIEW_LENGTH) return notes
  return notes.slice(0, NOTES_PREVIEW_LENGTH) + '…'
})

const hasLongNotes = computed(
  () => (props.day.workout?.notes ?? '').length > NOTES_PREVIEW_LENGTH,
)

// ── Planned workout state ────────────────────────────────────────────────
const plannedPlan = computed(() => props.plannedWorkout?.plan ?? null)
const isPlannedDay = computed(() => props.day.isRestDay && !!plannedPlan.value)

const plannedDurationDisplay = computed(() => {
  const mins = plannedPlan.value?.durationMinutes ?? 0
  if (!mins) return null
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
})

// ── Power data indicators ────────────────────────────────────────────────
const hasFtp = computed(() => !!props.day.workout?.ftpWatts)
const hasPowerBests = computed(() => (props.day.workout?.powerBests?.length ?? 0) > 0)
const hasFitData = computed(() => !!props.day.workout?.fitData)
const hasInsights = computed(() => !!props.day.workout?.insights)
const hasStravaActivity = computed(() => !!props.day.workout?.stravaActivityId)

function openOverlay() {
  navigateTo(`/overlay/${props.day.workout?.stravaActivityId}`)
}

// ── Mobile swipe-row summary (panel 1) ───────────────────────────────────
const mobileTitle = computed(() => {
  if (isPlannedDay.value) return plannedPlan.value?.name || 'Planned workout'
  if (props.day.isRestDay) return 'Rest'
  return props.day.workout?.name
})

const mobileDuration = computed(() => {
  if (props.day.isRestDay && !isPlannedDay.value) return null
  return isPlannedDay.value ? plannedDurationDisplay.value : durationDisplay.value
})

// ── Planned pill: start from scratch vs auto-build ───────────────────────
const showBuildChoice = ref(false)

function chooseFromScratch() {
  showBuildChoice.value = false
  emit('go-to-builder')
}

function chooseAutoBuild() {
  showBuildChoice.value = false
  emit('auto-build')
}

// ── Delete confirmation ──────────────────────────────────────────────────
const showDeleteConfirm = ref(false)

function requestDelete() {
  showDeleteConfirm.value = true
}

function confirmDelete() {
  if (props.day.workout) {
    emit('delete', props.day.workout.id)
  }
  showDeleteConfirm.value = false
}
</script>

<template>
  <!--
    Each day is a fixed-column grid row, not a card:
      84px date | flexible title/metrics | 210px [PR badge + TSS pill + RPE-or-Planned pill + action icon]
    The TSS column is separate so every TSS pill's right edge lines up
    regardless of digit count. The last column groups the RPE/Planned pill
    with the row's action icon in a single flex-end row with a small gap,
    so they sit snug together instead of spreading across the column.
    Workout rows have a left accent line in orange-600.
    Rest days are visually quieter — no accent, lighter text.
    The parent (index.vue) wraps all rows in a single white container
    with divide-y so the borders render between rows, not around each one.
  -->
  <!-- Mobile swipe row (< sm): panel 1 (title/duration/distance) at rest,
       panel 2 (metrics chips + actions) revealed via horizontal scroll-snap.
       Hidden at sm+ where the full grid below takes over. -->
  <div
    class="sm:hidden relative flex overflow-x-auto snap-x snap-mandatory no-scrollbar"
    :class="day.isRestDay && !isPlannedDay ? 'opacity-50' : ''"
  >
    <!-- Panel 1: resting state -->
    <div class="relative snap-start shrink-0 w-full flex items-center gap-3 px-6 py-2">
      <div
        v-if="!day.isRestDay"
        class="absolute left-0 top-2 bottom-2 w-[3px] bg-orange-600 rounded-full"
      />
      <div
        v-else-if="isPlannedDay"
        class="absolute left-0 top-2 bottom-2 w-[3px] bg-violet-400 rounded-full"
      />
      <div class="min-w-0 flex-1">
        <button
          v-if="!day.isRestDay && !isPlannedDay && hasFitData"
          type="button"
          class="text-sm font-semibold truncate text-stone-800 underline decoration-stone-300 underline-offset-2"
          @click.stop="emit('open-fit-overlay')"
        >
          {{ mobileTitle }}
        </button>
        <p
          v-else
          class="text-sm font-semibold truncate"
          :class="day.isRestDay && !isPlannedDay ? 'text-stone-400 italic font-normal' : (isPlannedDay ? 'text-stone-500 italic' : 'text-stone-800')"
        >
          {{ mobileTitle }}
        </p>
        <p v-if="mobileDuration" class="text-xs text-stone-400 mt-0.5">
          {{ mobileDuration }}<template v-if="distanceDisplay"> · {{ distanceDisplay }}</template>
        </p>
      </div>
      <!-- Faint chevron hinting the row is swipeable -->
      <svg class="w-3 h-3 text-stone-300 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 6l6 6-6 6" />
      </svg>
    </div>

    <!-- Panel 2: reveal — CTL/TSB, PR badge, TSS, RPE, actions all on one
         row at reduced text size, evenly spaced across the full width.
         flex-wrap stays as a safety net in case a row runs out of space
         (e.g. long delete-confirm text), but sizes are tuned to fit on one line. -->
    <div class="snap-start shrink-0 w-full flex items-center justify-between flex-wrap gap-0.5 px-4 py-2 bg-stone-50">
      <span
        v-if="hasPowerBests"
        class="inline-flex items-center gap-0.5 shrink-0 text-[10px] text-amber-600 font-semibold bg-amber-50 rounded-full px-1 py-[1px]"
        :title="`${day.workout?.powerBests?.length} power best${(day.workout?.powerBests?.length ?? 0) > 1 ? 's' : ''} recorded`"
      >
        <svg class="w-2 h-2" fill="currentColor" viewBox="0 0 20 20">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
        {{ day.workout?.powerBests?.length }}
      </span>
      <span
        v-if="hasFtp"
        class="inline-flex items-center gap-0.5 shrink-0 text-[10px] text-violet-600 font-semibold bg-violet-50 rounded-full px-1 py-[1px]"
        :title="`FTP updated to ${day.workout?.ftpWatts}W`"
      >
        <svg class="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        {{ day.workout?.ftpWatts }}W
      </span>
      <span
        v-if="isPlannedDay ? plannedPlan?.tss : day.workout?.tss"
        class="inline-block shrink-0 text-[10px] text-sky-600 font-semibold bg-sky-50 rounded-full px-1.5 py-[1px] whitespace-nowrap"
      >
        {{ isPlannedDay ? plannedPlan?.tss : day.workout?.tss }} TSS
      </span>
      <span
        v-if="day.workout?.rpe"
        class="inline-block text-[10px] text-stone-500 font-semibold bg-stone-100 rounded-full px-1.5 py-[1px] whitespace-nowrap"
      >
        RPE {{ day.workout?.rpe }}/10
      </span>
      <!-- Non-interactive pill on mobile: the Workout Builder tab (and thus
           both "from scratch" and "auto-build") is unavailable below `lg`,
           so there's no choice to offer here — see the desktop pill below
           for the real interaction. -->
      <span
        v-else-if="isPlannedDay"
        class="inline-block text-[10px] text-violet-600 font-semibold bg-violet-100 border border-violet-200 rounded-full px-1.5 py-[1px] whitespace-nowrap"
      >
        Planned
      </span>
      <button
        v-if="isPlannedDay"
        title="Mark as completed"
        aria-label="Mark as completed"
        class="flex items-center justify-center shrink-0 w-6 h-6 rounded-full border-none bg-transparent text-violet-300 opacity-65 transition-all hover:opacity-100 hover:text-violet-600 hover:bg-violet-100"
        @click="emit('mark-completed')"
      >
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M8 12l3 3 5-6" />
        </svg>
      </button>
      <button
        v-if="!day.isRestDay && !isPlannedDay && !hasFitData"
        title="Refresh ride data"
        aria-label="Refresh ride data"
        :disabled="isRefreshingRideData"
        class="flex items-center justify-center shrink-0 w-6 h-6 rounded-full border-none bg-transparent text-stone-300 opacity-55 transition-all hover:opacity-100 hover:text-orange-600 hover:bg-orange-50 disabled:opacity-100"
        @click="emit('refresh-ride-data')"
      >
        <BikeSpinner v-if="isRefreshingRideData" :size="12" />
        <svg v-else class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
      </button>
      <button
        v-if="!day.isRestDay && !isPlannedDay && hasFitData && !hasInsights"
        title="Ride insights"
        aria-label="Ride insights"
        :disabled="isGeneratingInsights"
        class="flex items-center justify-center shrink-0 w-6 h-6 rounded-full border-none transition-all opacity-55 hover:opacity-100 hover:text-amber-500 hover:bg-amber-50 disabled:opacity-100"
        :class="isGeneratingInsights ? 'text-amber-500 bg-amber-50 opacity-100' : 'text-stone-300 bg-transparent'"
        @click="emit('generate-insights')"
      >
        <BikeSpinner v-if="isGeneratingInsights" :size="12" />
        <svg v-else class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
          <path d="M13.5 2L4 14h6l-1 8 9.5-12h-6l1-8z" />
        </svg>
      </button>
      <button
        v-if="!day.isRestDay && !isPlannedDay && hasStravaActivity"
        title="Create photo overlay"
        aria-label="Create photo overlay"
        class="flex items-center justify-center shrink-0 w-6 h-6 rounded-full border-none bg-transparent text-stone-300 opacity-55 transition-all hover:opacity-100 hover:text-orange-600 hover:bg-orange-50"
        @click="openOverlay"
      >
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </button>
      <template v-if="!day.isRestDay && !isPlannedDay">
        <button
          v-if="!showDeleteConfirm"
          title="Delete workout"
          aria-label="Delete workout"
          class="flex items-center justify-center shrink-0 w-6 h-6 rounded-full border-none bg-transparent text-stone-300 opacity-55 transition-all hover:opacity-100 hover:text-rose-600 hover:bg-rose-50"
          @click="requestDelete"
        >
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
          </svg>
        </button>
        <div v-else class="flex items-center gap-1.5">
          <button class="text-[10px] text-rose-500 hover:text-rose-600 font-semibold" @click="confirmDelete">
            Confirm
          </button>
          <button class="text-[10px] text-stone-300 hover:text-stone-500" @click="showDeleteConfirm = false">
            Cancel
          </button>
        </div>
      </template>
    </div>
  </div>

  <div
    class="relative hidden sm:grid items-start px-6 py-[18px] gap-x-5 transition-colors hover:bg-stone-50"
    :class="day.isRestDay && !isPlannedDay ? 'opacity-50 !py-2.5' : ''"
    :style="day.isRestDay && !isPlannedDay
      ? 'grid-template-columns: 84px 1fr;'
      : 'grid-template-columns: 84px minmax(160px,1fr) 210px;'"
  >
    <!-- Left accent line — orange for logged workouts, violet for planned -->
    <div
      v-if="!day.isRestDay"
      class="absolute left-0 top-4 bottom-4 w-[3px] bg-orange-600 rounded-full"
    />
    <div
      v-else-if="isPlannedDay"
      class="absolute left-0 top-4 bottom-4 w-[3px] bg-violet-400 rounded-full"
    />

    <!-- Column 1: date — fixed width, right-aligned -->
    <div class="text-right pt-0.5">
      <p class="text-sm font-semibold text-stone-600">{{ formattedDate }}</p>
      <p v-if="formattedMonthDayYear" class="text-xs text-stone-500 mt-0.5">{{ formattedMonthDayYear }}</p>
    </div>

    <!-- Column 2: title/duration + notes + metrics — absorbs variable-length text -->
    <div class="min-w-0 pt-0.5">

      <!-- Rest day -->
      <div v-if="day.isRestDay && !isPlannedDay" class="flex flex-wrap items-center gap-1.5 text-[11px] font-medium tabular">
        <span class="text-sm text-stone-400 italic mr-1">Rest</span>
      </div>

      <!-- Planned workout (today, not yet logged) -->
      <div v-else-if="isPlannedDay">
        <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span class="text-base font-medium text-stone-500 italic max-w-xs">
            {{ plannedPlan?.name || 'Planned workout' }}
          </span>
          <span v-if="plannedDurationDisplay" class="text-sm text-stone-400">{{ plannedDurationDisplay }}</span>
        </div>
      </div>

      <!-- Workout day -->
      <div v-else>
        <!-- Name row — on narrow viewports the duration/distance group is forced onto its
             own second line (w-full) instead of wrapping wherever the title happens to
             break; at sm+ it collapses back into the same flex row via sm:contents. -->
        <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <button
            v-if="hasFitData"
            type="button"
            class="text-base font-semibold text-stone-800 max-w-xs truncate underline decoration-stone-300 underline-offset-2 hover:decoration-stone-500 transition-colors"
            @click="emit('open-fit-overlay')"
          >
            {{ day.workout?.name }}
          </button>
          <span v-else class="text-base font-semibold text-stone-800 max-w-xs">
            {{ day.workout?.name }}
          </span>
          <div class="flex items-baseline gap-x-2.5 w-full sm:w-auto sm:contents">
            <span class="text-sm text-stone-400">{{ durationDisplay }}</span>
            <span v-if="distanceDisplay" class="text-sm text-stone-400">{{ distanceDisplay }}</span>
          </div>
          <!-- FTP update indicator -->
          <span
            v-if="hasFtp"
            class="inline-flex items-center gap-1 text-xs text-violet-600 font-semibold bg-violet-50 rounded-full px-2.5 py-0.5"
            :title="`FTP updated to ${day.workout?.ftpWatts}W`"
          >
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            {{ day.workout?.ftpWatts }}W FTP
          </span>
        </div>

        <!-- Notes -->
        <div v-if="day.workout?.notes" class="mt-1">
          <span class="text-sm text-stone-400">
            {{ notesExpanded ? day.workout.notes : notesPreview }}
          </span>
          <button
            v-if="hasLongNotes"
            class="ml-1 text-xs text-stone-300 hover:text-stone-500 underline"
            @click="notesExpanded = !notesExpanded"
          >
            {{ notesExpanded ? 'less' : 'more' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Column 3: PR badge, TSS pill, RPE-or-Planned pill, and action icon — all on
         one row, evenly spaced and right-aligned as a single group so every row's
         icon (and, absent a PR badge, every pill) lines up horizontally -->
    <div class="pt-0.5 flex items-start justify-end gap-2">
      <span
        v-if="hasPowerBests"
        class="inline-flex items-center gap-0.5 shrink-0 text-xs text-amber-600 font-semibold bg-amber-50 rounded-full px-2 py-0.5"
        :title="`${day.workout?.powerBests?.length} power best${(day.workout?.powerBests?.length ?? 0) > 1 ? 's' : ''} recorded`"
      >
        <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
        {{ day.workout?.powerBests?.length }}
      </span>
      <span
        v-if="isPlannedDay ? plannedPlan?.tss : day.workout?.tss"
        class="inline-block shrink-0 text-xs text-sky-600 font-semibold bg-sky-50 rounded-full px-2.5 py-0.5 whitespace-nowrap"
      >
        {{ isPlannedDay ? plannedPlan?.tss : day.workout?.tss }} TSS
      </span>
      <span
        v-if="day.workout?.rpe"
        class="inline-block text-xs text-stone-500 font-semibold bg-stone-100 rounded-full px-2.5 py-0.5 whitespace-nowrap"
      >
        RPE {{ day.workout?.rpe }}/10
      </span>
      <template v-else-if="isPlannedDay">
        <BikeSpinner v-if="isAutoBuilding" :size="20" />
        <div v-else-if="showBuildChoice" class="flex items-center gap-2">
          <button class="text-xs text-violet-600 hover:text-violet-700 font-semibold" @click="chooseFromScratch">
            Manual
          </button>
          <button class="text-xs text-violet-600 hover:text-violet-700 font-semibold" @click="chooseAutoBuild">
            Auto
          </button>
          <button class="text-xs text-stone-300 hover:text-stone-500" @click="showBuildChoice = false">
            Cancel
          </button>
        </div>
        <button
          v-else
          title="Go to workout builder"
          class="inline-block text-xs text-violet-600 font-semibold bg-violet-100 border border-violet-200 rounded-full px-2.5 py-0.5 whitespace-nowrap cursor-pointer transition-colors hover:bg-violet-200"
          @click="showBuildChoice = true"
        >
          Planned
        </button>
      </template>

      <!-- Mark as completed — primary action for a planned-but-not-logged day.
           Rendered at low opacity by default (not hover-gated) so it's reachable on touch. -->
      <button
        v-if="isPlannedDay"
        title="Mark as completed"
        aria-label="Mark as completed"
        class="flex items-center justify-center self-start shrink-0 w-9 h-9 -mt-2 rounded-full border-none bg-transparent text-violet-300 opacity-65 transition-all hover:opacity-100 hover:text-violet-600 hover:bg-violet-100"
        @click="emit('mark-completed')"
      >
        <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M8 12l3 3 5-6" />
        </svg>
      </button>

      <!-- Refresh ride data — only shown once a workout exists with no parsed FIT data yet -->
      <button
        v-if="!day.isRestDay && !isPlannedDay && !hasFitData"
        title="Refresh ride data"
        aria-label="Refresh ride data"
        :disabled="isRefreshingRideData"
        class="flex items-center justify-center self-start shrink-0 w-10 h-10 -mt-2.5 rounded-full border-none bg-transparent text-stone-300 opacity-55 transition-all hover:opacity-100 hover:text-orange-600 hover:bg-orange-50 disabled:opacity-100"
        @click="emit('refresh-ride-data')"
      >
        <BikeSpinner v-if="isRefreshingRideData" :size="16" />
        <svg v-else class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
      </button>

      <!-- Ride insights — shown once FIT data exists and insights haven't been generated yet;
           permanently hidden once generated (see WorkoutFitOverlay's Insights tab instead). -->
      <button
        v-if="!day.isRestDay && !isPlannedDay && hasFitData && !hasInsights"
        title="Ride insights"
        aria-label="Ride insights"
        :disabled="isGeneratingInsights"
        class="flex items-center justify-center self-start shrink-0 w-10 h-10 -mt-2.5 rounded-full border-none transition-all opacity-55 hover:opacity-100 hover:text-amber-500 hover:bg-amber-50 disabled:opacity-100"
        :class="isGeneratingInsights ? 'text-amber-500 bg-amber-50 opacity-100' : 'text-stone-300 bg-transparent'"
        @click="emit('generate-insights')"
      >
        <BikeSpinner v-if="isGeneratingInsights" :size="16" />
        <svg v-else class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M13.5 2L4 14h6l-1 8 9.5-12h-6l1-8z" />
        </svg>
      </button>

      <!-- Create photo overlay — shown once the workout has a linked Strava activity -->
      <button
        v-if="!day.isRestDay && !isPlannedDay && hasStravaActivity"
        title="Create photo overlay"
        aria-label="Create photo overlay"
        class="flex items-center justify-center self-start shrink-0 w-10 h-10 -mt-2.5 rounded-full border-none bg-transparent text-stone-300 opacity-55 transition-all hover:opacity-100 hover:text-orange-600 hover:bg-orange-50"
        @click="openOverlay"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </button>

      <!-- Delete control — always rendered (dimmed, not hover-gated) so it's reachable on touch -->
      <template v-if="!day.isRestDay && !isPlannedDay">
        <button
          v-if="!showDeleteConfirm"
          title="Delete workout"
          aria-label="Delete workout"
          class="flex items-center justify-center self-start shrink-0 w-10 h-10 -mt-2.5 rounded-full border-none bg-transparent text-stone-300 opacity-55 transition-all hover:opacity-100 hover:text-rose-600 hover:bg-rose-50"
          @click="requestDelete"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
          </svg>
        </button>
        <!-- Inline confirmation -->
        <div v-else class="flex items-center self-center gap-2">
          <button class="text-xs text-rose-500 hover:text-rose-600 font-semibold" @click="confirmDelete">
            Confirm
          </button>
          <button class="text-xs text-stone-300 hover:text-stone-500" @click="showDeleteConfirm = false">
            Cancel
          </button>
        </div>
      </template>
    </div>

  </div>
</template>
