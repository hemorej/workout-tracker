<script setup lang="ts">
// Workout-type glyph for the Planning tab. Zones 2/4/5/6 render their number,
// rest a moon, outdoor a sun. `class` falls through for sizing/colour (use a
// `text-*` size for the numerals — the SVG glyphs scale with w-/h-).
defineProps<{ type: string | null }>()
const NUMERAL: Record<string, string> = { zone2: '2', zone4: '4', zone5: '5', zone6: '6' }
</script>

<template>
  <span
    v-if="type && NUMERAL[type]"
    class="inline-flex items-center justify-center font-bold leading-none tabular-nums"
  >{{ NUMERAL[type] }}</span>
  <svg v-else-if="type === 'rest'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />
  </svg>
  <svg v-else-if="type === 'outdoor'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </svg>
  <span v-else class="inline-flex items-center justify-center leading-none">·</span>
</template>
