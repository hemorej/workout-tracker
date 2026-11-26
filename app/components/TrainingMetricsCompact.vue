<script setup lang="ts">
/**
 * Phone-only slim stand-in for TrainingMetricsStrip: one line with the date and
 * this week's TSS plus CTL / TSB in small type. TrainingTab fades it in while the
 * pinned metrics + search block gives way to it on scroll-down (see useScrollCollapse);
 * tapping it opens the same CTL/TSB history chart as the full card.
 */
import type { TrainingSummary } from '#shared/types/training'

const props = defineProps<{
  summary: TrainingSummary
  totals: WeekTotals
}>()

const emit = defineEmits<{ openHistory: [] }>()

const now = new Date()
const weekday = now.toLocaleDateString('en-US', { weekday: 'short' })
const dateRest = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

const ctl = computed(() => props.summary.today.ctl)
const tsb = computed(() => props.summary.today.tsb)
const ctlTrend = computed(() => trendArrow(ctl.value, props.summary.weekAgo?.ctl))
</script>

<template>
  <button
    type="button"
    class="flex w-full cursor-pointer items-center justify-between gap-2 whitespace-nowrap rounded-[10px] border border-[#f0eeec] bg-white px-3 py-1.5 text-left text-[12.5px] shadow-[0_1px_2px_rgba(28,25,23,.06)]"
    title="View CTL/TSB history"
    @click="emit('openHistory')"
  >
    <span class="font-bold tabular"><span class="text-primary">{{ weekday }}</span> {{ dateRest }}</span>
    <span class="tabular">
      <span class="text-[10px] font-medium uppercase tracking-[.08em] text-stone-500">TSS</span>
      <span class="font-bold"> {{ totals.doneTss }}</span><span class="text-[11px] text-stone-500"> / {{ totals.plannedTss }}</span>
    </span>
    <span class="tabular">
      <span class="text-[10px] font-semibold uppercase tracking-[.08em] text-emerald-600">CTL</span>
      <span class="font-bold"> {{ ctl.toFixed(1) }}</span>
      <span v-if="ctlTrend" class="text-[9px] tracking-[-.1em]" :class="ctlTrend.colorClass">{{ ctlTrend.symbol.repeat(ctlTrend.count) }}</span>
    </span>
    <span class="tabular">
      <span class="text-[10px] font-semibold uppercase tracking-[.08em] text-amber-700">TSB</span>
      <span class="font-bold"> {{ formatSigned(tsb) }}</span>
    </span>
  </button>
</template>
