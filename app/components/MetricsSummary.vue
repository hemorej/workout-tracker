<script setup lang="ts">
/**
 * MetricsSummary component
 *
 * Displays the four headline stats at the top of the dashboard:
 *   - Weekly TSS total
 *   - Weekly training hours
 *   - Today's CTL (Fitness)
 *   - Today's TSB (Form)
 *
 * Also shows a colour-coded "form zone" label for TSB to give the user
 * an at-a-glance interpretation of where they stand.
 *
 * Props are plain numbers passed down from the index page, which gets them
 * from the workouts store.
 */

interface Props {
  weeklyTss: number
  weeklyHours: number
  todayCTL: number
  todayATL: number
  todayTSB: number
}

const props = defineProps<Props>()

/**
 * Maps TSB to a form zone label + text colour class.
 *
 * Zones (common coaching guidelines):
 *  > 25          : Very fresh — possibly detrained
 *  10 to 25      : Fresh — good race condition
 *  -10 to 10     : Neutral — moderate readiness
 *  -30 to -10    : Tired — productive training zone
 *  < -30         : Very fatigued — risk of overtraining
 */
const formZone = computed(() => {
  const tsb = props.todayTSB
  if (tsb > 25)  return { label: 'Very fresh',  textColor: 'text-sky-400' }
  if (tsb > 10)  return { label: 'Fresh',        textColor: 'text-emerald-400' }
  if (tsb > -10) return { label: 'Neutral',      textColor: 'text-stone-400' }
  if (tsb > -30) return { label: 'Tired',        textColor: 'text-amber-400' }
  return           { label: 'Very fatigued', textColor: 'text-rose-400' }
})

/** Colour the TSB number itself to match the zone */
const tsbNumberColor = computed(() => {
  const tsb = props.todayTSB
  if (tsb > 10)  return 'text-emerald-500'
  if (tsb > -10) return 'text-stone-800'
  if (tsb > -30) return 'text-amber-500'
  return 'text-rose-500'
})

/** Format TSB with a leading + for positive values */
const tsbDisplay = computed(() =>
  props.todayTSB >= 0 ? `+${props.todayTSB.toFixed(1)}` : props.todayTSB.toFixed(1),
)
</script>

<template>
  <!--
    Metrics strip: a single white panel divided into four stat cells.
    On mobile the four cells wrap into a 2×2 grid using CSS grid.
    No individual card shadows — the container has one thin border.
  -->
  <div class="bg-white rounded-xl border border-stone-100 grid grid-cols-2 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-stone-100">

    <!-- Weekly TSS -->
    <div class="px-6 py-5 text-center">
      <p class="text-xs font-semibold uppercase tracking-widest text-stone-400 mb-2">
        Weekly TSS
      </p>
      <p class="text-4xl font-semibold text-stone-900 tabular">
        {{ weeklyTss }}
      </p>
    </div>

    <!-- Weekly Hours -->
    <div class="px-6 py-5 text-center">
      <p class="text-xs font-semibold uppercase tracking-widest text-stone-400 mb-2">
        Hours
      </p>
      <p class="text-4xl font-semibold text-stone-900 tabular">
        {{ weeklyHours.toFixed(1) }}
      </p>
    </div>

    <!-- CTL (Fitness) -->
    <div class="px-6 py-5 text-center border-t md:border-t-0 border-stone-100">
      <p class="text-xs font-semibold uppercase tracking-widest text-stone-400 mb-2">
        CTL
      </p>
      <p class="text-4xl font-semibold text-stone-900 tabular">
        {{ todayCTL.toFixed(1) }}
      </p>
      <p class="text-xs text-stone-300 mt-1">Fitness</p>
    </div>

    <!-- TSB (Form) -->
    <div class="px-6 py-5 text-center border-t md:border-t-0 border-stone-100">
      <p class="text-xs font-semibold uppercase tracking-widest text-stone-400 mb-2">
        TSB
      </p>
      <p class="text-4xl font-semibold tabular" :class="tsbNumberColor">
        {{ tsbDisplay }}
      </p>
      <!-- Subtle form zone label — no heavy badge, just small text -->
      <p class="text-xs mt-1" :class="formZone.textColor">
        {{ formZone.label }}
      </p>
    </div>

  </div>
</template>
