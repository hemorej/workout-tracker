<script setup lang="ts">
/**
 * AddWorkoutModal — the form fields only, no modal wrapper.
 *
 * UModal lives in index.vue (where the open state is owned).
 * This component just handles form state, validation, and submission.
 *
 * Emits:
 *   saved — workout was created successfully; parent should refresh and close
 *   close — user pressed Cancel; parent should close the modal
 */

import type { NewWorkoutPayload } from '~/stores/workouts'

const emit = defineEmits<{
  saved: []
  close: []
}>()

// ── Form state ───────────────────────────────────────────────────────────

function todayString(): string {
  return new Date().toISOString().slice(0, 10)
}

const form = reactive({
  date: todayString(),
  name: '',
  durationMinutes: null as number | null,
  tss: null as number | null,
  rpe: null as number | null,
  notes: '',
})

/** Called by the parent whenever the modal opens */
function reset() {
  form.date = todayString()
  form.name = ''
  form.durationMinutes = null
  form.tss = null
  form.rpe = null
  form.notes = ''
  validationError.value = null
}

defineExpose({ reset })

// ── Submission ───────────────────────────────────────────────────────────

const toast = useToast()
const isLoading = ref(false)
const validationError = ref<string | null>(null)

async function handleSubmit() {
  if (!form.name.trim()) {
    validationError.value = 'Workout name is required.'
    return
  }
  if (!form.durationMinutes || form.durationMinutes <= 0) {
    validationError.value = 'Duration must be a positive number.'
    return
  }
  if (form.tss === null || form.tss < 0) {
    validationError.value = 'TSS must be 0 or greater.'
    return
  }

  validationError.value = null
  isLoading.value = true

  const payload: NewWorkoutPayload = {
    date: form.date,
    name: form.name.trim(),
    durationMinutes: Math.round(form.durationMinutes),
    tss: Math.round(form.tss),
    rpe: form.rpe,
    notes: form.notes.trim() || null,
  }

  try {
    await $fetch('/api/workouts', { method: 'POST', body: payload })
    toast.add({ title: 'Workout logged!', color: 'success' })
    emit('saved')
  }
  catch (err: unknown) {
    const message = (err as { data?: { statusMessage?: string } })?.data?.statusMessage
      ?? 'Failed to save workout.'
    toast.add({ title: 'Error', description: message, color: 'error' })
  }
  finally {
    isLoading.value = false
  }
}
</script>

<template>
  <form @submit.prevent="handleSubmit" class="space-y-5">

    <!-- Date -->
    <UFormField name="date">
      <template #label>
        <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Date</span>
      </template>
      <UInput v-model="form.date" type="date" required class="w-full" />
    </UFormField>

    <!-- Name -->
    <UFormField name="name">
      <template #label>
        <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Workout name</span>
      </template>
      <UInput
        v-model="form.name"
        placeholder="e.g. Morning run, Tempo ride…"
        required
        class="w-full"
      />
    </UFormField>

    <!-- Duration + TSS + RPE — short fields, one row -->
    <div class="grid grid-cols-3 gap-4">
      <UFormField name="durationMinutes">
        <template #label>
          <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Duration (min)</span>
        </template>
        <UInput
          v-model.number="form.durationMinutes"
          type="number" min="1" step="1" placeholder="60"
          required class="w-full"
        />
      </UFormField>

      <UFormField name="tss">
        <template #label>
          <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">TSS</span>
        </template>
        <UInput
          v-model.number="form.tss"
          type="number" min="0" step="1" placeholder="75"
          required class="w-full"
        />
      </UFormField>

      <!-- RPE (optional) — number input avoids dropdown z-index issues in modals -->
      <UFormField name="rpe">
        <template #label>
          <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide whitespace-nowrap">
            RPE <span class="normal-case font-normal text-stone-300">1–10</span>
          </span>
        </template>
        <UInput
          v-model.number="form.rpe"
          type="number"
          min="1"
          max="10"
          step="1"
          placeholder="—"
          class="w-full"
        />
      </UFormField>
    </div>

    <!-- Notes (optional) -->
    <UFormField name="notes">
      <template #label>
        <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">
          Notes <span class="normal-case font-normal text-stone-300">(optional)</span>
        </span>
      </template>
      <UTextarea
        v-model="form.notes"
        placeholder="How did it feel?"
        :rows="3"
        class="w-full"
      />
    </UFormField>

    <!-- Validation error -->
    <p v-if="validationError" class="text-xs text-rose-400">{{ validationError }}</p>

    <!-- Actions -->
    <div class="flex justify-end items-center gap-4 pt-2">
      <button
        type="button"
        class="text-sm font-medium text-stone-500 hover:text-stone-700 transition-colors"
        @click="emit('close')"
      >
        Cancel
      </button>
      <UButton type="submit" :loading="isLoading" size="md" class="rounded-lg font-semibold">
        Log workout
      </UButton>
    </div>

  </form>
</template>
