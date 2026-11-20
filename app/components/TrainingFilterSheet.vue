<script setup lang="ts">
/**
 * Mobile filter sheet (M5): every search filter in one bottom sheet. Changes
 * apply live — the footer button just closes it and shows the running count.
 */
import { DISTANCE_MAX, DURATION_MAX, TSS_MAX, useTrainingSearchStore, type SearchIo } from '~/stores/trainingSearch'
import {
  DISTANCE_PRESETS, DURATION_PRESETS, IO_OPTIONS, TSS_PRESETS, datePresets, formatKm, toggleType, typeFilterOptions,
} from '~/utils/trainingFilters'

const open = defineModel<boolean>('open', { required: true })

const search = useTrainingSearchStore()
const { tss, duration, distance, dates } = storeToRefs(search)

const DATE_PRESETS = computed(datePresets)
const count = computed(() => search.results?.matches.length ?? 0)

const segment = (on: boolean) => [
  'h-10 flex-1 rounded-[9px] text-[13px] font-semibold transition-colors',
  on ? 'bg-white text-stone-900 shadow-[0_1px_2px_rgba(28,25,23,.1)]' : 'text-stone-500',
]
const ioLabels: Record<SearchIo, string> = { all: 'Both', indoor: 'Indoor', outdoor: 'Outdoor' }
</script>

<template>
  <UDrawer v-model:open="open" :ui="{ content: 'rounded-t-[22px]' }">
    <template #content>
      <div class="flex max-h-[88vh] flex-col">
        <div class="flex items-center justify-between px-5 pb-2 pt-3">
          <span class="text-base font-bold text-stone-900">Filters</span>
          <button v-if="search.hasFilters" type="button" class="text-[13px] font-semibold text-orange-700" @click="search.clearAll()">Reset all</button>
        </div>

        <div class="flex flex-col gap-5 overflow-y-auto px-5 pb-4">
          <section>
            <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-[.08em] text-stone-500">Type</h3>
            <div class="grid grid-cols-2 gap-2">
              <button
                v-for="z in typeFilterOptions"
                :key="z.value"
                type="button"
                class="flex h-11 items-center gap-2 rounded-xl border px-3 text-sm font-semibold"
                :class="search.types.includes(z.value) ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-stone-200 text-stone-600'"
                :aria-pressed="search.types.includes(z.value)"
                @click="search.types = toggleType(search.types, z.value)"
              >
                <span class="inline-flex h-[17px] w-[22px] items-center justify-center rounded border text-[10.5px]" :class="zoneClass(z.value)"><ZoneIcon :type="z.value" class="size-3 text-[10.5px]" /></span>
                {{ z.label }}
              </button>
            </div>
          </section>

          <section>
            <h3 class="mb-2 flex justify-between text-[11px] font-semibold uppercase tracking-[.08em] text-stone-500">TSS <span class="text-orange-700 normal-case tracking-normal">{{ rangeText(tss, String) }}</span></h3>
            <RangeSliders v-model="tss" :max="TSS_MAX" :step="5" :format="String" :presets="TSS_PRESETS" />
          </section>

          <section>
            <h3 class="mb-2 flex justify-between text-[11px] font-semibold uppercase tracking-[.08em] text-stone-500">Duration <span class="text-orange-700 normal-case tracking-normal">{{ rangeText(duration, formatMinutes) }}</span></h3>
            <RangeSliders v-model="duration" :max="DURATION_MAX" :step="15" :format="formatMinutes" :presets="DURATION_PRESETS" />
          </section>

          <section>
            <h3 class="mb-2 flex justify-between text-[11px] font-semibold uppercase tracking-[.08em] text-stone-500">Distance <span class="text-orange-700 normal-case tracking-normal">{{ rangeText(distance, formatKm) }}</span></h3>
            <RangeSliders v-model="distance" :max="DISTANCE_MAX" :step="5" :format="formatKm" :presets="DISTANCE_PRESETS" />
          </section>

          <section>
            <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-[.08em] text-stone-500">Indoor / outdoor</h3>
            <div class="flex gap-0.5 rounded-xl bg-[#f5f4f2] p-[3px]">
              <button v-for="o in IO_OPTIONS" :key="o.value" type="button" :class="segment(search.io === o.value)" :aria-pressed="search.io === o.value" @click="search.io = o.value">{{ ioLabels[o.value] }}</button>
            </div>
          </section>

          <section>
            <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-[.08em] text-stone-500">Date</h3>
            <div class="grid grid-cols-2 gap-2">
              <button
                v-for="p in DATE_PRESETS"
                :key="p.label"
                type="button"
                class="h-10 rounded-xl border text-[13px] font-semibold"
                :class="p.from === dates.from && p.to === dates.to ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-stone-200 text-stone-600'"
                @click="dates = { from: p.from, to: p.to }"
              >
                {{ p.label }}
              </button>
            </div>
          </section>
        </div>

        <div class="px-5 pb-6 pt-2">
          <button type="button" class="h-[50px] w-full rounded-full bg-orange-600 text-[15px] font-semibold text-white" @click="open = false">
            Show {{ count }} result{{ count === 1 ? '' : 's' }}
          </button>
        </div>
      </div>
    </template>
  </UDrawer>
</template>
