<script setup lang="ts">
/**
 * The selected day under the phone week strip: a read-only summary with the
 * primary actions. Full editing stays in the sheet (TrainingDayDetail), opened
 * through `details`. Today uses the dark styling of the desktop Today card.
 */
import type { TrainingDay } from '#shared/types/training'

const props = defineProps<{
  day: TrainingDay
  /** TSB at the end of the day (projected when the draft is previewed). */
  tsb: number
  fuellingLoading?: boolean
  /** Suggest-plan preview: nothing can be opened or changed. */
  readonly?: boolean
}>()

const emit = defineEmits<{ details: [date: string], action: [DayAction] }>()

const state = computed(() => dayState(props.day))
const zone = computed(() => dayZone(props.day))
const today = computed(() => props.day.isToday)
const ride = computed(() => props.day.ride)
const notes = computed(() => dayNotes(props.day))

const eyebrow = computed(() => {
  const weekday = new Date(`${props.day.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })
  return [
    today.value && 'Today',
    `${weekday} ${Number(props.day.date.slice(8))}`,
    state.value !== 'rest' && state.value,
  ].filter(Boolean).join(' · ')
})

const tssText = computed(() => {
  const planned = props.day.plan?.tss ?? null
  if (!ride.value) return planned != null ? `${planned} TSS` : null
  return planned != null && planned !== ride.value.tss ? `${ride.value.tss} / ${planned} TSS` : `${ride.value.tss} TSS`
})

const details = computed(() => {
  if (!ride.value) return props.day.plan?.durationMinutes ? `${props.day.plan.durationMinutes}m` : ''
  const { durationMinutes, distanceKm, rpe } = ride.value
  return [formatMinutes(durationMinutes), distanceKm != null && `${distanceKm.toFixed(1)} km`, rpe != null && `RPE ${rpe}`].filter(Boolean).join(' · ')
})

const tsbText = computed(() => `${props.tsb > 0 ? '+' : ''}${Math.round(props.tsb)}`)

// "More" only shows when the note is actually cut off.
const noteEl = ref<HTMLElement | null>(null)
const clamped = ref(false)
const measure = () => { clamped.value = !!noteEl.value && noteEl.value.scrollHeight > noteEl.value.clientHeight + 1 }
let resize: ResizeObserver | undefined
onMounted(() => {
  resize = new ResizeObserver(measure)
  watch(noteEl, (el) => {
    resize!.disconnect()
    if (el) resize!.observe(el)
    measure()
  }, { immediate: true, flush: 'post' })
})
// A different note at the same clamped height doesn't resize the element.
watch(notes, measure, { flush: 'post' })
onBeforeUnmount(() => resize?.disconnect())

const secondaryClass = computed(() => [
  'h-[42px] rounded-[10px] text-sm font-medium disabled:opacity-50',
  today.value ? 'bg-white/[.08] text-stone-200' : 'bg-[#f5f4f2] text-stone-700',
])

const open = () => emit('details', props.day.date)
const act = (type: 'mark-completed' | 'add-workout' | 'fuelling' | 'build-workout') => emit('action', { type, date: props.day.date })
</script>

<template>
  <div
    class="flex flex-col gap-2.5 rounded-[14px] p-4"
    :class="today ? 'bg-stone-900 shadow-[0_10px_24px_rgba(28,25,23,.25)]' : 'border border-[#f0eeec] bg-white'"
  >
    <div class="flex min-h-7 items-center gap-2">
      <span class="text-xs font-extrabold uppercase tracking-[.1em]" :class="today ? 'text-orange-400' : state === 'missed' ? 'text-rose-600' : 'text-stone-600'">{{ eyebrow }}</span>
      <span class="flex-1" />
      <!-- The pseudo-element grows the 28px pill to a 44px touch target -->
      <button
        v-if="state !== 'rest'"
        type="button"
        class="relative inline-flex h-7 items-center gap-1.5 rounded-[7px] border px-2 text-[13px] font-semibold after:absolute after:-inset-2"
        :class="zoneClass(zone)"
        :aria-label="`Workout type: ${zoneLabel(zone)}. Open details`"
        :disabled="readonly"
        @click="open"
      >
        <ZoneIcon :type="zone" class="size-3.5 text-[13px]" />{{ zoneLabel(zone) }}
      </button>
    </div>

    <p
      class="text-xl font-bold leading-tight"
      :class="today ? 'text-white' : state === 'rest' ? 'text-stone-500' : 'text-stone-900'"
    >{{ state === 'rest' ? 'Rest day' : dayName(day) }}</p>

    <div v-if="state !== 'rest'" class="flex flex-wrap items-center gap-2 text-sm tabular" :class="today ? 'text-stone-300' : 'text-stone-600'">
      <span
        v-if="tssText"
        class="font-bold"
        :class="state === 'missed' ? 'text-stone-400 line-through' : fellShort(day) ? (today ? 'text-amber-300' : 'text-amber-700') : today ? 'text-stone-50' : 'text-stone-800'"
      >{{ tssText }}</span>
      <span v-if="details">{{ details }}</span>
      <span
        v-if="state === 'planned'"
        class="rounded-[5px] px-[7px] py-0.5 text-[12.5px] font-bold"
        :class="today
          ? (tsb > 0 ? 'bg-[rgba(74,222,128,.16)] text-green-300' : tsb < 0 ? 'bg-[rgba(248,113,113,.18)] text-red-300' : 'bg-white/10 text-stone-300')
          : 'bg-stone-100 text-stone-600'"
        :style="today ? undefined : tsbHeat(tsb)"
      >TSB {{ tsbText }}</span>
    </div>

    <div
      v-if="notes"
      class="rounded-[10px] px-3 py-2.5 text-sm leading-snug"
      :class="today ? 'bg-white/[.06] text-stone-200' : ride ? 'bg-stone-50 text-stone-700' : 'bg-amber-50 text-stone-700'"
    >
      <p ref="noteEl" class="line-clamp-4 whitespace-pre-line">{{ notes }}</p>
      <button
        v-if="clamped"
        type="button"
        class="-mb-2.5 flex h-11 w-full items-center text-sm font-semibold underline underline-offset-2 disabled:opacity-50"
        aria-label="Show the full note"
        :disabled="readonly"
        @click="open"
      >More</button>
    </div>

    <div v-if="state === 'planned'" class="flex gap-2">
      <button
        type="button"
        class="inline-flex h-[46px] flex-1 items-center justify-center gap-1.5 rounded-[11px] border text-[15px] font-semibold disabled:opacity-50"
        :class="today ? 'border-stone-700 text-sky-300' : 'border-stone-200 text-sky-700'"
        :disabled="readonly || fuellingLoading"
        @click="act('fuelling')"
      >
        <UIcon v-if="fuellingLoading" name="i-heroicons-arrow-path" class="size-4 animate-spin" />
        <FlameIcon v-else class="size-4" />
        Fuelling
      </button>
      <button
        type="button"
        class="inline-flex h-[46px] flex-[1.5] items-center justify-center gap-1.5 rounded-[11px] bg-orange-600 text-[15px] font-semibold text-white disabled:opacity-50"
        :disabled="readonly"
        @click="act('build-workout')"
      >
        <IntervalsIcon class="size-4" />
        Build workout
      </button>
    </div>

    <div class="grid grid-cols-2 gap-2">
      <template v-if="state === 'planned'">
        <button type="button" :class="secondaryClass" :disabled="readonly" @click="act('mark-completed')">Mark as completed</button>
        <button type="button" :class="secondaryClass" :disabled="readonly" @click="open">Edit plan</button>
      </template>
      <template v-else-if="state === 'ridden'">
        <button v-if="ride?.hasFitData" type="button" :class="secondaryClass" :disabled="readonly" @click="emit('action', { type: 'open-fit', day })">Open ride</button>
        <button type="button" :class="[secondaryClass, !ride?.hasFitData && 'col-span-2']" :disabled="readonly" @click="open">Edit</button>
      </template>
      <template v-else>
        <button type="button" :class="secondaryClass" :disabled="readonly" @click="act('add-workout')">Add workout</button>
        <button type="button" :class="secondaryClass" :disabled="readonly" @click="open">{{ state === 'missed' ? 'Edit plan' : 'Plan a session' }}</button>
      </template>
    </div>
  </div>
</template>
