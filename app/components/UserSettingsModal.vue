<script setup lang="ts">
/**
 * UserSettingsModal — form-only (mirrors AddWorkoutModal's split): the
 * Teleport/backdrop wrapper lives in the parent, this just owns form state,
 * loading, and submission.
 *
 * Fetches the user's current weight/training plan on mount (they're not part
 * of the session — see server/api/users/me.get.ts) and PUTs changes back.
 * Always an update, never a create — the user row already exists.
 *
 * Emits:
 *   saved — settings were saved successfully; parent should close
 *   close — user pressed Cancel; parent should close
 */

const emit = defineEmits<{
  saved: []
  close: []
}>()

const toast = useToast()
const isLoading = ref(false)
const isSaving = ref(false)

const weightKg = ref<number | null>(null)
const trainingPlan = ref('')

onMounted(async () => {
  isLoading.value = true
  try {
    const data = await $fetch<{ weightKg: number | null, trainingPlan: string | null }>('/api/users/me')
    weightKg.value = data.weightKg
    trainingPlan.value = data.trainingPlan ?? ''
  }
  catch {
    toast.add({ title: "Couldn't load your settings", color: 'error' })
  }
  finally {
    isLoading.value = false
  }
})

async function handleSubmit() {
  if (weightKg.value !== null && weightKg.value <= 0) {
    toast.add({ title: 'Weight must be greater than 0.', color: 'error' })
    return
  }

  isSaving.value = true
  try {
    await $fetch('/api/users/me', {
      method: 'PUT',
      body: {
        weightKg: weightKg.value,
        trainingPlan: trainingPlan.value.trim() || null,
      },
    })
    toast.add({ title: 'Settings saved', color: 'success' })
    emit('saved')
  }
  catch (err: unknown) {
    const message = (err as { data?: { statusMessage?: string } })?.data?.statusMessage
      ?? 'Failed to save settings.'
    toast.add({ title: 'Error', description: message, color: 'error' })
  }
  finally {
    isSaving.value = false
  }
}
</script>

<template>
  <form method="post" @submit.prevent="handleSubmit" class="space-y-5">
    <div v-if="isLoading" class="flex justify-center py-10">
      <BikeSpinner :size="24" class="text-stone-300" />
    </div>

    <template v-else>
      <UFormField name="weightKg">
        <div class="flex items-center gap-3">
          <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Weight (kg)</span>
          <UInput
            v-model.number="weightKg"
            type="number" inputmode="decimal" min="0" step="0.1" placeholder="e.g. 68"
            class="w-20"
          />
        </div>
      </UFormField>

      <UFormField name="trainingPlan">
        <template #label>
          <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Training plan</span>
        </template>
        <UTextarea
          v-model="trainingPlan"
          placeholder="Context the AI coach uses when generating workouts…"
          :rows="11"
          class="w-full"
        />
      </UFormField>

      <div class="flex justify-end items-center gap-4 pt-2">
        <button
          type="button"
          class="text-sm font-medium text-stone-500 hover:text-stone-700 transition-colors"
          @click="emit('close')"
        >
          Cancel
        </button>
        <UButton type="submit" :loading="isSaving" size="md" class="rounded-lg font-semibold">
          Save
        </UButton>
      </div>
    </template>
  </form>
</template>
