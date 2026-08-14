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

import type { NewWorkoutPayload, PowerBestEntry, WorkoutFitData } from '~/stores/workouts'
import { useWorkoutsStore } from '~/stores/workouts'

export interface WorkoutPrefill {
  date: string
  name: string
  durationMinutes: number
  /** Pre-filled from a matched Wahoo activity's distance, if any. */
  distanceKm?: number | null
  /** Pre-filled from the day's planned workout TSS, or computed from a Wahoo FIT file. */
  tss?: number | null
  /** Pre-filled from a matched Wahoo activity's type, if any. */
  rideType?: 'trainer' | 'outdoor' | null
  /** Computed from a Wahoo FIT file's power-curve bests, if any. Still user-editable. */
  powerBests?: PowerBestEntry[] | null
  /** Only set by the "refresh ride data" flow, carrying the existing workout's notes/rpe/ftpWatts/fitData through. */
  notes?: string | null
  rpe?: number | null
  ftpWatts?: number | null
  fitData?: WorkoutFitData | null
}

const props = defineProps<{
  /** Pre-fills date/name/duration/tss/powerBests, e.g. from a matched Wahoo activity. RPE is never pre-filled, except in edit mode. */
  prefill?: WorkoutPrefill | null
  /** When set, the form edits this existing workout (PATCH) instead of creating a new one (POST). */
  editWorkoutId?: number | null
}>()

const emit = defineEmits<{
  saved: []
  close: []
}>()

const workoutsStore = useWorkoutsStore()

// ── Constants ────────────────────────────────────────────────────────────

const POWER_BEST_DURATIONS = [
  '5sec', '15sec', '30sec', '1min', '2min', '3min', '5min',
  '8min', '10min', '15min', '20min', '30min', '45min', '1h',
] as const

// ── Form state ───────────────────────────────────────────────────────────

function todayString(): string {
  return new Date().toISOString().slice(0, 10)
}

const form = reactive({
  date: props.prefill?.date ?? todayString(),
  name: props.prefill?.name ?? '',
  durationMinutes: props.prefill?.durationMinutes ?? null as number | null,
  distanceKm: props.prefill?.distanceKm ?? null as number | null,
  tss: props.prefill?.tss ?? null as number | null,
  rpe: props.prefill?.rpe ?? null as number | null,
})

// Not user-editable — carried straight through from the matched Wahoo activity, if any.
const rideType = ref<'trainer' | 'outdoor' | null>(props.prefill?.rideType ?? null)

// Auto-expand so pre-filled power bests (from a parsed Wahoo FIT file) are visible immediately.
const optionalExpanded = ref((props.prefill?.powerBests?.length ?? 0) > 0)
const notes = ref(props.prefill?.notes ?? '')
const ftpWatts = ref<number | null>(props.prefill?.ftpWatts ?? null)
const powerBestRows = ref<{ duration: string; watts: number | null }[]>(
  (props.prefill?.powerBests ?? []).map((pb) => ({ duration: pb.duration, watts: pb.watts })),
)

function addPowerBestRow() {
  // Find the first duration not yet used
  const usedDurations = new Set(powerBestRows.value.map((r) => r.duration))
  const next = POWER_BEST_DURATIONS.find((d) => !usedDurations.has(d)) ?? POWER_BEST_DURATIONS[0]
  powerBestRows.value.push({ duration: next, watts: null })
}

function removePowerBestRow(index: number) {
  powerBestRows.value.splice(index, 1)
}

/** Available durations for a given row (not yet used in other rows) */
function availableDurations(rowIndex: number) {
  const usedElsewhere = new Set(
    powerBestRows.value
      .filter((_, i) => i !== rowIndex)
      .map((r) => r.duration),
  )
  return POWER_BEST_DURATIONS.filter((d) => !usedElsewhere.has(d))
}

/** Called by the parent whenever the modal opens */
function reset() {
  form.date = todayString()
  form.name = ''
  form.durationMinutes = null
  form.distanceKm = null
  form.tss = null
  form.rpe = null
  notes.value = ''
  ftpWatts.value = null
  rideType.value = null
  powerBestRows.value = []
  optionalExpanded.value = false
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
  if (form.distanceKm !== null && form.distanceKm < 0) {
    validationError.value = 'Distance must be 0 or greater.'
    return
  }

  // Validate power best rows
  for (const row of powerBestRows.value) {
    if (!row.watts || row.watts <= 0) {
      validationError.value = 'All power best entries must have a positive wattage.'
      return
    }
  }

  validationError.value = null
  isLoading.value = true

  const validPowerBests: PowerBestEntry[] = powerBestRows.value
    .filter((r) => r.watts && r.watts > 0)
    .map((r) => ({ duration: r.duration, watts: Math.round(r.watts!) }))

  const payload: NewWorkoutPayload = {
    date: form.date,
    name: form.name.trim(),
    durationMinutes: Math.round(form.durationMinutes),
    distanceKm: form.distanceKm !== null ? Math.round(form.distanceKm * 10) / 10 : null,
    tss: Math.round(form.tss),
    rpe: form.rpe,
    notes: notes.value.trim() || null,
    ftpWatts: ftpWatts.value ? Math.round(ftpWatts.value) : null,
    rideType: rideType.value,
    powerBests: validPowerBests.length > 0 ? validPowerBests : undefined,
    fitData: props.prefill?.fitData ?? undefined,
  }

  try {
    if (props.editWorkoutId) {
      await workoutsStore.updateWorkout(props.editWorkoutId, payload)
      toast.add({ title: 'Workout updated', color: 'success' })
    }
    else {
      await $fetch('/api/workouts', { method: 'POST', body: payload })
      toast.add({ title: 'Workout logged!', color: 'success' })
    }
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
  <form method="post" @submit.prevent="handleSubmit" class="space-y-5">

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

    <!-- Duration + Distance + TSS + RPE — short fields, one row.
         Column widths are weighted (not an even 1fr each) so every label
         fits on a single line without wrapping — RPE only ever needs two
         digits, so it gets the smallest share and a narrower input. -->
    <div class="grid grid-cols-2 sm:grid-cols-[1.3fr_1.3fr_1fr_0.85fr] gap-3">
      <UFormField name="durationMinutes">
        <template #label>
          <span class="text-[10px] font-semibold text-stone-500 uppercase tracking-wide whitespace-nowrap">Duration (min)</span>
        </template>
        <UInput
          v-model.number="form.durationMinutes"
          type="number" inputmode="numeric" min="1" step="1" placeholder="60"
          required class="w-full"
        />
      </UFormField>

      <UFormField name="distanceKm">
        <template #label>
          <span class="text-[10px] font-semibold text-stone-500 uppercase tracking-wide whitespace-nowrap">Distance (km)</span>
        </template>
        <UInput
          v-model.number="form.distanceKm"
          type="number" inputmode="decimal" min="0" step="0.1" placeholder="32.4"
          class="w-full"
        />
      </UFormField>

      <UFormField name="tss">
        <template #label>
          <span class="text-[10px] font-semibold text-stone-500 uppercase tracking-wide whitespace-nowrap">TSS</span>
        </template>
        <UInput
          v-model.number="form.tss"
          type="number" inputmode="numeric" min="0" step="1" placeholder="75"
          required class="w-full"
        />
      </UFormField>

      <!-- RPE (optional) — number input avoids dropdown z-index issues in modals -->
      <UFormField name="rpe">
        <template #label>
          <span class="text-[10px] font-semibold text-stone-500 uppercase tracking-wide whitespace-nowrap">
            RPE <span class="normal-case font-normal text-stone-300">1–10</span>
          </span>
        </template>
        <UInput
          v-model.number="form.rpe"
          type="number"
          inputmode="numeric"
          min="1"
          max="10"
          step="1"
          placeholder="—"
          class="w-16"
        />
      </UFormField>
    </div>

    <!-- Optional section (expandable) -->
    <div class="border border-stone-200 rounded-lg overflow-hidden">
      <button
        type="button"
        class="w-full flex items-center justify-between px-4 py-2.5 text-left bg-stone-50 hover:bg-stone-100 transition-colors"
        @click="optionalExpanded = !optionalExpanded"
      >
        <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Optional details</span>
        <svg
          class="w-4 h-4 text-stone-400 transition-transform duration-200"
          :class="optionalExpanded ? 'rotate-180' : ''"
          fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <div v-if="optionalExpanded" class="px-4 pt-4 pb-5 space-y-5">

        <!-- Notes -->
        <UFormField name="notes">
          <template #label>
            <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Notes</span>
          </template>
          <UTextarea
            v-model="notes"
            placeholder="How did it feel?"
            :rows="3"
            class="w-full"
          />
        </UFormField>

        <!-- FTP -->
        <UFormField name="ftpWatts">
          <template #label>
            <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">
              FTP update <span class="normal-case font-normal text-stone-300">watts</span>
            </span>
          </template>
          <UInput
            v-model.number="ftpWatts"
            type="number"
            inputmode="numeric"
            min="1"
            step="1"
            placeholder="e.g. 280"
            class="w-40"
          />
        </UFormField>

        <!-- Power bests -->
        <div>
          <p class="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2">Power bests</p>
          <div class="space-y-2">
            <div
              v-for="(row, i) in powerBestRows"
              :key="i"
              class="flex items-center gap-2"
            >
              <select
                v-model="row.duration"
                class="text-sm border border-stone-200 rounded-md px-2 py-1.5 bg-white text-stone-700 focus:outline-none focus:ring-2 focus:ring-orange-400"
              >
                <option v-for="d in availableDurations(i)" :key="d" :value="d">{{ d }}</option>
              </select>
              <UInput
                v-model.number="row.watts"
                type="number"
                inputmode="numeric"
                min="1"
                step="1"
                placeholder="watts"
                class="w-28"
              />
              <button
                type="button"
                class="text-xs text-stone-300 hover:text-rose-400 transition-colors px-1"
                @click="removePowerBestRow(i)"
              >
                ✕
              </button>
            </div>
          </div>
          <button
            v-if="powerBestRows.length < POWER_BEST_DURATIONS.length"
            type="button"
            class="mt-2 text-xs text-orange-500 hover:text-orange-700 font-medium transition-colors"
            @click="addPowerBestRow"
          >
            + Add power best
          </button>
        </div>

      </div>
    </div>

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
        {{ editWorkoutId ? 'Save changes' : 'Log workout' }}
      </UButton>
    </div>

  </form>
</template>
