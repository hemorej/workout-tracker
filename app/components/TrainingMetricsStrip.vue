<script setup lang="ts">
/**
 * Slim headline strip for the Training tab: today's date, this week's
 * TSS / hours / km (done of planned), CTL + TSB with their form labels (one
 * button → the form chart), and the page-level shortcuts in the `actions` slot
 * plus today's Zwift events. Stacks into a compact 3-column card below `sm`.
 */
import type { TrainingSummary } from '#shared/types/training'

const props = defineProps<{
  summary: TrainingSummary
  totals: WeekTotals
}>()

const emit = defineEmits<{ openHistory: [], openEvents: [] }>()

const now = new Date()
const weekday = now.toLocaleDateString('en-US', { weekday: 'short' })
const dateRest = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

const ctl = computed(() => props.summary.today.ctl)
const tsb = computed(() => props.summary.today.tsb)
const ctlTrend = computed(() => trendArrow(ctl.value, props.summary.weekAgo?.ctl))

/**
 * Form zone for TSB (common coaching guidelines):
 *  > 25 very fresh · 10–25 fresh · −10–10 neutral · −30– −10 tired · < −30 very fatigued
 */
const formZone = computed(() => {
  if (tsb.value > 25) return { label: 'Very fresh', colorClass: 'text-sky-600' }
  if (tsb.value > 10) return { label: 'Fresh', colorClass: 'text-emerald-600' }
  if (tsb.value > -10) return { label: 'Neutral', colorClass: 'text-stone-500' }
  if (tsb.value > -30) return { label: 'Tired', colorClass: 'text-amber-600' }
  return { label: 'Very fatigued', colorClass: 'text-red-600' }
})

/**
 * CTL band relative to the athlete's own trailing-year range, split into five
 * equal bands. No label when the range is too narrow (< 10 points) to mean anything.
 */
const MIN_CTL_SPAN = 10
const FITNESS_BANDS = ['Low', 'Building', 'Solid', 'High', 'Peak']
const fitnessLabel = computed(() => {
  const range = props.summary.ctlRange
  if (!range || range.max - range.min < MIN_CTL_SPAN) return null
  const pos = (ctl.value - range.min) / (range.max - range.min)
  return FITNESS_BANDS[Math.min(4, Math.max(0, Math.floor(pos * 5)))]
})
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-7 gap-y-3 rounded-[14px] border border-[#f0eeec] bg-white px-4 py-3 sm:flex-nowrap sm:gap-x-6 sm:px-[22px] sm:py-3.5">
    <span class="w-full text-xl font-bold tabular sm:w-auto"><span class="text-primary">{{ weekday }}</span> {{ dateRest }}</span>
    <span class="hidden h-7 w-px bg-[#e7e5e0] sm:block" />

    <div class="grid w-full grid-cols-3 gap-3 sm:contents">
      <div class="flex flex-col">
        <span class="text-[11px] font-medium uppercase tracking-[.08em] text-stone-500">TSS<span class="hidden sm:inline"> this week</span></span>
        <span class="text-[17px] font-bold tabular sm:text-lg">{{ totals.doneTss }} <span class="text-xs font-medium text-stone-500">/ {{ totals.plannedTss }}</span></span>
      </div>
      <div class="hidden flex-col sm:flex">
        <span class="text-[11px] font-medium uppercase tracking-[.08em] text-stone-500">Hours</span>
        <span class="text-lg font-bold tabular">{{ formatHours(totals.doneMinutes) }} <span class="text-xs font-medium text-stone-500">/ {{ formatHours(totals.plannedMinutes) }}</span></span>
      </div>
      <div class="hidden flex-col sm:flex">
        <span class="text-[11px] font-medium uppercase tracking-[.08em] text-stone-500">Km</span>
        <span class="text-lg font-bold tabular">{{ Math.round(totals.km) }}</span>
      </div>
      <span class="hidden h-7 w-px bg-[#e7e5e0] sm:block" />

      <button type="button" class="flex cursor-pointer gap-[22px] text-left" title="View CTL/TSB history" @click="emit('openHistory')">
        <span class="flex flex-col">
          <span class="text-[11px] font-semibold uppercase tracking-[.08em] text-emerald-600">CTL</span>
          <span class="flex items-baseline gap-1.5 text-[17px] font-bold tabular sm:text-lg">
            {{ ctl.toFixed(1) }}
            <span v-if="ctlTrend" class="inline-flex flex-col items-center self-center text-[11px] leading-[0.75]" :class="ctlTrend.colorClass">
              <span v-for="i in ctlTrend.count" :key="i">{{ ctlTrend.symbol }}</span>
            </span>
            <span class="hidden text-xs font-medium text-stone-600 sm:inline">Fitness<template v-if="fitnessLabel"> · {{ fitnessLabel }}</template></span>
          </span>
        </span>
        <span class="flex flex-col">
          <span class="text-[11px] font-semibold uppercase tracking-[.08em] text-amber-700">TSB</span>
          <span class="text-[17px] font-bold tabular sm:text-lg">{{ formatSigned(tsb) }} <span class="hidden text-xs font-medium sm:inline" :class="formZone.colorClass">{{ formZone.label }}</span></span>
        </span>
      </button>
    </div>

    <span class="hidden flex-1 sm:block" />
    <div class="flex shrink-0 items-center gap-4 whitespace-nowrap">
      <slot name="actions" />
      <button
        type="button"
        class="inline-flex cursor-pointer items-center gap-1.5 text-[13px] font-semibold text-orange-700 hover:text-orange-800"
        @click="emit('openEvents')"
      >
        <MountainIcon class="size-[15px]" />
        Zwift events
      </button>
    </div>
  </div>
</template>
