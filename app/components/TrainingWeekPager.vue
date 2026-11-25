<script setup lang="ts">
/**
 * The phone (< sm) Training view: one week at a time. A pager card (‹ › or
 * swipe) with a 7-day strip, the selected day's summary card, and the week's
 * other days as a list. Nothing is selected until a day is tapped, so the list
 * starts with all seven. The week and selection are owned by TrainingTab.
 */
import type { PlanEntry } from '#shared/types/training'

const props = defineProps<{
  weeks: TrainingWeek[]
  /** Monday of the week shown (v-model:monday). */
  monday: string
  /** Selected date (v-model:selected); null or outside the week → nothing selected. */
  selected: string | null
  draft?: Record<string, PlanEntry> | null
  /** TSB per date, draft-aware (falls back to each day's own metrics). */
  tsbByDate?: Record<string, { tsb: number }> | null
  suggestLabel: (monday: string) => string | null
  hasOlder: boolean
  loadingOlder: boolean
  fuellingLoadingDate: string | null
  /** Suggest-plan preview: browsing only. */
  readonly?: boolean
}>()

const emit = defineEmits<{
  'update:monday': [string]
  'update:selected': [string | null]
  'older': []
  'newer': []
  'details': [date: string]
  'action': [DayAction]
}>()

const index = computed(() => props.weeks.findIndex(w => w.monday === props.monday))
const week = computed(() => props.weeks[index.value])
const days = computed(() => (week.value ? withDraft(week.value.days, props.draft) : []))
const isCurrent = computed(() => days.value.some(d => d.isToday))
const isPast = computed(() => !isCurrent.value && !!days.value[6]?.isPast)
const totals = computed(() => weekTotals(days.value))
const progress = computed(() => (totals.value.plannedTss ? Math.min(1, totals.value.doneTss / totals.value.plannedTss) : 0))

const selectedDay = computed(() => days.value.find(d => d.date === props.selected))

const otherDays = computed(() => days.value.filter(d => d.date !== selectedDay.value?.date))

const suggestion = computed(() => props.suggestLabel(props.monday))
const eyebrow = computed(() => {
  if (isCurrent.value) return 'This week'
  const current = props.weeks.find(w => w.days.some(d => d.isToday))?.monday
  if (!current) return null
  if (props.monday === addDaysIso(current, -7)) return 'Last week'
  return props.monday === addDaysIso(current, 7) ? 'Next week' : null
})

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const tssLine = computed(() => {
  if (isCurrent.value) return `${totals.value.doneTss} / ${totals.value.plannedTss} TSS`
  if (!isPast.value) return `${totals.value.plannedTss} TSS planned`
  const missed = days.value.filter(d => dayState(d) === 'missed').length
  return [
    `${totals.value.doneTss} TSS`,
    plural(days.value.filter(d => d.ride).length, 'ride'),
    missed && `${missed} missed`,
  ].filter(Boolean).join(' · ')
})

// ── Week changes ─────────────────────────────────────────────────────────────

const prevDisabled = computed(() => index.value === 0 && (!props.hasOlder || props.loadingOlder))

/** Moves a week; only the ends of `weeks` need the parent to load or append one. */
function turn(delta: -1 | 1) {
  const target = props.weeks[index.value + delta]
  if (target) emit('update:monday', target.monday)
  else if (delta > 0) emit('newer')
  else if (props.hasOlder) emit('older')
}

function go(delta: -1 | 1) {
  if (delta < 0 && prevDisabled.value) return
  if (props.weeks[index.value + delta]) emit('update:selected', null)
  turn(delta)
}

// Swipe: a mostly horizontal drag across the pager card.
let start: { x: number, y: number } | null = null

function onPointerDown(e: PointerEvent) {
  start = e.isPrimary ? { x: e.clientX, y: e.clientY } : null
}

function onPointerUp(e: PointerEvent) {
  if (!start) return
  const dx = e.clientX - start.x
  const dy = e.clientY - start.y
  start = null
  if (Math.abs(dx) > 48 && Math.abs(dx) > 1.5 * Math.abs(dy)) go(dx < 0 ? 1 : -1)
}

const strip = ref<HTMLElement | null>(null)
/** Cell to focus once an arrow key has moved the selection (possibly into a week still loading). */
let pendingFocus: string | null = null

function onArrow(date: string, delta: -1 | 1) {
  const target = addDaysIso(date, delta)
  const inWeek = days.value.some(d => d.date === target)
  if (!inWeek && delta < 0 && prevDisabled.value) return
  pendingFocus = target
  emit('update:selected', target)
  if (!inWeek) turn(delta)
}

watch([() => week.value?.monday, () => props.selected], () => {
  const cell = pendingFocus && strip.value?.querySelector<HTMLElement>(`[data-date="${pendingFocus}"]`)
  if (!cell) return
  pendingFocus = null
  cell.focus()
}, { flush: 'post' })

// A short cross-fade, no slide. Animating in place keeps keyboard focus intact.
watch(() => props.monday, () => {
  strip.value?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' })
}, { flush: 'post' })

// ── Rest of the week ─────────────────────────────────────────────────────────

const summary = ref<HTMLElement | null>(null)

async function pick(date: string) {
  emit('update:selected', date)
  await nextTick()
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  summary.value?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
}

const shortDate = (date: string) => formatDayLong(date).split(' ').slice(0, 2).join(' ')
const rowTss = (d: TrainingWeek['days'][number]) => (dayState(d) === 'rest' ? null : d.ride?.tss ?? d.plan?.tss ?? null)
const NAME_CLASS = {
  ridden: 'font-semibold text-stone-800',
  planned: 'font-medium text-stone-700',
  missed: 'font-medium text-stone-700',
  rest: 'italic text-stone-500',
}
</script>

<template>
  <div v-if="week" class="flex flex-col gap-3">
    <span class="sr-only" aria-live="polite">{{ formatWeekRange(monday) }}</span>

    <!-- Week pager -->
    <div
      class="flex touch-pan-y flex-col gap-2.5 rounded-[14px] px-2.5 py-3"
      :class="[
        isCurrent ? 'bg-orange-100' : 'border border-[#f0eeec] bg-white',
        suggestion && '!border-[1.5px] !border-dashed !border-orange-400',
      ]"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
      @pointercancel="start = null"
    >
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex size-11 shrink-0 items-center justify-center rounded-[10px] border border-stone-200 bg-white text-stone-700 disabled:opacity-35"
          aria-label="Previous week"
          :disabled="prevDisabled"
          @click="go(-1)"
        >
          <BikeSpinner v-if="loadingOlder" :size="16" />
          <UIcon v-else name="i-heroicons-chevron-left" class="size-[18px]" />
        </button>
        <div class="flex min-w-0 flex-1 flex-col items-center gap-px text-center">
          <span v-if="suggestion" class="rounded-md bg-orange-100 px-[7px] py-0.5 text-[10.5px] font-semibold text-orange-700">{{ suggestion }}</span>
          <span v-else-if="eyebrow" class="text-[11px] font-extrabold uppercase tracking-[.1em]" :class="isCurrent ? 'text-orange-700' : 'text-stone-600'">{{ eyebrow }}</span>
          <span class="text-[15px] font-bold uppercase tracking-[.06em] text-stone-800">{{ formatWeekRange(monday) }}</span>
          <span class="text-[13px] text-stone-600 tabular">{{ tssLine }}</span>
        </div>
        <button
          type="button"
          class="flex size-11 shrink-0 items-center justify-center rounded-[10px] border border-stone-200 bg-white text-stone-700"
          aria-label="Next week"
          @click="go(1)"
        >
          <UIcon name="i-heroicons-chevron-right" class="size-[18px]" />
        </button>
      </div>

      <span v-if="isCurrent" class="block h-[5px] overflow-hidden rounded-[3px] bg-orange-200" role="progressbar" aria-label="Week progress" :aria-valuenow="Math.round(progress * 100)" aria-valuemin="0" aria-valuemax="100">
        <span class="block h-full bg-orange-600" :style="{ width: `${progress * 100}%` }" />
      </span>

      <div ref="strip" class="grid grid-cols-7 gap-1">
        <TrainingStripCell
          v-for="(day, i) in days"
          :key="day.date"
          :day="day"
          :weekday="i"
          :selected="day.date === selectedDay?.date"
          :current-week="isCurrent"
          @click="emit('update:selected', day.date)"
          @keydown.left.prevent="onArrow(day.date, -1)"
          @keydown.right.prevent="onArrow(day.date, 1)"
        />
      </div>
    </div>

    <!-- Selected day -->
    <div v-if="selectedDay" ref="summary" style="scroll-margin-top: calc(var(--app-sticky-h, 0px) + var(--training-search-h, 0px))">
      <TrainingDaySummary
        :key="selectedDay.date"
        :day="selectedDay"
        :tsb="tsbByDate?.[selectedDay.date]?.tsb ?? selectedDay.metrics.tsb"
        :fuelling-loading="fuellingLoadingDate === selectedDay.date"
        :readonly="readonly"
        @details="date => emit('details', date)"
        @action="a => emit('action', a)"
      />
    </div>

    <!-- The week's unselected days -->
    <div class="flex flex-col gap-1.5">
      <h3 class="px-1 pt-1.5 text-[11px] font-bold uppercase tracking-[.08em] text-stone-600">{{ selectedDay ? 'Rest of the week' : 'All days' }}</h3>
      <ul class="divide-y divide-stone-100 overflow-hidden rounded-xl border border-[#f0eeec] bg-white">
        <li v-for="day in otherDays" :key="day.date">
          <button
            type="button"
            class="relative grid min-h-[52px] w-full grid-cols-[48px_30px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-2 text-left"
            @click="pick(day.date)"
          >
            <span v-if="dayState(day) === 'ridden'" class="absolute inset-y-2.5 left-0 w-[3px] rounded-r bg-orange-600" />
            <span class="text-[13px] font-semibold text-stone-600 tabular">{{ day.isToday ? 'Today' : shortDate(day.date) }}</span>
            <span
              v-if="dayState(day) === 'rest'"
              class="inline-flex h-5 w-7 items-center justify-center rounded-[5px] border border-pink-200 bg-pink-100 text-pink-700 opacity-60"
              aria-hidden="true"
            ><ZoneIcon type="rest" class="size-3.5" /></span>
            <span
              v-else
              class="inline-flex h-5 w-7 items-center justify-center rounded-[5px] border text-xs font-bold"
              :class="[zoneClass(dayZone(day)), dayState(day) === 'missed' && 'opacity-55']"
              :aria-label="zoneLabel(dayZone(day))"
              role="img"
            ><ZoneIcon :type="dayZone(day)" class="size-3.5 text-xs" /></span>
            <span class="truncate text-[14.5px]" :class="NAME_CLASS[dayState(day)]">{{ dayName(day) }}</span>
            <span class="text-sm font-bold tabular" :class="dayState(day) === 'missed' ? 'text-stone-400 line-through' : dayState(day) === 'ridden' ? 'text-stone-800' : 'text-stone-600'">
              {{ rowTss(day) }}<span v-if="dayState(day) === 'missed'" class="sr-only"> missed</span>
            </span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
