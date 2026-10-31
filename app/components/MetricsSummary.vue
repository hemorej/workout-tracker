<script setup lang="ts">
/**
 * MetricsSummary component
 *
 * Displays the headline stats at the top of the dashboard, grouped into
 * two sections:
 *   - "This week": weekly TSS total, weekly training hours, weekly distance (km)
 *   - "Form": CTL (Fitness) with a 7-day trend arrow, TSB (Form)
 *
 * Also shows a "form zone" label for TSB to give the user an at-a-glance
 * interpretation of where they stand.
 *
 * Props are plain numbers passed down from the index page, which gets them
 * from the workouts store.
 */

interface Props {
  todayWeekday: string
  todayDatePart: string
  weeklyTss: number
  weeklyHours: number
  weeklyKm: number
  todayCTL: number
  todayATL: number
  todayTSB: number
  weekAgoCTL?: number | null
  ctlRange?: { min: number, max: number } | null
}

const props = defineProps<Props>()

const emit = defineEmits<{ (e: 'open-history'): void }>()

/** CTL trend arrow (vs. 7 days ago) shown next to the big number */
const ctlTrend = computed(() => trendArrow(props.todayCTL, props.weekAgoCTL))

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
  if (tsb > 25)  return { label: 'Very fresh',   colorClass: 'text-sky-600' }
  if (tsb > 10)  return { label: 'Fresh',        colorClass: 'text-emerald-600' }
  if (tsb > -10) return { label: 'Neutral',      colorClass: 'text-stone-500' }
  if (tsb > -30) return { label: 'Tired',        colorClass: 'text-amber-600' }
  return           { label: 'Very fatigued', colorClass: 'text-red-600' }
})

/**
 * Maps CTL to a fitness band relative to the athlete's own trailing-year
 * range (from the API): the min..max span is split into five equal bands —
 * Low, Building, Solid, High, Peak. No label when the range is too narrow
 * (< 10 CTL points) for bands to mean anything, e.g. very little history.
 */
const MIN_CTL_SPAN = 10
const FITNESS_BANDS = ['Low', 'Building', 'Solid', 'High', 'Peak']
const fitnessLabel = computed(() => {
  const range = props.ctlRange
  if (!range || range.max - range.min < MIN_CTL_SPAN) return null
  const pos = (props.todayCTL - range.min) / (range.max - range.min)
  return FITNESS_BANDS[Math.min(4, Math.max(0, Math.floor(pos * 5)))]
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

    <!-- Today (mobile only) -->
    <div class="sm:hidden flex items-baseline justify-between pb-[9px] border-b-2 border-[#e7e5e0] mb-3">
      <p class="text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500">Today</p>
      <p class="text-xl font-bold text-stone-900 tabular">
        <span class="text-primary">{{ todayWeekday }}</span> {{ todayDatePart }}
      </p>
    </div>

    <div class="grid grid-cols-[3fr_2fr] sm:grid-cols-[auto_3fr_2fr] gap-3 sm:gap-7">

      <!-- Today (sm and up) -->
      <div class="hidden sm:block">
        <p class="text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500 pb-[10px] border-b-2 border-[#e7e5e0] mb-2.5">
          Today
        </p>
        <p aria-hidden="true" class="invisible text-[11px] font-medium uppercase tracking-[0.08em] mb-2.5">.</p>
        <p class="text-xl sm:text-[25px] font-bold text-stone-900 tabular whitespace-nowrap">
          <span class="text-primary">{{ todayWeekday }}</span> {{ todayDatePart }}
        </p>
      </div>

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
              <span
                v-if="ctlTrend"
                class="inline-flex flex-col items-center text-[11px] leading-[0.75] self-center"
                :class="ctlTrend.colorClass"
              >
                <span v-for="i in ctlTrend.count" :key="i">{{ ctlTrend.symbol }}</span>
              </span>
            </p>
            <p class="text-[11px] text-stone-500 mt-1">Fitness<template v-if="fitnessLabel"> · {{ fitnessLabel }}</template></p>
          </div>
          <div>
            <p class="text-[11px] font-medium uppercase tracking-[0.08em] text-amber-600 mb-1.5">TSB</p>
            <p class="flex items-baseline gap-1.5">
              <span class="text-xl sm:text-[30px] font-bold text-stone-900 tabular">{{ tsbDisplay }}</span>
            </p>
            <p class="text-[11px] font-medium mt-1" :class="formZone.colorClass">{{ formZone.label }}</p>
          </div>
        </div>
      </button>

    </div>
  </div>
</template>
