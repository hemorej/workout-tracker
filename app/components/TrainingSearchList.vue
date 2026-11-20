<script setup lang="ts">
/**
 * List view of search results: matching days newest first, one row each. Rows
 * are `data-date` targets, so TrainingTab's hover/pin card works on them too.
 */
import type { TrainingDay } from '#shared/types/training'

defineProps<{
  days: TrainingDay[]
  query: string
  openDate?: string | null
}>()

const dateLabel = (d: string) => utcDate(d, { weekday: 'short', day: 'numeric', month: 'short' })
const yearLabel = (d: string) => utcDate(d, { year: 'numeric' })

function utcDate(d: string, opts: Intl.DateTimeFormatOptions) {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' }).replace(',', '')
}

const accent = { ridden: 'bg-orange-600', planned: 'bg-[#4B88A2]', missed: 'bg-rose-300', rest: 'bg-transparent' }
</script>

<template>
  <p v-if="!days.length" class="rounded-xl border border-[#f0eeec] bg-white py-16 text-center text-sm font-medium text-stone-500">
    No workouts or plans match
  </p>
  <ul v-else class="divide-y divide-[#f7f5f3] rounded-xl border border-[#f0eeec] bg-white">
    <li v-for="day in days" :key="day.date">
      <button
        type="button"
        :data-date="day.date"
        :aria-expanded="openDate === day.date"
        class="relative grid w-full grid-cols-[96px_36px_minmax(0,1fr)_auto] items-center gap-x-4 px-6 py-3.5 text-left transition-colors hover:bg-stone-50"
        :class="openDate === day.date && 'bg-stone-50'"
      >
        <span class="absolute bottom-3 left-0 top-3 w-[3px] rounded-r" :class="accent[dayState(day)]" />
        <span class="text-right">
          <span class="block text-sm font-semibold text-stone-600">{{ dateLabel(day.date) }}</span>
          <span class="block text-xs text-stone-500">{{ yearLabel(day.date) }}</span>
        </span>
        <span class="inline-flex h-7 w-9 items-center justify-center rounded-md border" :class="zoneClass(dayZone(day))">
          <ZoneIcon :type="dayZone(day)" class="size-4 text-sm" />
        </span>
        <span class="min-w-0">
          <span class="block truncate text-[15px] font-semibold text-stone-800">
            <HighlightedText :text="day.ride ? rideLabel(day.ride.name) : (day.plan?.name || zoneLabel(day.plan?.type))" :query="query" />
          </span>
          <span v-if="notesSnippet(day.ride ? day.ride.notes : day.plan?.notes, query)" class="block truncate text-sm text-stone-500">
            <HighlightedText :text="notesSnippet(day.ride ? day.ride.notes : day.plan?.notes, query)!" :query="query" />
          </span>
        </span>
        <span class="flex items-center gap-1.5 text-xs font-semibold tabular">
          <span v-if="dayState(day) === 'planned'" class="rounded-full border border-[#B8D5E0] bg-[#F1F7FA] px-2 py-0.5 text-[#3B6E84]">Planned</span>
          <span v-else-if="dayState(day) === 'missed'" class="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-rose-600">Missed</span>
          <span v-if="(day.ride?.powerBests.length ?? 0) > 0" class="rounded-full border border-[#D0DFB4] bg-[#F3F7EA] px-2 py-0.5 text-[#3F6212]">★ {{ day.ride!.powerBests.length }}</span>
          <span v-if="(day.ride?.tss ?? day.plan?.tss) != null" class="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-600">{{ day.ride?.tss ?? day.plan?.tss }} TSS</span>
          <span v-if="(day.ride?.durationMinutes ?? day.plan?.durationMinutes)" class="rounded-full bg-stone-100 px-2 py-0.5 text-stone-600">{{ formatMinutes((day.ride?.durationMinutes ?? day.plan?.durationMinutes)!) }}</span>
        </span>
      </button>
    </li>
  </ul>
</template>
