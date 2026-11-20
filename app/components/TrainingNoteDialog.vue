<script setup lang="ts">
/**
 * Plan-note editor for a day. The text is a local buffer, so Cancel discards
 * it; nothing is saved until Save (or Clear note).
 */
const props = defineProps<{ date: string, initial: string, hasSavedNote: boolean }>()
const emit = defineEmits<{ save: [notes: string | null], close: [] }>()

const text = ref(props.initial)
const textarea = ref<HTMLTextAreaElement | null>(null)

// Native `autofocus` isn't reliably honoured for elements inserted via Teleport (Firefox in particular).
onMounted(() => textarea.value?.focus())

// Grows with the note (4 rows minimum) but caps at 12 so a long note scrolls instead of pushing the modal off-screen.
const rows = computed(() => Math.min(12, Math.max(4, Math.ceil(text.value.length / 60) + 1)))
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4" role="dialog" aria-modal="true" aria-label="Day note">
      <div class="fixed inset-0 bg-black/25 backdrop-blur-sm" @click="emit('close')" />
      <div class="relative my-8 w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <div class="mb-4 flex items-start justify-between">
          <h2 class="text-lg font-semibold text-stone-900">Note — {{ formatDayLong(date) }}</h2>
          <button class="ml-4 mt-0.5 cursor-pointer text-stone-300 hover:text-stone-600" aria-label="Close" @click="emit('close')">
            <UIcon name="i-heroicons-x-mark" class="size-5" />
          </button>
        </div>
        <textarea
          ref="textarea"
          v-model="text"
          :rows="rows"
          placeholder="Add a note for this day…"
          class="note-scroll w-full resize-none overflow-y-auto rounded-lg border border-stone-200 p-3 text-sm text-stone-700 placeholder-stone-300 outline-none focus:border-stone-400"
        />
        <div class="mt-4 flex items-center justify-between gap-3">
          <button v-if="hasSavedNote" type="button" class="cursor-pointer text-sm text-stone-400 hover:text-red-600" @click="emit('save', null)">Clear note</button>
          <div v-else />
          <div class="flex gap-3">
            <button class="cursor-pointer text-sm text-stone-400 hover:text-stone-600" @click="emit('close')">Cancel</button>
            <button class="cursor-pointer rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700" @click="emit('save', text.trim() || null)">Save</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Thin orange-themed scrollbar — Firefox */
.note-scroll {
  scrollbar-width: thin;
  scrollbar-color: var(--ui-primary) transparent;
}

/* Chrome/Safari */
.note-scroll::-webkit-scrollbar {
  width: 6px;
}
.note-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.note-scroll::-webkit-scrollbar-thumb {
  background-color: var(--ui-primary);
  border-radius: 9999px;
}
</style>
