<script setup lang="ts">
// Text with the case-insensitive occurrences of `query` wrapped in <mark>.
defineProps<{ text: string, query?: string }>()
</script>

<template>
  <template v-for="(part, i) in splitMatches(text, query ?? '')" :key="i">
    <mark v-if="part.hit" class="rounded-sm bg-amber-200 text-inherit">{{ part.text }}</mark>
    <template v-else>{{ part.text }}</template>
  </template>
</template>
