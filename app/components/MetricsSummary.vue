<script setup lang="ts">
/**
 * MetricsSummary component
 *
 * Displays the headline stats at the top of the dashboard, grouped into
 * two sections:
 *   - "This week": weekly TSS total, weekly training hours, weekly distance (km)
 *   - "Form": CTL (Fitness), TSB (Form)
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
  weeklyKm: number
  todayCTL: number
  todayATL: number
  todayTSB: number
  yesterdayCTL?: number | null
  yesterdayTSB?: number | null
}

const props = defineProps<Props>()

const emit = defineEmits<{ (e: 'open-history'): void }>()

/** Trend arrows (CTL/TSB vs. yesterday) shown next to the big numbers */
const ctlTrend = computed(() => trendArrow(props.todayCTL, props.yesterdayCTL))
const tsbTrend = computed(() => trendArrow(props.todayTSB, props.yesterdayTSB))

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
  if (tsb > 25)  return { label: 'Very fresh' }
  if (tsb > 10)  return { label: 'Fresh' }
  if (tsb > -10) return { label: 'Neutral' }
  if (tsb > -30) return { label: 'Tired' }
  return           { label: 'Very fatigued' }
})

/** Format TSB with a leading + for positive values */
const tsbDisplay = computed(() =>
  props.todayTSB >= 0 ? `+${props.todayTSB.toFixed(1)}` : props.todayTSB.toFixed(1),
)
</script>

<template>
  <!--
    Metrics card: one white panel split into two label-headed groups —
    "This week" (TSS / Hours / Km) and "Form" (CTL / TSB) — separated by
    a 2fr/1.33fr-ish column ratio (3fr/2fr) so each side's stat columns line
    up evenly despite the 3-vs-2 stat count. A 2px bottom rule under each
    group label replaces the old full-height dividers between every stat.
  -->
  <div class="bg-white rounded-[14px] border border-[#f0eeec] px-4 py-5 sm:px-7 sm:py-6">
    <div class="grid grid-cols-[3fr_2fr] gap-3 sm:gap-7">

      <!-- This week -->
      <div>
        <p class="text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500 pb-[10px] border-b-2 border-[#e7e5e0] mb-2.5">
          This week
        </p>
        <div class="grid grid-cols-3 gap-2 sm:gap-5">
          <div>
            <p class="text-[11px] font-medium uppercase tracking-[0.08em] text-stone-400 mb-1.5">TSS</p>
            <p class="text-xl sm:text-[30px] font-bold text-stone-900 tabular">{{ weeklyTss }}</p>
          </div>
          <div>
            <p class="text-[11px] font-medium uppercase tracking-[0.08em] text-stone-400 mb-1.5">Hours</p>
            <p class="text-xl sm:text-[30px] font-bold text-stone-900 tabular">{{ weeklyHours.toFixed(1) }}</p>
          </div>
          <div>
            <p class="text-[11px] font-medium uppercase tracking-[0.08em] text-stone-400 mb-1.5">Km</p>
            <p class="text-xl sm:text-[30px] font-bold text-stone-900 tabular">{{ weeklyKm }}</p>
          </div>
        </div>
      </div>

      <!-- Today -->
      <button
        type="button"
        class="text-left cursor-pointer w-full rounded-lg -m-1 p-1 transition-colors hover:bg-stone-50"
        title="View CTL/TSB history"
        @click="emit('open-history')"
      >
        <p class="text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500 pb-[10px] border-b-2 border-[#e7e5e0] mb-2.5">
          Form
        </p>
        <div class="grid grid-cols-2 gap-2 sm:gap-5">
          <div>
            <p class="text-[11px] font-medium uppercase tracking-[0.08em] text-emerald-600 mb-1.5">CTL</p>
            <p class="flex items-baseline gap-1.5">
              <span class="text-xl sm:text-[30px] font-bold text-stone-900 tabular">{{ todayCTL.toFixed(1) }}</span>
              <span v-if="ctlTrend" class="text-[13px]" :class="ctlTrend.colorClass">{{ ctlTrend.symbol }}</span>
            </p>
            <p class="text-[11px] text-stone-500 mt-1">Fitness</p>
          </div>
          <div>
            <p class="text-[11px] font-medium uppercase tracking-[0.08em] text-amber-600 mb-1.5">TSB</p>
            <p class="flex items-baseline gap-1.5">
              <span class="text-xl sm:text-[30px] font-bold text-stone-900 tabular">{{ tsbDisplay }}</span>
              <span v-if="tsbTrend" class="text-[13px]" :class="tsbTrend.colorClass">{{ tsbTrend.symbol }}</span>
            </p>
            <p class="text-[11px] text-stone-500 mt-1">{{ formZone.label }}</p>
          </div>
        </div>
      </button>

    </div>
  </div>
</template>
