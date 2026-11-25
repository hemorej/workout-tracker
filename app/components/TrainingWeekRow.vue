<script setup lang="ts">
/**
 * One Monday–Sunday row of the Training grid: the week label (range, TSS,
 * progress, hours/km) followed by seven day cells. Desktop/tablet only —
 * phones show TrainingWeekPager instead.
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

// Without a draft the store's own day objects are passed through, so a cell whose day didn't change doesn't re-render.
const shownDays = computed(() => withDraft(props.week.days, props.draft))
const totals = computed(() => weekTotals(shownDays.value))
const savedPlannedTss = computed(() => weekTotals(props.week.days).plannedTss)
const progress = computed(() => (totals.value.plannedTss ? Math.min(1, totals.value.doneTss / totals.value.plannedTss) : 0))

const matchCount = computed(() => props.matches ? props.week.days.filter(d => props.matches!.has(d.date)).length : 0)
</script>

<template>
  <div
    :data-week="week.monday"
    class="grid grid-cols-[150px_repeat(7,minmax(0,1fr))] gap-1.5 px-2.5 transition-opacity"
    :class="[
      isCurrent ? 'bg-orange-100 py-3.5 shadow-[inset_4px_0_0_#ea580c]' : 'pb-2.5 pt-2',
      suggestLabel && 'rounded-xl border-[1.5px] border-dashed border-orange-400',
      generating && suggestLabel && 'opacity-60',
    ]"
  >
    <!-- Week label -->
    <div class="flex flex-col items-stretch justify-start py-1.5 pl-1.5 pr-3" :class="isCurrent ? 'gap-[3px]' : 'gap-0.5'">
      <span v-if="isCurrent" class="text-[10.5px] font-bold uppercase tracking-[.1em] text-orange-600">This week</span>
      <span class="text-xs font-semibold uppercase tracking-[.08em]" :class="isCurrent ? 'text-orange-700' : 'text-stone-500'">{{ formatWeekRange(week.monday) }}</span>
      <span v-if="suggestLabel" class="self-start">
        <span v-if="generating" class="inline-flex items-center gap-1 rounded-md bg-orange-100 px-[7px] py-0.5 text-[10.5px] font-semibold text-orange-700">
          <UIcon name="i-heroicons-arrow-path" class="size-2.5 animate-spin" />Generating…
        </span>
        <span v-else class="inline-block rounded-md bg-orange-100 px-[7px] py-0.5 text-[10.5px] font-semibold text-orange-700">{{ suggestLabel }}</span>
      </span>
      <span class="tabular font-bold text-stone-800" :class="isCurrent ? 'text-[20px]' : 'text-[17px]'">
        <template v-if="isCurrent">{{ totals.doneTss }} / {{ totals.plannedTss }}</template>
        <template v-else>{{ isPast ? totals.doneTss : totals.plannedTss }}</template>
        <span class="text-[11px] font-medium text-stone-500">
          {{ isCurrent || isPast ? ' TSS' : ' TSS planned' }}
        </span>
      </span>
      <span
        v-if="draft && suggestLabel && savedPlannedTss !== totals.plannedTss"
        class="text-[11px] tabular text-stone-400"
      >was {{ savedPlannedTss }}</span>
      <span v-if="isCurrent" class="mb-px mt-[3px] block h-1.5 overflow-hidden rounded-[3px] bg-stone-200" role="progressbar" :aria-valuenow="Math.round(progress * 100)" aria-valuemin="0" aria-valuemax="100">
        <span class="block h-full rounded-[3px] bg-orange-600" :style="{ width: `${progress * 100}%` }" />
      </span>
      <span v-if="matches" class="text-xs font-semibold text-amber-700">{{ matchCount }} match{{ matchCount === 1 ? '' : 'es' }}</span>
      <span class="text-xs text-stone-600">
        <template v-if="isCurrent || isPast">{{ formatMinutes(totals.doneMinutes) }} · {{ Math.round(totals.km) }} km</template>
        <template v-else>{{ formatMinutes(totals.plannedMinutes) }} planned</template>
      </span>
    </div>
    <!-- Days -->
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
</template>
