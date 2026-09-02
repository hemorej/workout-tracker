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
 *   - Duration + distance + compact TSS / RPE / power-bests pills
 *   - Optional notes (truncated, expandable)
 *   - A single overflow menu per logged row; delete lives inside it
 *
 * Emits:
 *   delete — when the user confirms deletion (parent calls the store)
 */

import type { DropdownMenuItem } from '@nuxt/ui'
import type { DayEntry } from '~/stores/workouts'
import type { PlannedDay } from '~/stores/planning'

interface Props {
  day: DayEntry
  plannedWorkout?: PlannedDay | null
  /** True while an auto-build (AI) request is in flight for this day's plan. */
  isAutoBuilding?: boolean
  /** True while a "refresh ride data" fetch/parse is in flight for this day's workout. */
  isRefreshingRideData?: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'delete', id: number): void
  (e: 'mark-completed'): void
  (e: 'go-to-builder'): void
  (e: 'auto-build'): void
  (e: 'open-fit-overlay'): void
  (e: 'refresh-ride-data'): void
  (e: 'edit'): void
  (e: 'reupload-fit'): void
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
/** Outdoor plans have no workout builder (manual/auto) to send the rider to — just a placeholder pill */
const isPlannedOutdoor = computed(() => plannedPlan.value?.type === 'outdoor')

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
const hasStravaActivity = computed(() => !!props.day.workout?.stravaActivityId)
/** Photo overlay builder only makes sense for outdoor rides — no route/map data for indoor/trainer rides */
const isOutdoorRide = computed(() => props.day.workout?.rideType === 'outdoor')

// ── Compact pill readings ────────────────────────────────────────────────
// The pills show only an icon + number; the full reading lives in both
// `title` and `aria-label` so the number alone is never the accessible name.
const powerBestsLabel = computed(() => {
  const n = props.day.workout?.powerBests?.length ?? 0
  return `${n} power best${n === 1 ? '' : 's'} recorded`
})
const tssLabel = computed(() => {
  const tss = isPlannedDay.value ? plannedPlan.value?.tss : props.day.workout?.tss
  return isPlannedDay.value ? `${tss} TSS planned` : `${tss} TSS`
})
const rpeLabel = computed(() => `RPE ${props.day.workout?.rpe} of 10`)

function openOverlay() {
  navigateTo(`/overlay/${props.day.workout?.stravaActivityId}`)
}

/**
 * Overflow menu for a logged workout row — keeps the row visually calm while
 * making every secondary action touch-reachable. "Refresh from Wahoo" shows
 * only for outdoor rides (re-run the Strava → Wahoo → parse flow), even once
 * the ride already has parsed FIT data; "Re-upload FIT file" routes through the
 * manual upload path and works for indoor and outdoor rides alike. Delete is
 * the final item, below a separator, styled destructive — selecting it opens
 * the same inline Confirm / Cancel step as before (it never deletes on select).
 */
const rowMenuItems = computed<DropdownMenuItem[][]>(() => [
  [
    { label: 'Edit ride', icon: 'i-lucide-pencil', onSelect: () => emit('edit') },
    // "Refresh from Wahoo" only applies to outdoor rides — the Wahoo API has no
    // FIT file for indoor/trainer (Zwift) rides, so there's nothing to re-fetch.
    ...(isOutdoorRide.value
      ? [{
          label: props.isRefreshingRideData ? 'Refreshing…' : 'Refresh from Wahoo',
          icon: 'i-lucide-refresh-cw',
          disabled: props.isRefreshingRideData,
          onSelect: () => emit('refresh-ride-data'),
        }]
      : []),
    { label: 'Re-upload FIT file', icon: 'i-lucide-upload', onSelect: () => emit('reupload-fit') },
    ...(hasStravaActivity.value && isOutdoorRide.value
      ? [{ label: 'Create photo overlay', icon: 'i-lucide-image', onSelect: () => openOverlay() }]
      : []),
  ],
  [
    { label: 'Delete workout', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => requestDelete() },
  ],
])

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
        class="absolute left-0 top-2 bottom-2 w-[3px] bg-[#4B88A2] rounded-full"
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
        class="inline-flex items-center gap-0.5 shrink-0 text-[11px] text-[#3F6212] font-semibold bg-[#F3F7EA] border border-[#D0DFB4] rounded-full px-1.5 py-[1px] tabular-nums"
        :title="powerBestsLabel"
        :aria-label="powerBestsLabel"
      >
        <svg class="w-[11px] h-[11px]" fill="currentColor" viewBox="0 0 20 20">
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
        class="inline-flex items-center gap-0.5 shrink-0 text-[11px] text-amber-600 font-semibold bg-amber-50 border border-amber-200 rounded-full px-1.5 py-[1px] whitespace-nowrap tabular-nums"
        :title="tssLabel"
        :aria-label="tssLabel"
      >
        <svg class="w-[11px] h-[11px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
        </svg>
        {{ isPlannedDay ? plannedPlan?.tss : day.workout?.tss }}
      </span>
      <span
        v-if="day.workout?.rpe"
        class="inline-flex items-center gap-0.5 shrink-0 text-[11px] text-[#BE185D] font-semibold bg-[#FDF2F8] border border-[#FBCFE8] rounded-full px-1.5 py-[1px] whitespace-nowrap tabular-nums"
        :title="rpeLabel"
        :aria-label="rpeLabel"
      >
        <svg class="w-[11px] h-[11px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
        </svg>
        {{ day.workout?.rpe }}
      </span>
      <!-- Planned pill: on mobile the Workout Builder (Manual / Auto) is
           unavailable, so the pill routes straight to "mark as completed" —
           the same completed-workout picker the standalone tick used to open. -->
      <button
        v-else-if="isPlannedDay"
        title="Open to log details"
        aria-label="Open planned workout to log details"
        class="inline-flex items-center gap-1 shrink-0 text-[11px] text-[#3B6E84] font-semibold bg-[#F1F7FA] border border-[#B8D5E0] rounded-full px-2 py-[1px] whitespace-nowrap transition-colors hover:bg-[#e6f0f5] hover:border-[#4B88A2]"
        @click="emit('mark-completed')"
      >
        <svg class="w-[11px] h-[11px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="17" rx="2" />
          <path d="M8 2v4" />
          <path d="M16 2v4" />
          <path d="M3 10h18" />
        </svg>
        Planned
      </button>
      <!-- Standalone "mark as completed" tick — opens the completed-workout
           picker directly (the Planned pill above is the build hand-off). -->
      <button
        v-if="isPlannedDay"
        title="Mark as completed"
        aria-label="Mark as completed"
        class="flex items-center justify-center shrink-0 w-6 h-6 rounded-full border-none bg-transparent text-[#4B88A2] opacity-65 transition-all hover:opacity-100 hover:text-[#3B6E84] hover:bg-[#e6f0f5]"
        @click="emit('mark-completed')"
      >
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M8 12l3 3 5-6" />
        </svg>
      </button>
      <template v-if="!day.isRestDay && !isPlannedDay">
        <!-- Selecting "Delete workout" from the menu swaps in the two-step
             confirm here, in place of the menu trigger. -->
        <div v-if="showDeleteConfirm" class="flex items-center gap-1.5">
          <button class="text-[10px] text-rose-500 hover:text-rose-600 font-semibold" @click="confirmDelete">
            Confirm
          </button>
          <button class="text-[10px] text-stone-300 hover:text-stone-500" @click="showDeleteConfirm = false">
            Cancel
          </button>
        </div>
        <BikeSpinner v-else-if="isRefreshingRideData" :size="12" class="shrink-0 mx-1" />
        <UDropdownMenu
          v-else
          :items="rowMenuItems"
          :content="{ align: 'end' }"
          :ui="{ content: 'w-48' }"
        >
          <button
            title="More actions"
            aria-label="More actions"
            class="flex items-center justify-center shrink-0 w-9 h-9 -my-1 rounded-full border-none bg-transparent text-stone-300 opacity-55 transition-all hover:opacity-100 hover:text-orange-600 hover:bg-orange-50"
          >
            <svg class="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
          </button>
        </UDropdownMenu>
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
    <!-- Left accent line — orange-600 for logged workouts (warm = ridden),
         air force blue for planned (cool = not yet) -->
    <div
      v-if="!day.isRestDay"
      class="absolute left-0 top-4 bottom-4 w-[3px] bg-orange-600 rounded-full"
    />
    <div
      v-else-if="isPlannedDay"
      class="absolute left-0 top-4 bottom-4 w-[3px] bg-[#4B88A2] rounded-full"
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

    <!-- Column 3: compact power-bests / TSS / RPE pills, the Planned action pill,
         and the single overflow menu — one right-aligned flex group so every
         row's trigger (and, absent a power-bests pill, every pill) lines up.
         Selecting "Delete workout" from the menu swaps this whole group for the
         inline Confirm / Cancel pair. -->
    <div class="pt-0.5 flex items-start justify-end gap-2">
      <!-- Two-step delete confirm — replaces the pills in place, never deletes on select -->
      <div v-if="!day.isRestDay && !isPlannedDay && showDeleteConfirm" class="flex items-center self-center gap-2">
        <button class="text-xs text-rose-500 hover:text-rose-600 font-semibold" @click="confirmDelete">
          Confirm
        </button>
        <button class="text-xs text-stone-300 hover:text-stone-500" @click="showDeleteConfirm = false">
          Cancel
        </button>
      </div>

      <template v-else>
        <span
          v-if="hasPowerBests"
          class="inline-flex items-center gap-1 shrink-0 text-xs text-[#3F6212] font-semibold bg-[#F3F7EA] border border-[#D0DFB4] rounded-full px-2 py-0.5 tabular-nums"
          :title="powerBestsLabel"
          :aria-label="powerBestsLabel"
        >
          <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
          {{ day.workout?.powerBests?.length }}
        </span>
        <span
          v-if="isPlannedDay ? plannedPlan?.tss : day.workout?.tss"
          class="inline-flex items-center gap-1 shrink-0 text-xs text-amber-600 font-semibold bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 whitespace-nowrap tabular-nums"
          :title="tssLabel"
          :aria-label="tssLabel"
        >
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
          </svg>
          {{ isPlannedDay ? plannedPlan?.tss : day.workout?.tss }}
        </span>
        <span
          v-if="day.workout?.rpe"
          class="inline-flex items-center gap-1 shrink-0 text-xs text-[#BE185D] font-semibold bg-[#FDF2F8] border border-[#FBCFE8] rounded-full px-2 py-0.5 whitespace-nowrap tabular-nums"
          :title="rpeLabel"
          :aria-label="rpeLabel"
        >
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
          </svg>
          {{ day.workout?.rpe }}
        </span>

        <!-- Planned pill — the only action on a planned row. Buildable plans open
             the Manual / Auto build choice; outdoor plans (no builder) route
             straight to the completed-workout picker. -->
        <template v-else-if="isPlannedDay">
          <button
            v-if="isPlannedOutdoor"
            title="Open to log details"
            aria-label="Open planned workout to log details"
            class="inline-flex items-center gap-1.5 shrink-0 text-xs text-[#3B6E84] font-semibold bg-[#F1F7FA] border border-[#B8D5E0] rounded-full px-2.5 py-0.5 whitespace-nowrap cursor-pointer transition-colors hover:bg-[#e6f0f5] hover:border-[#4B88A2]"
            @click="emit('mark-completed')"
          >
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="17" rx="2" />
              <path d="M8 2v4" />
              <path d="M16 2v4" />
              <path d="M3 10h18" />
            </svg>
            Planned
          </button>
          <BikeSpinner v-else-if="isAutoBuilding" :size="20" />
          <div v-else-if="showBuildChoice" class="flex items-center gap-2">
            <button class="text-xs text-[#3B6E84] hover:text-[#4B88A2] font-semibold" @click="chooseFromScratch">
              Manual
            </button>
            <button class="text-xs text-[#3B6E84] hover:text-[#4B88A2] font-semibold" @click="chooseAutoBuild">
              Auto
            </button>
            <button class="text-xs text-stone-300 hover:text-stone-500" @click="showBuildChoice = false">
              Cancel
            </button>
          </div>
          <button
            v-else
            title="Open to log details"
            aria-label="Open planned workout to log details"
            class="inline-flex items-center gap-1.5 shrink-0 text-xs text-[#3B6E84] font-semibold bg-[#F1F7FA] border border-[#B8D5E0] rounded-full px-2.5 py-0.5 whitespace-nowrap cursor-pointer transition-colors hover:bg-[#e6f0f5] hover:border-[#4B88A2]"
            @click="showBuildChoice = true"
          >
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="17" rx="2" />
              <path d="M8 2v4" />
              <path d="M16 2v4" />
              <path d="M3 10h18" />
            </svg>
            Planned
          </button>
        </template>

        <!-- Standalone "mark as completed" tick — opens the completed-workout
             picker directly (the Planned pill is the build hand-off). Dimmed by
             default, not hover-gated, so it's reachable on touch. -->
        <button
          v-if="isPlannedDay"
          title="Mark as completed"
          aria-label="Mark as completed"
          class="flex items-center justify-center self-start shrink-0 w-9 h-9 -mt-2 rounded-full border-none bg-transparent text-[#4B88A2] opacity-65 transition-all hover:opacity-100 hover:text-[#3B6E84] hover:bg-[#e6f0f5]"
          @click="emit('mark-completed')"
        >
          <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M8 12l3 3 5-6" />
          </svg>
        </button>

        <!-- Overflow menu — Edit ride / Refresh from Wahoo / Re-upload FIT /
             photo overlay, then a separator and the destructive Delete workout.
             Available on every logged ride, including ones with parsed FIT data. -->
        <template v-if="!day.isRestDay && !isPlannedDay">
          <BikeSpinner v-if="isRefreshingRideData" :size="16" class="self-start shrink-0 -mt-1" />
          <UDropdownMenu
            v-else
            :items="rowMenuItems"
            :content="{ align: 'end' }"
            :ui="{ content: 'w-48' }"
          >
            <button
              title="More actions"
              aria-label="More actions"
              class="flex items-center justify-center self-start shrink-0 w-10 h-10 -mt-2.5 rounded-full border-none bg-transparent text-stone-300 opacity-55 transition-all hover:opacity-100 hover:text-orange-600 hover:bg-orange-50"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="2" />
                <circle cx="12" cy="12" r="2" />
                <circle cx="12" cy="19" r="2" />
              </svg>
            </button>
          </UDropdownMenu>
        </template>
      </template>
    </div>

  </div>
</template>
