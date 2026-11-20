<script setup lang="ts" generic="T">
/**
 * A 34px circular filter chip that opens a draft/apply popover.
 *
 * The body (default slot) edits `draft`, a copy of the committed value; only
 * Apply commits it (`update:modelValue`). Esc / click-outside / Cancel discard.
 * Reset sets the draft back to `empty`. Orange when applied or open, with a dot
 * while a value is applied.
 */
const props = defineProps<{
  icon: string
  /** Popover title, also the aria-label ("Filter by …"). */
  title: string
  modelValue: T
  /** The "no filter" value Reset restores. */
  empty: T
  /** Current-value text in the popover header, e.g. "40 – 80". */
  format: (value: T) => string
  applied: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: T] }>()

const open = ref(false)
const draft = ref(structuredClone(toRaw(props.modelValue))) as Ref<T>

// Every opening starts from the committed value.
watch(open, (isOpen) => {
  if (isOpen) draft.value = structuredClone(toRaw(props.modelValue))
})

function apply() {
  emit('update:modelValue', structuredClone(toRaw(draft.value)))
  open.value = false
}

function reset() {
  draft.value = structuredClone(toRaw(props.empty))
}
</script>

<template>
  <UPopover
    v-model:open="open"
    :content="{ align: 'end', sideOffset: 8 }"
    :ui="{ content: 'w-[290px] rounded-2xl border border-[#f0eeec] bg-white p-0 shadow-[0_16px_40px_rgba(28,25,23,.18)] ring-0' }"
  >
    <button
      type="button"
      class="relative flex size-[34px] shrink-0 items-center justify-center rounded-full border-[1.5px]"
      :class="applied || open ? 'border-orange-300 bg-orange-50 text-orange-600' : 'border-stone-200 bg-white text-stone-600'"
      :title="title"
      :aria-label="`Filter by ${title.toLowerCase()}`"
      :aria-expanded="open"
    >
      <UIcon :name="icon" class="size-4" />
      <span v-if="applied" class="absolute -right-0.5 -top-0.5 size-[9px] rounded-full bg-orange-600 ring-2 ring-[#fafaf9]" />
    </button>

    <template #content>
      <div class="flex flex-col gap-3.5 px-5 py-[18px]">
        <div class="flex items-baseline justify-between gap-2">
          <span class="text-sm font-semibold text-stone-900">{{ title }}</span>
          <span class="text-[13px] font-semibold text-orange-700">{{ format(draft) }}</span>
        </div>
        <slot :draft="draft" :set="(v: T) => (draft = v)" />
        <div class="flex items-center gap-2">
          <button type="button" class="h-8 rounded-[9px] border-[1.5px] border-orange-300 bg-white px-3 text-[13px] font-semibold text-orange-600" @click="reset">Reset</button>
          <span class="flex-1" />
          <button type="button" class="h-8 rounded-[9px] bg-[#f5f4f2] px-3 text-[13px] font-semibold text-stone-500" @click="open = false">Cancel</button>
          <button type="button" class="h-8 rounded-[9px] bg-orange-600 px-3.5 text-[13px] font-semibold text-white" @click="apply">Apply</button>
        </div>
      </div>
    </template>
  </UPopover>
</template>
