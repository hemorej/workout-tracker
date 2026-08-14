<script setup lang="ts">
/**
 * WorkoutFitOverlay — small "brief ride stats" popup shown when clicking a
 * logged workout's title in the training log, for workouts that have a
 * parsed FIT file's extra stats (`workout.fitData`) attached.
 *
 * Self-contained (owns its own Teleport + v-if), unlike AddWorkoutModal
 * (whose Teleport wrapper lives in the parent) — there's no shared open
 * state to coordinate here, just "show when a workout is passed in".
 *
 * Everything shown comes straight off the WorkoutDetail already loaded by
 * the training log list — no extra fetch.
 */

import type { WorkoutDetail } from '~/stores/workouts'

const props = defineProps<{
  /** The workout to show stats for. Overlay is visible whenever this is non-null. */
  workout: WorkoutDetail | null
}>()

defineEmits<{
  close: []
}>()

const POWER_BEST_DURATIONS = [
  '5sec', '15sec', '30sec', '1min', '2min', '3min', '5min',
  '8min', '10min', '15min', '20min', '30min', '45min', '1h',
] as const

const sortedPowerBests = computed(() => {
  const bests = props.workout?.powerBests ?? []
  const order = new Map(POWER_BEST_DURATIONS.map((d, i) => [d, i]))
  return [...bests].sort((a, b) => (order.get(a.duration as typeof POWER_BEST_DURATIONS[number]) ?? 99) - (order.get(b.duration as typeof POWER_BEST_DURATIONS[number]) ?? 99))
})

const durationDisplay = computed(() => {
  const mins = props.workout?.durationMinutes ?? 0
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
})

const distanceDisplay = computed(() => {
  const km = props.workout?.distanceKm
  return km != null ? `${km.toFixed(1)} km` : null
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="workout"
      class="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Ride stats"
    >
      <div
        class="fixed inset-0 bg-black/25 backdrop-blur-sm"
        @click="$emit('close')"
      />

      <div class="relative bg-white rounded-2xl shadow-xl w-full max-w-md p-6 my-8">
        <div class="flex items-start justify-between mb-5">
          <div>
            <h2 class="text-lg font-semibold text-stone-900">{{ workout.name }}</h2>
            <p class="text-sm text-stone-400 mt-0.5">
              {{ durationDisplay }}<template v-if="distanceDisplay"> &nbsp;·&nbsp; {{ distanceDisplay }}</template>
            </p>
          </div>
          <button
            class="text-stone-300 hover:text-stone-600 transition-colors ml-4 mt-0.5"
            aria-label="Close"
            @click="$emit('close')"
          >
            <UIcon name="i-heroicons-x-mark" class="w-5 h-5" />
          </button>
        </div>

        <!-- Headline stats grid -->
        <div class="grid grid-cols-3 gap-3 mb-5">
          <div class="bg-stone-50 rounded-lg px-3 py-2.5 text-center">
            <p class="text-lg font-semibold text-stone-800 tabular">{{ workout.tss }}</p>
            <p class="text-[10px] font-semibold text-stone-400 uppercase tracking-wide mt-0.5">TSS</p>
          </div>
          <div v-if="workout.fitData" class="bg-stone-50 rounded-lg px-3 py-2.5 text-center">
            <p class="text-lg font-semibold text-stone-800 tabular">{{ workout.fitData.normalizedPower }}<span class="text-xs font-medium text-stone-400">W</span></p>
            <p class="text-[10px] font-semibold text-stone-400 uppercase tracking-wide mt-0.5">NP</p>
          </div>
          <div v-if="workout.fitData" class="bg-stone-50 rounded-lg px-3 py-2.5 text-center">
            <p class="text-lg font-semibold text-stone-800 tabular">{{ workout.fitData.intensityFactor.toFixed(2) }}</p>
            <p class="text-[10px] font-semibold text-stone-400 uppercase tracking-wide mt-0.5">IF</p>
          </div>
        </div>

        <!-- Power / HR / cadence detail rows -->
        <div v-if="workout.fitData" class="space-y-1.5 mb-5 text-sm">
          <div class="flex items-center justify-between">
            <span class="text-stone-400">Power (avg / max)</span>
            <span class="text-stone-700 font-medium tabular">{{ workout.fitData.avgPower }}W / {{ workout.fitData.maxPower }}W</span>
          </div>
          <div v-if="workout.fitData.avgHr != null || workout.fitData.maxHr != null" class="flex items-center justify-between">
            <span class="text-stone-400">Heart rate (avg / max)</span>
            <span class="text-stone-700 font-medium tabular">
              {{ workout.fitData.avgHr ?? '—' }}<template v-if="workout.fitData.avgHr != null">bpm</template>
              / {{ workout.fitData.maxHr ?? '—' }}<template v-if="workout.fitData.maxHr != null">bpm</template>
            </span>
          </div>
          <div v-if="workout.fitData.avgCadence != null || workout.fitData.maxCadence != null" class="flex items-center justify-between">
            <span class="text-stone-400">Cadence (avg / max)</span>
            <span class="text-stone-700 font-medium tabular">
              {{ workout.fitData.avgCadence ?? '—' }}<template v-if="workout.fitData.avgCadence != null">rpm</template>
              / {{ workout.fitData.maxCadence ?? '—' }}<template v-if="workout.fitData.maxCadence != null">rpm</template>
            </span>
          </div>
        </div>

        <!-- Power breakdown -->
        <div v-if="sortedPowerBests.length > 0" class="mb-5">
          <p class="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2">Power breakdown</p>
          <div class="grid grid-cols-3 gap-x-4 gap-y-1 text-sm">
            <div v-for="pb in sortedPowerBests" :key="pb.duration" class="flex items-baseline justify-between">
              <span class="text-stone-400 text-xs">{{ pb.duration }}</span>
              <span class="text-stone-700 font-medium tabular">{{ pb.watts }}W</span>
            </div>
          </div>
        </div>

        <!-- RPE -->
        <div v-if="workout.rpe" class="flex items-center justify-between text-sm mb-3">
          <span class="text-stone-400">RPE</span>
          <span class="text-stone-700 font-medium">{{ workout.rpe }}/10</span>
        </div>

        <!-- Notes -->
        <div v-if="workout.notes">
          <p class="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-1.5">Notes</p>
          <p class="text-sm text-stone-600 whitespace-pre-wrap">{{ workout.notes }}</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>
