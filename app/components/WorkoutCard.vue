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
 *   - Duration + TSS + optional RPE
 *   - Optional notes (truncated, expandable)
 *   - CTL, ATL, TSB metrics for that day
 *   - A delete button for workout days
 *
 * Emits:
 *   delete — when the user confirms deletion (parent calls the store)
 */

import type { DayEntry, DayMetrics } from '~/stores/workouts'
import type { PlannedDay } from '~/stores/planning'

interface Props {
  day: DayEntry
  plannedWorkout?: PlannedDay | null
  /** Previous chronological day's metrics, used to compute trend arrows */
  prevMetrics?: DayMetrics | null
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'delete', id: number): void
  (e: 'mark-completed'): void
  (e: 'go-to-builder'): void
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

  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
})

/** Full ISO date shown as a subtitle */
const isoDate = computed(() => props.day.date)

/** Duration formatted as "Xh Ym" */
const durationDisplay = computed(() => {
  const mins = props.day.workout?.durationMinutes ?? 0
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
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

// When showing a planned workout, use the projected CTL/ATL/TSB from the planning store
const displayMetrics = computed(() => {
  if (isPlannedDay.value && props.plannedWorkout) {
    const ctl = props.plannedWorkout.projectedCtl
    const tsb = props.plannedWorkout.projectedTsb
    return { ctl, atl: Math.round((ctl - tsb) * 10) / 10, tsb }
  }
  return props.day.metrics
})

// ── Power data indicators ────────────────────────────────────────────────
const hasFtp = computed(() => !!props.day.workout?.ftpWatts)
const hasPowerBests = computed(() => (props.day.workout?.powerBests?.length ?? 0) > 0)

// ── TSB colouring — muted, in line with the stone palette ───────────────
const tsbColor = computed(() => {
  const tsb = displayMetrics.value.tsb
  if (tsb > 10)  return 'text-emerald-600'
  if (tsb > -10) return 'text-stone-600'
  if (tsb > -30) return 'text-amber-600'
  return 'text-rose-500'
})

const tsbDisplay = computed(() => {
  const v = displayMetrics.value.tsb
  return v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1)
})

// ── Trend arrows — CTL/ATL/TSB direction vs. the previous entry ─────────
const ctlTrend = computed(() => trendArrow(displayMetrics.value.ctl, props.prevMetrics?.ctl))
const atlTrend = computed(() => trendArrow(displayMetrics.value.atl, props.prevMetrics?.atl))
const tsbTrend = computed(() => trendArrow(displayMetrics.value.tsb, props.prevMetrics?.tsb))

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
      84px date | flexible title/metrics | 74px TSS pill | 132px [RPE-or-Planned pill + action icon]
    The TSS column is separate so every TSS pill's right edge lines up
    regardless of digit count. The last column groups the RPE/Planned pill
    with the row's action icon in a single flex-end row with a small gap,
    so they sit snug together instead of spreading across the column.
    Workout rows have a left accent line in orange-600.
    Rest days are visually quieter — no accent, lighter text.
    The parent (index.vue) wraps all rows in a single white container
    with divide-y so the borders render between rows, not around each one.
  -->
  <div
    class="relative grid items-start gap-x-5 px-6 py-[18px] transition-colors hover:bg-stone-50"
    style="grid-template-columns: 84px minmax(160px,1fr) 232px;"
    :class="day.isRestDay && !isPlannedDay ? 'opacity-50' : ''"
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
      <p class="text-xs text-stone-500 mt-0.5">{{ isoDate }}</p>
    </div>

    <!-- Column 2: title/duration + notes + metrics — absorbs variable-length text -->
    <div class="min-w-0">

      <!-- Rest day -->
      <p v-if="day.isRestDay && !isPlannedDay" class="text-sm text-stone-400 italic pt-0.5">
        Rest
      </p>

      <!-- Planned workout (today, not yet logged) -->
      <div v-else-if="isPlannedDay">
        <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span class="text-base font-medium text-stone-500 italic truncate max-w-xs">
            {{ plannedPlan?.name || 'Planned workout' }}
          </span>
          <span v-if="plannedDurationDisplay" class="text-sm text-stone-400">{{ plannedDurationDisplay }}</span>
        </div>
      </div>

      <!-- Workout day -->
      <div v-else>
        <!-- Name row -->
        <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span class="text-base font-semibold text-stone-800 truncate max-w-xs">
            {{ day.workout?.name }}
          </span>
          <span class="text-sm text-stone-400">{{ durationDisplay }}</span>
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

      <!-- Metrics row — CTL / ATL / TSB with trend arrows, shown for every day -->
      <div class="flex gap-4 mt-1.5 text-xs text-stone-500 tabular">
        <span>
          CTL <span class="font-semibold text-stone-700">{{ displayMetrics.ctl.toFixed(1) }}</span
          ><span v-if="ctlTrend" class="ml-0.5 text-[10px]" :class="ctlTrend.colorClass">{{ ctlTrend.symbol }}</span>
        </span>
        <span>
          ATL <span class="font-semibold text-stone-700">{{ displayMetrics.atl.toFixed(1) }}</span
          ><span v-if="atlTrend" class="ml-0.5 text-[10px]" :class="atlTrend.colorClass">{{ atlTrend.symbol }}</span>
        </span>
        <span>
          TSB <span :class="tsbColor">{{ tsbDisplay }}</span
          ><span v-if="tsbTrend" class="ml-0.5 text-[10px]" :class="tsbTrend.colorClass">{{ tsbTrend.symbol }}</span>
        </span>
      </div>
    </div>

    <!-- Column 3: PR badge, TSS pill, RPE-or-Planned pill, and action icon — all on
         one row, evenly spaced and right-aligned as a single group so every row's
         icon (and, absent a PR badge, every pill) lines up horizontally -->
    <div class="pt-0.5 flex items-center justify-end gap-2">
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
      <button
        v-else-if="isPlannedDay"
        title="Go to workout builder"
        class="inline-block text-xs text-violet-600 font-semibold bg-violet-100 border border-violet-200 rounded-full px-2.5 py-0.5 whitespace-nowrap cursor-pointer transition-colors hover:bg-violet-200"
        @click="emit('go-to-builder')"
      >
        Planned
      </button>

      <!-- Mark as completed — primary action for a planned-but-not-logged day.
           Rendered at low opacity by default (not hover-gated) so it's reachable on touch. -->
      <button
        v-if="isPlannedDay"
        title="Mark as completed"
        aria-label="Mark as completed"
        class="flex items-center justify-center shrink-0 w-9 h-9 rounded-full border-none bg-transparent text-violet-300 opacity-65 transition-all hover:opacity-100 hover:text-violet-600 hover:bg-violet-100"
        @click="emit('mark-completed')"
      >
        <svg class="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M8 12l3 3 5-6" />
        </svg>
      </button>

      <!-- Delete control — always rendered (dimmed, not hover-gated) so it's reachable on touch -->
      <template v-if="!day.isRestDay && !isPlannedDay">
        <button
          v-if="!showDeleteConfirm"
          title="Delete workout"
          aria-label="Delete workout"
          class="flex items-center justify-center shrink-0 w-10 h-10 rounded-full border-none bg-transparent text-stone-300 opacity-55 transition-all hover:opacity-100 hover:text-rose-600 hover:bg-rose-50"
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
        <div v-else class="flex items-center gap-2">
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
