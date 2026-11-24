<script setup lang="ts">
/**
 * One Monday–Sunday row of the Training grid: the week label (range, TSS,
 * progress, hours/km) followed by seven day cells. Below `sm` the label sits
 * above a 7-column strip of compact cells instead.
 */
import type { PlanEntry } from '#shared/types/training'

const props = defineProps<{
  week: TrainingWeek
  /** Suggest-plan draft: replaces the plan on editable days. */
  draft?: Record<string, PlanEntry> | null
  /** TSB per date, draft-aware (falls back to each day's own metrics). */
  tsbByDate?: Record<string, { tsb: number }> | null
  /** Search: dates that match (null = no search running) and the text to highlight. */
  matches?: Set<string> | null
  query?: string
  openDate?: string | null
  dropDate?: string | null
  dragDate?: string | null
  /** Suggest-plan block-slot label for this week ("Build 2"), and whether it's still generating. */
  suggestLabel?: string | null
  generating?: boolean
}>()

const emit = defineEmits<{ action: [DayAction] }>()

const isCurrent = computed(() => props.week.days.some(d => d.isToday))
const isPast = computed(() => !isCurrent.value && props.week.days[6]!.isPast)

/** Days as displayed: the draft's plan stands in on editable days. */
function planFor(day: TrainingWeek['days'][number]) {
  return (!isActualDay(day) && props.draft?.[day.date]) || day.plan
}
// Without a draft the store's own day objects are passed through, so a cell whose day didn't change doesn't re-render.
const shownDays = computed(() => (props.draft ? props.week.days.map(d => ({ ...d, plan: planFor(d) })) : props.week.days))
const totals = computed(() => weekTotals(shownDays.value))
const savedPlannedTss = computed(() => weekTotals(props.week.days).plannedTss)
const progress = computed(() => (totals.value.plannedTss ? Math.min(1, totals.value.doneTss / totals.value.plannedTss) : 0))

const matchCount = computed(() => props.matches ? props.week.days.filter(d => props.matches!.has(d.date)).length : 0)
</script>

<template>
  <div
    :data-week="week.monday"
    class="px-1 pb-2.5 pt-2 transition-opacity sm:grid sm:grid-cols-[150px_repeat(7,minmax(0,1fr))] sm:gap-1.5 sm:px-2.5"
    :class="[
      isCurrent && 'bg-orange-100 shadow-[inset_4px_0_0_#ea580c] sm:py-3.5',
      suggestLabel && 'rounded-xl border-[1.5px] border-dashed border-orange-400',
      generating && suggestLabel && 'opacity-60',
    ]"
  >
    <!-- Week label -->
    <div class="mb-1.5 flex items-baseline justify-between gap-2 px-1.5 sm:mb-0 sm:flex-col sm:items-stretch sm:justify-start sm:gap-0.5 sm:py-1.5 sm:pl-1.5 sm:pr-3" :class="isCurrent && 'sm:gap-[3px]'">
      <span v-if="isCurrent" class="text-[10.5px] font-bold uppercase tracking-[.1em] text-orange-600">This week</span>
      <span class="text-xs font-semibold uppercase tracking-[.08em]" :class="isCurrent ? 'text-orange-700' : 'text-stone-500'">{{ formatWeekRange(week.monday) }}</span>
      <span v-if="suggestLabel" class="self-start">
        <span v-if="generating" class="inline-flex items-center gap-1 rounded-md bg-orange-100 px-[7px] py-0.5 text-[10.5px] font-semibold text-orange-700">
          <UIcon name="i-heroicons-arrow-path" class="size-2.5 animate-spin" />Generating…
        </span>
        <span v-else class="inline-block rounded-md bg-orange-100 px-[7px] py-0.5 text-[10.5px] font-semibold text-orange-700">{{ suggestLabel }}</span>
      </span>
      <span class="tabular text-xs font-semibold text-stone-700 sm:font-bold sm:text-stone-800" :class="isCurrent ? 'sm:text-[20px]' : 'sm:text-[17px]'">
        <template v-if="isCurrent">{{ totals.doneTss }} / {{ totals.plannedTss }}</template>
        <template v-else>{{ isPast ? totals.doneTss : totals.plannedTss }}</template>
        <span class="text-[11px] font-medium text-stone-500">
          {{ isCurrent || isPast ? ' TSS' : ' TSS planned' }}
        </span>
      </span>
      <span
        v-if="draft && suggestLabel && savedPlannedTss !== totals.plannedTss"
        class="hidden text-[11px] tabular text-stone-400 sm:block"
      >was {{ savedPlannedTss }}</span>
      <span v-if="isCurrent" class="hidden h-1.5 overflow-hidden rounded-[3px] bg-stone-200 sm:mb-px sm:mt-[3px] sm:block" role="progressbar" :aria-valuenow="Math.round(progress * 100)" aria-valuemin="0" aria-valuemax="100">
        <span class="block h-full rounded-[3px] bg-orange-600" :style="{ width: `${progress * 100}%` }" />
      </span>
      <span v-if="matches" class="hidden text-xs font-semibold text-amber-700 sm:block">{{ matchCount }} match{{ matchCount === 1 ? '' : 'es' }}</span>
      <span class="hidden text-xs text-stone-600 sm:block">
        <template v-if="isCurrent || isPast">{{ formatMinutes(totals.doneMinutes) }} · {{ Math.round(totals.km) }} km</template>
        <template v-else>{{ formatMinutes(totals.plannedMinutes) }} planned</template>
      </span>
    </div>
    <span v-if="isCurrent" class="mb-1.5 block h-[3px] overflow-hidden rounded-full bg-stone-200 sm:hidden" aria-hidden="true">
      <span class="block h-full rounded-full bg-orange-600" :style="{ width: `${progress * 100}%` }" />
    </span>

    <!-- Days -->
    <div class="grid grid-cols-7 gap-1 sm:contents">
      <TrainingDayCell
        v-for="day in shownDays"
        :key="day.date"
        :day="day"
        :tsb="tsbByDate?.[day.date]?.tsb ?? day.metrics.tsb"
        :query="query"
        :matched="matches ? matches.has(day.date) : null"
        :open="openDate === day.date"
        :drop-target="dropDate === day.date"
        :dragging="dragDate === day.date"
        :current-week="isCurrent"
        @action="a => emit('action', a)"
      />
    </div>
  </div>
</template>
