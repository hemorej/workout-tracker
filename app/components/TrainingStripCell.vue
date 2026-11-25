<script setup lang="ts">
/**
 * One day in the phone week strip (TrainingWeekPager): weekday, date, zone badge
 * and TSS. Tapping selects it; the details show in the card below the strip.
 * Extra attributes and listeners fall through to the root <button>.
 */
import type { TrainingDay } from '#shared/types/training'

const props = defineProps<{
  day: TrainingDay
  /** 0 = Monday. */
  weekday: number
  selected: boolean
  currentWeek: boolean
}>()

const state = computed(() => dayState(props.day))
const zone = computed(() => dayZone(props.day))
const today = computed(() => props.day.isToday)
const tss = computed(() => (state.value === 'rest' ? null : props.day.ride?.tss ?? props.day.plan?.tss ?? null))
const ariaLabel = computed(() => dayAriaLabel(props.day, formatDayFull(props.day.date)))

/** Today and the selection override the state's border. */
const frameClass = computed(() => {
  if (today.value) {
    return ['bg-stone-900', props.selected ? 'shadow-[0_0_0_3px_#fdba74]' : 'shadow-[0_6px_14px_rgba(28,25,23,.25)]']
  }
  const background = {
    ridden: 'bg-white',
    planned: props.currentWeek ? 'bg-white' : 'bg-[#fcfcfb]',
    missed: '',
    rest: '',
  }[state.value]
  if (props.selected) return [background, 'border-2 border-orange-600 shadow-[0_0_0_3px_#ffedd5]']
  const border = {
    ridden: 'border border-[#f0eeec]',
    planned: `border-[1.5px] border-dashed ${props.currentWeek ? 'border-stone-300' : 'border-stone-200'}`,
    missed: 'border-[1.5px] border-dashed border-rose-300',
    rest: 'border border-transparent',
  }[state.value]
  return [background, border]
})

const tssClass = computed(() => {
  if (today.value) return 'text-stone-50'
  if (state.value === 'missed') return 'text-stone-400 line-through'
  if (fellShort(props.day)) return 'text-amber-700'
  return state.value === 'ridden' ? 'text-stone-800' : 'text-stone-600'
})
</script>

<template>
  <button
    type="button"
    :data-date="day.date"
    :aria-pressed="selected"
    :aria-label="ariaLabel"
    :aria-current="today ? 'date' : undefined"
    class="relative flex h-[84px] w-full flex-col items-center justify-between rounded-[11px] pb-[9px] pt-[7px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-400"
    :class="frameClass"
  >
    <span class="flex flex-col items-center leading-[1.1]">
      <span class="text-[10.5px] font-bold uppercase" :class="today ? 'text-orange-400' : 'text-stone-500'">{{ 'MTWTFSS'[weekday] }}</span>
      <span class="text-base font-bold tabular" :class="today ? 'text-white' : state === 'ridden' ? 'text-stone-800' : 'text-stone-600'">{{ Number(day.date.slice(8)) }}</span>
    </span>
    <UIcon v-if="state === 'rest'" name="i-heroicons-moon" class="size-4 text-stone-400" />
    <span
      v-else
      class="inline-flex h-5 w-7 items-center justify-center rounded-[5px] border text-xs font-bold"
      :class="[zoneClass(zone), state === 'missed' && 'opacity-55']"
    ><ZoneIcon :type="zone" class="size-3.5 text-xs" /></span>
    <span class="min-h-[17px] text-sm font-bold leading-[17px] tabular" :class="tssClass">{{ tss }}</span>
    <span v-if="state === 'ridden'" class="absolute inset-x-[9px] bottom-0 h-[3px] rounded-t bg-orange-600" />
    <span v-if="dayNotes(day)" class="absolute right-1.5 top-1.5 size-1.5 rounded-full" :class="today ? 'bg-amber-400' : 'bg-amber-600'" />
  </button>
</template>
