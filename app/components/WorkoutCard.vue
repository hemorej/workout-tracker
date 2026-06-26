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

import type { DayEntry } from '~/stores/workouts'

interface Props {
  day: DayEntry
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'delete', id: number): void
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

// ── TSB colouring — muted, in line with the stone palette ───────────────
const tsbColor = computed(() => {
  const tsb = props.day.metrics.tsb
  if (tsb > 10)  return 'text-emerald-500'
  if (tsb > -10) return 'text-stone-500'
  if (tsb > -30) return 'text-amber-500'
  return 'text-rose-400'
})

const tsbDisplay = computed(() => {
  const v = props.day.metrics.tsb
  return v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1)
})

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
    Each day is a flat list row, not a card.
    Workout rows have a 2px left accent line in sky-200.
    Rest days are visually quieter — no accent, lighter text.
    The parent (index.vue) wraps all rows in a single white container
    with divide-y so the borders render between rows, not around each one.
  -->
  <div
    class="relative flex items-start gap-5 px-6 py-4 group transition-colors hover:bg-stone-50"
    :class="day.isRestDay ? 'opacity-50' : ''"
  >
    <!-- Left accent line — only on workout days -->
    <div
      v-if="!day.isRestDay"
      class="absolute left-0 top-3 bottom-3 w-1 bg-orange-500 rounded-full"
    />

    <!-- Date column — fixed width, right-aligned -->
    <div class="w-20 shrink-0 text-right pt-0.5">
      <p class="text-sm font-semibold text-stone-600">{{ formattedDate }}</p>
      <p class="text-xs text-stone-300 mt-0.5">{{ isoDate }}</p>
    </div>

    <!-- Main content -->
    <div class="flex-1 min-w-0">

      <!-- Rest day -->
      <p v-if="day.isRestDay" class="text-sm text-stone-400 italic pt-0.5">
        Rest
      </p>

      <!-- Workout day -->
      <div v-else>
        <!-- Name row -->
        <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span class="text-base font-semibold text-stone-800 truncate max-w-xs">
            {{ day.workout?.name }}
          </span>
          <span class="text-sm text-stone-400">{{ durationDisplay }}</span>
          <!-- Inline pill tags — plain spans, no UBadge -->
          <span class="text-xs text-sky-600 font-semibold bg-sky-50 rounded-full px-2.5 py-0.5">
            {{ day.workout?.tss }} TSS
          </span>
          <span
            v-if="day.workout?.rpe"
            class="text-xs text-stone-500 font-semibold bg-stone-100 rounded-full px-2.5 py-0.5"
          >
            RPE {{ day.workout?.rpe }}/10
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

      <!-- Metrics row — CTL / ATL / TSB — shown for every day -->
      <div class="flex gap-4 mt-1.5 text-xs text-stone-300 tabular">
        <span>CTL <span class="text-stone-500">{{ day.metrics.ctl.toFixed(1) }}</span></span>
        <span>ATL <span class="text-stone-500">{{ day.metrics.atl.toFixed(1) }}</span></span>
        <span>TSB <span :class="tsbColor">{{ tsbDisplay }}</span></span>
      </div>
    </div>

    <!-- Delete button — appears on hover only -->
    <div v-if="!day.isRestDay" class="shrink-0 self-center opacity-0 group-hover:opacity-100 transition-opacity">
      <div v-if="!showDeleteConfirm">
        <button
          class="text-xs text-stone-300 hover:text-rose-400 transition-colors"
          aria-label="Delete workout"
          @click="requestDelete"
        >
          Delete
        </button>
      </div>
      <!-- Inline confirmation -->
      <div v-else class="flex items-center gap-2">
        <button class="text-xs text-rose-400 hover:text-rose-600 font-medium" @click="confirmDelete">
          Confirm
        </button>
        <button class="text-xs text-stone-300 hover:text-stone-500" @click="showDeleteConfirm = false">
          Cancel
        </button>
      </div>
    </div>

  </div>
</template>
