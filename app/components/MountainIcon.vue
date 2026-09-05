<script setup lang="ts">
/**
 * Segments sub-tab icon. Heroicons has no mountain glyph, so this is Lucide's
 * `mountain-snow` redrawn on the heroicons 24×24 optical grid at stroke 1.6 —
 * the ridge line is what keeps it legible at 17px. `class` falls through from
 * the call site (HistoryTab.vue's tab loop).
 */
</script>

<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      d="m8.5 3.75 3.9 7.6 4.35-4.35 6 15.25H1.25L8.5 3.75Z"
    />
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      d="M4.6 15.3c2.5-1.5 5-1.35 7.5.4s5 1.75 7.5.05"
    />
  </svg>
</template>
