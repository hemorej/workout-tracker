<script setup lang="ts">
/**
 * Search + filter toolbar for the Training tab. State lives in the
 * trainingSearch store (which mirrors it to the URL); this only renders it.
 * Grid/List and the scope control show only while a search is in play.
 */
import { DISTANCE_MAX, DURATION_MAX, TSS_MAX, useTrainingSearchStore, type SearchIo, type SearchScope, type SearchView } from '~/stores/trainingSearch'

const emit = defineEmits<{ addWorkout: [] }>()

const search = useTrainingSearchStore()
const searchFocused = ref(false)
const showModes = computed(() => searchFocused.value || search.isActive)

const segmentClass = (on: boolean) => [
  'h-8 rounded-[7px] px-3 text-[13px] font-semibold transition-colors',
  on ? 'bg-white text-stone-900 shadow-[0_1px_2px_rgba(28,25,23,.1)]' : 'text-stone-500 hover:text-stone-700',
]

const views: { value: SearchView, label: string }[] = [{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]
const scopes: { value: SearchScope, label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'ridden', label: 'Ridden' }, { value: 'planned', label: 'Planned' },
]

// ── Chip models ──────────────────────────────────────────────────────────────

interface Range { min: number | null, max: number | null }

const tss = computed<Range>({
  get: () => ({ min: search.tssMin, max: search.tssMax }),
  set: (r) => { search.tssMin = r.min; search.tssMax = r.max },
})
const duration = computed<Range>({
  get: () => ({ min: search.durMin, max: search.durMax }),
  set: (r) => { search.durMin = r.min; search.durMax = r.max },
})
const distance = computed<Range>({
  get: () => ({ min: search.distMin, max: search.distMax }),
  set: (r) => { search.distMin = r.min; search.distMax = r.max },
})
const dates = computed({
  get: () => ({ from: search.dateFrom, to: search.dateTo }),
  set: (r) => { search.dateFrom = r.from; search.dateTo = r.to },
})

const EMPTY_RANGE: Range = { min: null, max: null }
const noRange = (r: Range) => r.min == null && r.max == null

function rangeText(r: Range, fmt: (n: number) => string) {
  if (noRange(r)) return 'Any'
  if (r.min != null && r.max != null) return `${fmt(r.min)} – ${fmt(r.max)}`
  return r.min != null ? `${fmt(r.min)}+` : `≤ ${fmt(r.max!)}`
}

const IO_OPTIONS: { value: SearchIo, label: string }[] = [
  { value: 'all', label: 'Indoor & outdoor' }, { value: 'indoor', label: 'Indoor' }, { value: 'outdoor', label: 'Outdoor' },
]

const TSS_PRESETS = [{ label: 'Easy < 40', min: null, max: 40 }, { label: '40 – 80', min: 40, max: 80 }, { label: 'Hard 80+', min: 80, max: null }]
const DURATION_PRESETS = [{ label: 'Under 45m', min: null, max: 45 }, { label: '45m – 1h30', min: 45, max: 90 }, { label: '1h30+', min: 90, max: null }]
const DISTANCE_PRESETS = [{ label: 'Under 30 km', min: null, max: 30 }, { label: '30 – 60 km', min: 30, max: 60 }, { label: '60 km+', min: 60, max: null }]

const km = (n: number) => `${n} km`

// Relative date ranges, resolved to concrete dates when applied (so the URL stays shareable).
const DATE_PRESETS = computed(() => {
  const today = localDateIso()
  const monday = mondayOf(today)
  return [
    { label: 'Any time', from: '', to: '' },
    { label: 'This week', from: monday, to: addDaysIso(monday, 6) },
    { label: 'Last 2 weeks', from: addDaysIso(today, -13), to: today },
    { label: 'Next 2 weeks', from: today, to: addDaysIso(today, 13) },
  ]
})

const dateText = (d: { from: string, to: string }) =>
  DATE_PRESETS.value.find(p => p.from === d.from && p.to === d.to)?.label
  ?? (d.from && d.to ? `${d.from} – ${d.to}` : d.from ? `From ${d.from}` : `Until ${d.to}`)

const typeOptions = PLAN_ZONES.filter(z => z.value !== 'rest')
const toggleType = (list: string[], value: string) => (list.includes(value) ? list.filter(v => v !== value) : [...list, value])
</script>

<template>
  <div class="flex flex-wrap items-center gap-2.5 sm:flex-nowrap">
    <div class="relative min-w-0 flex-1 basis-[160px]">
      <span class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[15px] text-stone-400">⌕</span>
      <input
        v-model="search.q"
        type="text"
        placeholder="Search workouts and plans…"
        aria-label="Search workouts and plans"
        class="h-[42px] w-full rounded-xl border-[1.5px] bg-stone-50 pl-10 pr-9 text-[15px] text-stone-900 outline-none"
        :class="search.q ? 'border-orange-300 ring-[3px] ring-orange-50' : 'border-stone-200'"
        @focus="searchFocused = true"
        @blur="searchFocused = false"
        @keydown.esc="search.q = ''"
      >
      <button
        v-if="search.q"
        type="button"
        class="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700"
        aria-label="Clear search"
        @click="search.q = ''"
      >
        <UIcon name="i-heroicons-x-mark" class="size-4" />
      </button>
    </div>

    <template v-if="showModes">
      <div class="flex gap-0.5 rounded-[10px] bg-[#f5f4f2] p-[3px]" role="group" aria-label="View">
        <button v-for="v in views" :key="v.value" type="button" :class="segmentClass(search.view === v.value)" :aria-pressed="search.view === v.value" @click="search.view = v.value">{{ v.label }}</button>
      </div>
      <div class="flex gap-0.5 rounded-[10px] bg-[#f5f4f2] p-[3px]" role="group" aria-label="Scope">
        <button v-for="s in scopes" :key="s.value" type="button" :class="segmentClass(search.scope === s.value)" :aria-pressed="search.scope === s.value" @click="search.scope = s.value">{{ s.label }}</button>
      </div>
    </template>

    <div class="flex items-center gap-2">
      <FilterChip v-model="search.io" icon="i-heroicons-tag" title="Indoor / outdoor" empty="all" :applied="search.io !== 'all'" :format="v => IO_OPTIONS.find(o => o.value === v)!.label">
        <template #default="{ draft, set }">
          <div class="flex flex-col gap-1.5">
            <button
              v-for="o in IO_OPTIONS"
              :key="o.value"
              type="button"
              class="h-[34px] rounded-lg border px-3 text-left text-[13px] font-semibold"
              :class="draft === o.value ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-stone-200 text-stone-600'"
              @click="set(o.value)"
            >
              {{ o.label }}
            </button>
          </div>
        </template>
      </FilterChip>

      <FilterChip v-model="tss" icon="i-heroicons-bolt" title="TSS" :empty="EMPTY_RANGE" :applied="!noRange(tss)" :format="r => rangeText(r, String)">
        <template #default="{ draft, set }">
          <RangeSliders :model-value="draft" :max="TSS_MAX" :step="5" :format="String" :presets="TSS_PRESETS" @update:model-value="set" />
        </template>
      </FilterChip>

      <FilterChip v-model="duration" icon="i-heroicons-clock" title="Duration" :empty="EMPTY_RANGE" :applied="!noRange(duration)" :format="r => rangeText(r, formatMinutes)">
        <template #default="{ draft, set }">
          <RangeSliders :model-value="draft" :max="DURATION_MAX" :step="15" :format="formatMinutes" :presets="DURATION_PRESETS" @update:model-value="set" />
        </template>
      </FilterChip>

      <FilterChip v-model="distance" icon="i-heroicons-map-pin" title="Distance" :empty="EMPTY_RANGE" :applied="!noRange(distance)" :format="r => rangeText(r, km)">
        <template #default="{ draft, set }">
          <RangeSliders :model-value="draft" :max="DISTANCE_MAX" :step="5" :format="km" :presets="DISTANCE_PRESETS" @update:model-value="set" />
        </template>
      </FilterChip>

      <FilterChip v-model="dates" icon="i-heroicons-calendar-days" title="Date range" :empty="{ from: '', to: '' }" :applied="!!(dates.from || dates.to)" :format="dateText">
        <template #default="{ draft, set }">
          <div class="flex flex-col gap-1.5">
            <button
              v-for="p in DATE_PRESETS"
              :key="p.label"
              type="button"
              class="h-[34px] rounded-lg border px-3 text-left text-[13px] font-semibold"
              :class="p.from === draft.from && p.to === draft.to ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-stone-200 text-stone-600'"
              @click="set({ from: p.from, to: p.to })"
            >
              {{ p.label }}
            </button>
            <div class="mt-1 grid grid-cols-2 gap-2">
              <label class="flex flex-col gap-1 text-[10px] font-semibold uppercase tracking-[.08em] text-stone-500">
                From
                <input :value="draft.from" type="date" class="h-8 rounded-lg border border-stone-200 px-2 text-[13px] font-normal normal-case tracking-normal text-stone-800" @input="set({ ...draft, from: ($event.target as HTMLInputElement).value })">
              </label>
              <label class="flex flex-col gap-1 text-[10px] font-semibold uppercase tracking-[.08em] text-stone-500">
                To
                <input :value="draft.to" type="date" class="h-8 rounded-lg border border-stone-200 px-2 text-[13px] font-normal normal-case tracking-normal text-stone-800" @input="set({ ...draft, to: ($event.target as HTMLInputElement).value })">
              </label>
            </div>
          </div>
        </template>
      </FilterChip>

      <FilterChip v-model="search.types" icon="i-heroicons-squares-2x2" title="Workout type" :empty="[]" :applied="search.types.length > 0" :format="v => (v.length ? v.map(zoneLabel).join(', ') : 'Any')">
        <template #default="{ draft, set }">
          <div class="grid grid-cols-2 gap-1.5">
            <button
              v-for="z in typeOptions"
              :key="z.value"
              type="button"
              class="flex h-[34px] items-center gap-2 rounded-lg border px-2 text-[13px] font-semibold"
              :class="draft.includes(z.value) ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-stone-200 text-stone-600'"
              :aria-pressed="draft.includes(z.value)"
              @click="set(toggleType(draft, z.value))"
            >
              <span class="inline-flex h-[17px] w-[22px] items-center justify-center rounded border text-[10.5px]" :class="zoneClass(z.value)"><ZoneIcon :type="z.value" class="size-3 text-[10.5px]" /></span>
              {{ z.label }}
            </button>
          </div>
        </template>
      </FilterChip>
    </div>

    <button
      type="button"
      class="shrink-0 rounded-xl bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-orange-600/20 transition-colors hover:bg-orange-700"
      @click="emit('addWorkout')"
    >
      Add workout
    </button>
  </div>
</template>
