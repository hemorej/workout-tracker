<script setup lang="ts">
/**
 * Search + filter toolbar for the Training tab. State lives in the
 * trainingSearch store (which mirrors it to the URL); this only renders it.
 * Grid/List and the scope control show only while a search is in play.
 */
import {
  DISTANCE_PRESETS, DURATION_PRESETS, EMPTY_RANGE, IO_OPTIONS, TSS_PRESETS, dateRangeText, datePresets, formatKm, noRange, rangeText, toggleType, typeFilterOptions,
} from '~/utils/trainingFilters'
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

const { tss, duration, distance, dates } = storeToRefs(search)
const DATE_PRESETS = computed(datePresets)
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

      <FilterChip v-model="distance" icon="i-heroicons-map-pin" title="Distance" :empty="EMPTY_RANGE" :applied="!noRange(distance)" :format="r => rangeText(r, formatKm)">
        <template #default="{ draft, set }">
          <RangeSliders :model-value="draft" :max="DISTANCE_MAX" :step="5" :format="formatKm" :presets="DISTANCE_PRESETS" @update:model-value="set" />
        </template>
      </FilterChip>

      <FilterChip v-model="dates" icon="i-heroicons-calendar-days" title="Date range" :empty="{ from: '', to: '' }" :applied="!!(dates.from || dates.to)" :format="dateRangeText">
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
              v-for="z in typeFilterOptions"
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
