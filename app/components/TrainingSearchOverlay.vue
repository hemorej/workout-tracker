<script setup lang="ts">
/**
 * Mobile search (M4): full-screen overlay with the input, a scrolling row of
 * filter chips (each opens the filter sheet) and the matches as a list grouped
 * by week, newest first. Tapping a row emits `select` so the page can open that
 * day's sheet on top.
 */
import { useTrainingSearchStore, type FilterKey, type SearchScope } from '~/stores/trainingSearch'
import type { TrainingDay } from '#shared/types/training'

const props = defineProps<{ days: TrainingDay[] }>()
const emit = defineEmits<{ select: [date: string], close: [] }>()

const search = useTrainingSearchStore()
const filterOpen = ref(false)
const input = ref<HTMLInputElement | null>(null)
onMounted(() => input.value?.focus())

const SCOPES: SearchScope[] = ['all', 'ridden', 'planned']
const SCOPE_LABEL: Record<SearchScope, string> = { all: 'All', ridden: 'Ridden', planned: 'Planned' }
const cycleScope = () => { search.scope = SCOPES[(SCOPES.indexOf(search.scope) + 1) % SCOPES.length]! }

const CHIPS: { key: FilterKey, label: string }[] = [
  { key: 'io', label: 'Indoor / outdoor' }, { key: 'tss', label: 'TSS' }, { key: 'dur', label: 'Duration' }, { key: 'date', label: 'Date' }, { key: 'types', label: 'Type' },
]
const chips = computed(() => CHIPS.map((c) => {
  const active = search.activeFilters.find(f => f.key === c.key)
  return { key: c.key, label: active?.label ?? c.label, active: !!active }
}))

/** Matching days grouped by week, newest first. */
const groups = computed(() => {
  const byMonday = new Map<string, TrainingDay[]>()
  for (const day of [...props.days].reverse()) {
    const monday = mondayOf(day.date)
    byMonday.set(monday, [...(byMonday.get(monday) ?? []), day])
  }
  return [...byMonday].map(([monday, days]) => ({ monday, label: formatWeekRange(monday), days }))
})

const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '')

function cancel() {
  search.clearAll()
  emit('close')
}
</script>

<template>
  <div class="fixed inset-0 z-40 flex flex-col bg-[#fafaf9] sm:hidden" role="dialog" aria-label="Search training">
    <div class="flex items-center gap-3 px-4 pb-2 pt-3">
      <div class="relative min-w-0 flex-1">
        <span class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[15px] text-stone-400">⌕</span>
        <input
          ref="input"
          v-model="search.q"
          type="search"
          placeholder="Search workouts and plans…"
          aria-label="Search workouts and plans"
          class="h-[42px] w-full rounded-xl border-[1.5px] border-orange-300 bg-white pl-9 pr-3 text-base text-stone-900 outline-none"
        >
      </div>
      <button type="button" class="text-[15px] font-semibold text-orange-700" @click="cancel">Cancel</button>
    </div>

    <div class="flex gap-2 overflow-x-auto px-4 pb-3">
      <button
        type="button"
        class="inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-[13px] font-semibold"
        :class="search.scope !== 'all' ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-stone-200 bg-white text-stone-600'"
        @click="cycleScope"
      >
        {{ SCOPE_LABEL[search.scope] }}<UIcon name="i-heroicons-chevron-down" class="size-3" />
      </button>
      <button
        v-for="c in chips"
        :key="c.key"
        type="button"
        class="inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-[13px] font-semibold"
        :class="c.active ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-stone-200 bg-white text-stone-600'"
        @click="filterOpen = true"
      >
        {{ c.label }}
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-4 pb-8">
      <div v-if="search.error" class="py-10 text-center text-sm text-stone-500">{{ search.error }}</div>
      <div v-else-if="!search.results" class="flex justify-center py-12">
        <BikeSpinner :size="24" class="text-stone-300" />
      </div>
      <p v-else-if="!groups.length" class="py-12 text-center text-sm font-medium text-stone-500">No workouts or plans match</p>
      <section v-for="g in groups" v-else :key="g.monday" class="mb-4">
        <h3 class="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-[.08em] text-stone-500">{{ g.label }}</h3>
        <ul class="divide-y divide-[#f7f5f3] rounded-xl border border-[#f0eeec] bg-white">
          <li v-for="day in g.days" :key="day.date">
            <button type="button" class="grid w-full grid-cols-[64px_30px_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-3 text-left" @click="emit('select', day.date)">
              <span class="text-[13px] font-semibold text-stone-600">{{ dayLabel(day.date) }}</span>
              <span class="inline-flex h-[22px] w-[30px] items-center justify-center rounded border" :class="zoneClass(dayZone(day))">
                <ZoneIcon :type="dayZone(day)" class="size-3.5 text-xs" />
              </span>
              <span class="min-w-0">
                <span class="block truncate text-sm font-semibold text-stone-800">
                  <HighlightedText :text="day.ride ? rideLabel(day.ride.name) : (day.plan?.name || zoneLabel(day.plan?.type))" :query="search.q" />
                </span>
                <span v-if="notesSnippet(day.ride ? day.ride.notes : day.plan?.notes, search.q)" class="block truncate text-xs text-stone-500">
                  <HighlightedText :text="notesSnippet(day.ride ? day.ride.notes : day.plan?.notes, search.q)!" :query="search.q" />
                </span>
              </span>
              <span class="text-xs font-semibold tabular" :class="dayState(day) === 'missed' ? 'text-stone-400 line-through' : 'text-stone-700'">
                {{ day.ride?.tss ?? day.plan?.tss ?? '' }}
              </span>
            </button>
          </li>
        </ul>
      </section>
    </div>

    <TrainingFilterSheet v-model:open="filterOpen" />
  </div>
</template>
