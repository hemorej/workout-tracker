<script setup lang="ts">
/**
 * One calendar day in the Training grid — the plan before it is ridden, the
 * log entry after. Pure presentation: the grid (TrainingTab) owns hover, pin,
 * drag and keyboard handling through attributes/events on this root <button>
 * (found by `data-date`).
 *
 * Desktop: 92px card with name + TSS/duration/TSB. Mobile (< sm): a 64px
 * compact cell with the date, badge and TSS only; details live in the sheet.
 */
import type { TrainingDay } from '#shared/types/training'

const props = defineProps<{
  day: TrainingDay
  /** TSB at the end of the day (projected when the draft is previewed). */
  tsb: number
  /** Active search text, for highlighting. */
  query?: string
  /** null = no search running; otherwise whether this day matches. */
  matched?: boolean | null
  /** The day's card is open (hovered or pinned). */
  open?: boolean
  dropTarget?: boolean
  dragging?: boolean
  /** The cell sits in the current week's band: taller on desktop to fit the Today card's buttons. */
  currentWeek?: boolean
}>()
const emit = defineEmits<{ action: [DayAction] }>()

const state = computed(() => dayState(props.day))
const zone = computed(() => dayZone(props.day))
const today = computed(() => props.day.isToday)
const draggable = computed(() => state.value === 'planned')

const dayNumber = computed(() => Number(props.day.date.slice(8)))
const dateLabel = computed(() =>
  dayNumber.value === 1
    ? new Date(`${props.day.date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    : String(dayNumber.value),
)

const name = computed(() => {
  if (state.value === 'rest') return 'Rest'
  if (props.day.ride) return rideLabel(props.day.ride.name)
  return props.day.plan?.name || zoneLabel(props.day.plan?.type)
})
const notes = computed(() => props.day.ride ? props.day.ride.notes : props.day.plan?.notes)
const snippet = computed(() => notesSnippet(notes.value, props.query ?? ''))

const plannedTss = computed(() => props.day.plan?.tss ?? null)
const rideTss = computed(() => props.day.ride?.tss ?? null)
/** "56/75" when the ride's TSS differs from the plan's; amber when it fell short by more than 10 %. */
const tssText = computed(() => {
  if (state.value === 'ridden') {
    const done = rideTss.value!
    return plannedTss.value != null && plannedTss.value !== done ? `${done}/${plannedTss.value}` : String(done)
  }
  return plannedTss.value != null ? String(plannedTss.value) : null
})
const fellShort = computed(() => state.value === 'ridden' && plannedTss.value != null && rideTss.value! < plannedTss.value * 0.9)
/** Ridden: "1h 28m". Planned: plain minutes ("60m") — it has to share the line with TSS and the TSB chip. */
const minutesText = computed(() => {
  if (state.value === 'ridden') return formatMinutes(props.day.ride!.durationMinutes)
  const planned = props.day.plan?.durationMinutes
  return planned ? `${planned}m` : null
})

/** The "TSS" unit drops out when three-digit numbers would overflow the 4-item bottom line. */
const showTssUnit = computed(() => (tssText.value?.length ?? 0) + (minutesText.value?.length ?? 0) <= 5)

const hasPowerBest = computed(() => (props.day.ride?.powerBests.length ?? 0) > 0)
const tsbText = computed(() => `${props.tsb > 0 ? '+' : ''}${Math.round(props.tsb)}`)

const todayName = computed(() => {
  if (state.value === 'rest') return props.day.plan ? 'Rest day' : 'Nothing planned'
  return name.value
})

const ariaLabel = computed(() => {
  const parts = [`${today.value ? 'Today, ' : ''}${formatDayLong(props.day.date)}: ${name.value}`]
  if (state.value === 'ridden') parts.push(`${rideTss.value} of ${plannedTss.value ?? rideTss.value} TSS`)
  else if (tssText.value) parts.push(`${tssText.value} TSS`)
  parts.push(state.value)
  return parts.join(', ')
})
</script>

<template>
  <button
    type="button"
    :data-date="day.date"
    :draggable="draggable"
    :aria-label="ariaLabel"
    :aria-current="today ? 'date' : undefined"
    :aria-expanded="open"
    class="cell relative flex h-16 w-full flex-col overflow-hidden text-left outline-none transition-[box-shadow,border-color,opacity] sm:gap-1"
    :class="[
      currentWeek ? 'sm:h-[116px]' : 'sm:h-[92px]',
      today
        ? 'z-[1] rounded-[9px] border border-transparent bg-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-400 sm:gap-[5px] sm:rounded-[11px] sm:px-2.5 sm:py-[9px] sm:shadow-[0_10px_24px_rgba(28,25,23,.28)]'
        : 'rounded-[9px] border focus-visible:border-orange-300 focus-visible:shadow-[0_0_0_3px_#ffedd5] sm:py-[7px] sm:pr-2 sm:pl-2.5',
      !today && state === 'ridden' && 'border-[#f0eeec] bg-white shadow-[0_1px_2px_rgba(28,25,23,.04)]',
      !today && state === 'planned' && (currentWeek ? 'border-[1.5px] border-dashed border-stone-300 bg-white' : 'border-[1.5px] border-dashed border-stone-200 bg-[#fcfcfb]'),
      !today && state === 'missed' && 'border-[1.5px] border-dashed border-rose-200',
      !today && state === 'rest' && 'border-transparent',
      matched && (today ? 'ring-[1.5px] ring-amber-300' : 'border-[1.5px] !border-amber-300'),
      matched === false && 'opacity-25',
      !today && (open ? 'border-orange-300 shadow-[0_0_0_3px_#ffedd5]' : 'hover:border-orange-300 hover:shadow-[0_0_0_3px_#ffedd5]'),
      dropTarget && (today ? 'ring-[1.5px] ring-[var(--ui-primary)]' : '!bg-orange-50 !shadow-[inset_0_0_0_1.5px_var(--ui-primary)]'),
      dragging && 'opacity-40',
    ]"
  >
    <!-- Ridden accent: left edge on desktop, bottom bar on mobile -->
    <span v-if="state === 'ridden'" class="absolute bottom-0 left-2 right-2 h-[3px] rounded-t bg-orange-600 sm:bottom-2 sm:left-0 sm:right-auto sm:top-2 sm:h-auto sm:w-[3px] sm:rounded-l-none sm:rounded-r" />

    <!-- Top line: date · markers · zone badge -->
    <span class="flex items-center gap-1 px-1.5 pt-1 sm:p-0" :class="today && 'sm:hidden'">
      <span
        v-if="today"
        class="text-[11px] font-bold text-white tabular"
      >{{ dayNumber }}</span>
      <span v-else class="text-[11px] font-semibold tabular text-stone-600 sm:text-xs"><span class="sm:hidden">{{ dayNumber }}</span><span class="hidden sm:inline">{{ dateLabel }}</span></span>
      <span class="flex-1" />
      <UIcon v-if="notes" name="i-heroicons-bars-3-bottom-left" class="hidden size-3 text-amber-600 sm:block" />
      <span v-if="hasPowerBest" class="hidden text-[11px] font-bold text-[#3F6212] sm:inline" aria-hidden="true">★</span>
      <span
        v-if="state !== 'rest'"
        class="hidden h-[17px] w-[22px] shrink-0 items-center justify-center rounded border text-[10.5px] font-bold sm:inline-flex"
        :class="[zoneClass(zone), state === 'missed' && 'opacity-50']"
      ><ZoneIcon :type="zone" class="size-3 text-[10.5px]" /></span>
    </span>

    <!-- Mobile body: badge + TSS (no names) -->
    <span class="flex flex-1 flex-col items-center justify-center gap-0.5 sm:hidden">
      <template v-if="state === 'rest'">
        <UIcon name="i-heroicons-moon" class="size-3.5 text-stone-300" />
      </template>
      <template v-else>
        <span class="inline-flex h-[17px] w-6 items-center justify-center rounded border text-[10.5px] font-bold" :class="[zoneClass(zone), state === 'missed' && 'opacity-50']">
          <ZoneIcon :type="zone" class="size-3 text-[10.5px]" />
        </span>
        <span v-if="tssText" class="text-[11px] font-semibold tabular" :class="[today ? 'text-stone-200' : 'text-stone-700', state === 'missed' && 'text-stone-400 line-through']">{{ rideTss ?? plannedTss }}</span>
      </template>
    </span>
    <span v-if="notes" class="absolute right-1 top-1 size-[5px] rounded-full bg-amber-600 sm:hidden" />

    <!-- Desktop: Today card (dark) -->
    <template v-if="today">
      <span class="hidden items-center gap-1 sm:flex">
        <span class="text-[11px] font-extrabold uppercase tracking-[.1em] text-orange-400">Today</span>
        <span class="flex-1" />
        <UIcon v-if="notes" name="i-heroicons-bars-3-bottom-left" class="size-3 text-amber-600" />
        <UIcon v-if="state === 'rest' && day.plan" name="i-heroicons-moon" class="size-3.5 text-pink-300" />
        <span
          v-else-if="state !== 'rest'"
          class="inline-flex h-[17px] w-[22px] shrink-0 items-center justify-center rounded border text-[10.5px] font-bold"
          :class="zoneClass(zone)"
        ><ZoneIcon :type="zone" class="size-3 text-[10.5px]" /></span>
      </span>
      <span
        class="hidden text-[14px] leading-[1.25] sm:line-clamp-2"
        :class="state === 'rest' ? (day.plan ? 'italic text-stone-300' : 'text-stone-400') : 'font-bold text-white'"
      >{{ todayName }}</span>
      <span v-if="state !== 'rest'" class="hidden items-center gap-1.5 whitespace-nowrap sm:flex">
        <span v-if="tssText" class="text-[12px] font-semibold tabular" :class="fellShort ? 'text-amber-300' : 'text-stone-200'">{{ tssText }}</span>
        <span v-if="minutesText" class="text-[11px] text-stone-400 tabular">{{ minutesText }}</span>
        <span class="flex-1" />
        <span
          v-if="state === 'planned'"
          class="rounded px-[5px] py-px text-[10.5px] font-bold tabular"
          :class="tsb > 0 ? 'bg-[rgba(74,222,128,.16)] text-green-300' : tsb < 0 ? 'bg-[rgba(248,113,113,.18)] text-red-300' : 'bg-white/10 text-stone-300'"
        >{{ tsbText }}</span>
      </span>
      <span v-if="state === 'ridden'" class="absolute bottom-2 left-0 top-2 hidden w-[3px] rounded-r bg-orange-500 sm:block" />
      <span v-if="state === 'ridden' && day.ride?.rpe != null" class="mt-auto hidden text-[11px] text-stone-400 sm:block">RPE {{ day.ride.rpe }}</span>
      <!-- Actions are spans, not nested <button>s; click.stop keeps them from pinning the hover card -->
      <span v-if="state === 'planned'" class="mt-auto hidden gap-1 sm:flex">
        <span
          role="button"
          tabindex="0"
          aria-label="Fuelling guidelines"
          class="inline-flex h-[26px] w-7 cursor-pointer items-center justify-center rounded-[7px] border border-stone-700 text-sky-300 hover:border-stone-600 hover:bg-white/5"
          @click.stop="emit('action', { type: 'fuelling', date: day.date })"
          @keydown.enter.stop.prevent="emit('action', { type: 'fuelling', date: day.date })"
        ><FlameIcon class="size-[13px]" /></span>
        <span
          role="button"
          tabindex="0"
          class="inline-flex h-[26px] flex-1 cursor-pointer items-center justify-center gap-1 rounded-[7px] bg-orange-600 text-[12px] font-semibold text-white hover:bg-orange-700"
          @click.stop="emit('action', { type: 'build-workout', date: day.date })"
          @keydown.enter.stop.prevent="emit('action', { type: 'build-workout', date: day.date })"
        ><IntervalsIcon class="size-3" />Build</span>
      </span>
      <!-- Plan a session: click bubbles so the hover card pins (where planning lives) -->
      <span
        v-else-if="state === 'rest' && !day.plan"
        class="mt-auto hidden h-[26px] items-center justify-center rounded-[7px] border border-stone-700 text-[12px] font-semibold text-stone-200 sm:flex"
      >Plan a session</span>
    </template>

    <!-- Desktop: name -->
    <span
      v-if="!today"
      class="hidden text-[12.5px] leading-[1.3] sm:block"
      :class="[
        snippet ? 'line-clamp-1' : 'line-clamp-2',
        state === 'ridden' && 'font-semibold text-stone-800',
        state === 'planned' && 'font-medium text-stone-600',
        state === 'missed' && 'font-medium text-stone-500',
        state === 'rest' && 'italic text-stone-400',
      ]"
    ><HighlightedText :text="name" :query="query" /></span>
    <span v-if="snippet && !today" class="hidden line-clamp-1 text-[11.5px] leading-[1.3] text-stone-600 sm:block"><HighlightedText :text="snippet" :query="query" /></span>

    <!-- Desktop: bottom line -->
    <span v-if="state !== 'rest' && !today" class="mt-auto hidden items-center gap-1 whitespace-nowrap sm:flex">
      <span
        v-if="tssText"
        class="text-xs font-semibold tabular"
        :class="[
          state === 'missed' ? 'text-stone-400 line-through' : fellShort ? 'text-amber-700' : state === 'planned' ? 'text-stone-500' : 'text-stone-700',
        ]"
      >{{ tssText }}<template v-if="state === 'planned' && showTssUnit"> TSS</template></span>
      <span v-if="state === 'missed'" class="text-[10.5px] font-bold uppercase tracking-[.06em] text-rose-600">Missed</span>
      <span v-else-if="minutesText" class="whitespace-nowrap text-[11px] tabular text-stone-500">{{ minutesText }}</span>
      <span class="flex-1" />
      <span
        v-if="state === 'planned'"
        class="rounded bg-stone-100 px-[5px] py-px text-[10.5px] font-semibold tabular text-stone-600"
        :style="tsbHeat(tsb)"
      >{{ tsbText }}</span>
    </span>
  </button>
</template>
