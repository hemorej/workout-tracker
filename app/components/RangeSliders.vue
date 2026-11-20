<script setup lang="ts">
/**
 * Min + Max sliders over 0…`max` with preset buttons. A thumb at `max` means
 * "no bound" (null), shown as "{max}+".
 */
interface Range { min: number | null, max: number | null }

const props = defineProps<{
  max: number
  step: number
  format: (n: number) => string
  presets: { label: string, min: number | null, max: number | null }[]
  /** Hide the Max slider (a minimum-only filter). */
  minOnly?: boolean
}>()

const range = defineModel<Range>({ required: true })

const lo = computed({
  get: () => range.value.min ?? 0,
  set: (v: number) => {
    range.value = { min: v <= 0 ? null : v, max: range.value.max != null && range.value.max < v ? v : range.value.max }
  },
})
const hi = computed({
  get: () => range.value.max ?? props.max,
  set: (v: number) => {
    range.value = { min: range.value.min != null && range.value.min > v ? v : range.value.min, max: v >= props.max ? null : v }
  },
})

const shown = (n: number) => (n >= props.max ? `${props.format(props.max)}+` : props.format(n))
const isPreset = (p: { min: number | null, max: number | null }) => p.min === range.value.min && p.max === range.value.max
</script>

<template>
  <div class="flex flex-col gap-3">
    <label class="flex flex-col gap-1">
      <span class="flex justify-between text-[11px] font-semibold uppercase tracking-[.08em] text-stone-500">Min <span class="normal-case tracking-normal tabular">{{ format(lo) }}</span></span>
      <input v-model.number="lo" type="range" min="0" :max="max" :step="step" class="w-full accent-orange-600">
    </label>
    <label v-if="!minOnly" class="flex flex-col gap-1">
      <span class="flex justify-between text-[11px] font-semibold uppercase tracking-[.08em] text-stone-500">Max <span class="normal-case tracking-normal tabular">{{ shown(hi) }}</span></span>
      <input v-model.number="hi" type="range" min="0" :max="max" :step="step" class="w-full accent-orange-600">
    </label>
    <div class="flex flex-wrap gap-1.5">
      <button
        v-for="p in presets"
        :key="p.label"
        type="button"
        class="h-7 rounded-full border px-2.5 text-xs font-semibold"
        :class="isPreset(p) ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-stone-200 bg-white text-stone-600'"
        @click="range = { min: p.min, max: p.max }"
      >
        {{ p.label }}
      </button>
    </div>
  </div>
</template>
