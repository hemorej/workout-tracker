<script setup lang="ts">
/**
 * The content of a day's card — shown in the hover card (desktop) and the
 * bottom sheet (touch), so every action lives here once.
 *
 * Plan edits (name / TSS / minutes / zone / clear) save straight through the
 * training store, like the old Planning rows did (on blur). Everything else is
 * emitted as a `DayAction` for TrainingTab or the page to handle.
 */
import type { DropdownMenuItem } from '@nuxt/ui'
import type { PlanEntry, TrainingDay } from '#shared/types/training'
import { useTrainingStore } from '~/stores/training'

const props = defineProps<{
  day: TrainingDay
  /** Metrics to show — the draft-aware projection for editable days. */
  metrics: { ctl: number, tsb: number }
  /** Larger touch targets (bottom sheet). */
  touch?: boolean
  pinned?: boolean
  /** A fuelling guide is being generated for this day. */
  fuellingLoading?: boolean
  /** Id of the ride whose FIT data is being re-fetched. */
  refreshingRideId?: number | null
}>()

const emit = defineEmits<{ action: [DayAction] }>()

const training = useTrainingStore()
const state = computed(() => dayState(props.day))
const plan = computed(() => props.day.plan)
const ride = computed(() => props.day.ride)
const isProjection = computed(() => !isActualDay(props.day))

const heading = computed(() => `${props.day.isToday ? 'Today, ' : ''}${formatDayLong(props.day.date)}`)

// ── Plan editing ─────────────────────────────────────────────────────────────

const buffer = reactive<{ name: string, tss: string | number, minutes: string | number }>({ name: '', tss: '', minutes: '' })
watch(plan, (p) => {
  buffer.name = p?.name ?? ''
  buffer.tss = p?.tss != null ? String(p.tss) : ''
  buffer.minutes = p?.durationMinutes != null ? String(p.durationMinutes) : ''
}, { immediate: true, deep: true })

const saving = ref(false)

async function write(entry: PlanEntry) {
  saving.value = true
  try {
    await training.savePlan(props.day.date, entry)
  }
  finally {
    saving.value = false
  }
}

/** Number inputs bound with v-model hand back a number (or '' when empty), not a string. */
const toNumber = (v: string | number) => (String(v).trim() === '' ? null : Number(v))

/** Saves the field buffers if they differ from the saved plan (blur / Enter). */
async function saveFields() {
  const next: PlanEntry = {
    name: buffer.name.trim() || null,
    type: plan.value?.type ?? null,
    tss: toNumber(buffer.tss),
    durationMinutes: toNumber(buffer.minutes),
    notes: plan.value?.notes ?? null,
  }
  const p = plan.value
  if (next.name === (p?.name ?? null) && next.tss === (p?.tss ?? null) && next.durationMinutes === (p?.durationMinutes ?? null)) return
  await write(next)
}

const blank = (type: string | null): PlanEntry => ({ name: null, type, tss: null, durationMinutes: null, notes: null })

async function setZone(type: string | null) {
  await write({ ...(plan.value ?? blank(type)), type })
}

/** Rest days read as Rest even though no plan row exists. */
const headerZone = computed(() => (state.value === 'rest' ? 'rest' : plan.value?.type ?? null))

const nameInput = ref<HTMLInputElement | null>(null)

/** Rest day → Zone 2 session, name field focused. */
async function planSession() {
  await setZone('zone2')
  await nextTick()
  nameInput.value?.focus()
}

const zoneItems = computed<DropdownMenuItem[]>(() =>
  [...PLAN_ZONES, { value: null, label: 'No type' }].map(z => ({
    label: z.label,
    type: 'checkbox' as const,
    checked: headerZone.value === z.value,
    onSelect: () => setZone(z.value),
  })),
)

// ── Move to… ─────────────────────────────────────────────────────────────────

/** Future days a plan can move to; a missed day (whose plan isn't swapped back) only to empty ones. */
const moveItems = computed<DropdownMenuItem[]>(() =>
  training.days
    .filter(d => !isActualDay(d) && (state.value !== 'missed' || !hasContent(d.plan)))
    .slice(0, 28)
    .map(d => ({
      label: `${formatDayLong(d.date)}${d.plan?.name ? ` · ${d.plan.name}` : ''}`,
      onSelect: () => emit('action', { type: 'move', date: props.day.date, to: d.date }),
    })),
)

// ── Delete confirm ───────────────────────────────────────────────────────────

const confirmingDelete = ref(false)

// ── Styling ──────────────────────────────────────────────────────────────────

const inputClass = computed(() => [
  'w-full rounded-lg border border-stone-200 bg-white px-2.5 text-stone-800 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100',
  props.touch ? 'h-11 text-base' : 'h-8 text-[13px] sm:h-[30px]',
])
const linkClass = computed(() => props.touch
  ? 'flex h-[42px] items-center justify-center rounded-[10px] bg-stone-100 text-sm font-semibold text-stone-700 disabled:opacity-50'
  : 'text-[12.5px] font-medium text-stone-600 hover:text-stone-900 disabled:opacity-50')
const dangerClass = computed(() => props.touch
  ? 'flex h-[42px] items-center justify-center rounded-[10px] bg-rose-50 text-sm font-semibold text-rose-600'
  : 'text-[12.5px] font-medium text-rose-600 hover:text-rose-700')
const linksLayout = computed(() => props.touch ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap items-center gap-x-3.5 gap-y-1.5')
const primaryHeight = computed(() => props.touch ? 'h-[46px] text-sm' : 'h-8 text-[13px]')

const act = (a: DayAction) => emit('action', a)
/** Actions that hand the planned day to the coach / another dialog: flush pending field edits first so they act on what's saved. */
async function actAfterSave(a: DayAction) {
  await saveFields()
  act(a)
}
const isOutdoorRide = computed(() => ride.value?.rideType === 'outdoor')
</script>

<template>
  <div class="flex flex-col gap-3" role="group" :aria-label="heading">
    <!-- Header -->
    <div class="flex items-center gap-2">
      <span class="text-xs font-semibold text-stone-600">{{ heading }}</span>
      <span v-if="pinned" class="text-[9.5px] font-bold uppercase tracking-[.08em] text-orange-700">Pinned</span>
      <span class="flex-1" />
      <UIcon v-if="saving" name="i-heroicons-arrow-path" class="size-3.5 animate-spin text-stone-300" />
      <UDropdownMenu v-if="state === 'planned' || state === 'rest'" :items="zoneItems" :content="{ align: 'end' }" :ui="{ content: 'w-44' }">
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-md border px-1.5 text-xs font-semibold"
          :class="[zoneClass(headerZone), touch ? 'h-8' : 'h-6']"
          :aria-label="`Workout type: ${zoneLabel(headerZone)}. Change`"
        >
          <ZoneIcon :type="headerZone" class="size-3.5 text-xs" />
          {{ zoneLabel(headerZone) }}
          <UIcon name="i-heroicons-chevron-down" class="size-3" />
        </button>
      </UDropdownMenu>
      <span
        v-else
        class="inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs font-semibold"
        :class="zoneClass(dayZone(day))"
      >
        <ZoneIcon :type="dayZone(day)" class="size-3.5 text-xs" />
        {{ zoneLabel(dayZone(day)) }}
      </span>
    </div>

    <!-- Ridden -->
    <template v-if="state === 'ridden' && ride">
      <div class="flex flex-col gap-2">
        <button
          v-if="ride.hasFitData"
          type="button"
          class="self-start text-left text-base font-bold text-stone-900 underline decoration-stone-300 decoration-1 underline-offset-4 hover:decoration-stone-500"
          @click="act({ type: 'open-fit', day })"
        >
          {{ rideLabel(ride.name) }}
        </button>
        <p v-else class="text-base font-bold text-stone-900">{{ rideLabel(ride.name) }}</p>
        <p class="text-[13px] text-stone-600 tabular">
          {{ formatMinutes(ride.durationMinutes) }}<template v-if="ride.distanceKm != null"> · {{ ride.distanceKm.toFixed(1) }} km</template>
        </p>
        <div class="flex flex-wrap gap-1.5">
          <span class="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-600 tabular">
            <FlameIcon class="size-3" />{{ ride.tss }} TSS<template v-if="plan?.tss != null && plan.tss !== ride.tss"> of {{ plan.tss }}</template>
          </span>
          <span v-if="ride.rpe" class="inline-flex items-center gap-1 rounded-full border border-[#FBCFE8] bg-[#FDF2F8] px-2 py-0.5 text-xs font-semibold text-[#BE185D] tabular">
            <UIcon name="i-heroicons-heart" class="size-3" />RPE {{ ride.rpe }}/10
          </span>
          <span v-if="ride.powerBests.length" class="inline-flex items-center gap-1 rounded-full border border-[#D0DFB4] bg-[#F3F7EA] px-2 py-0.5 text-xs font-semibold text-[#3F6212] tabular">
            ★ {{ ride.powerBests.length }} power best{{ ride.powerBests.length === 1 ? '' : 's' }}
          </span>
          <span v-if="ride.ftpWatts" class="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-xs font-semibold text-violet-600">
            <UIcon name="i-heroicons-bolt" class="size-3" />{{ ride.ftpWatts }}W FTP
          </span>
        </div>
        <p v-if="ride.notes" class="whitespace-pre-line rounded-lg bg-stone-50 px-2.5 py-2 text-[13px] text-stone-700">{{ ride.notes }}</p>
        <p v-if="plan && hasContent(plan) && (plan.name !== ride.name || plan.tss !== ride.tss)" class="text-xs text-stone-500">
          Planned <span class="text-stone-700">{{ [plan.name, plan.tss != null && `${plan.tss} TSS`, plan.durationMinutes != null && `${plan.durationMinutes} min`].filter(Boolean).join(' · ') }}</span>
        </p>
      </div>
    </template>

    <!-- Planned: editable fields -->
    <template v-else-if="state === 'planned'">
      <div class="flex flex-col gap-2">
        <label class="flex flex-col gap-1">
          <span class="text-[10px] font-semibold uppercase tracking-[.08em] text-stone-500">Workout name</span>
          <input
            ref="nameInput"
            v-model="buffer.name"
            type="text"
            placeholder="Workout name"
            :class="inputClass"
            @blur="saveFields"
            @keydown.enter="($event.target as HTMLInputElement).blur()"
          >
        </label>
        <div class="grid grid-cols-2 gap-2">
          <label class="flex flex-col gap-1">
            <span class="text-[10px] font-semibold uppercase tracking-[.08em] text-stone-500">TSS</span>
            <input v-model="buffer.tss" type="number" inputmode="numeric" min="0" max="999" placeholder="—" class="no-spinner tabular" :class="inputClass" @blur="saveFields" @keydown.enter="($event.target as HTMLInputElement).blur()">
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[10px] font-semibold uppercase tracking-[.08em] text-stone-500">Min</span>
            <input v-model="buffer.minutes" type="number" inputmode="numeric" min="0" max="999" placeholder="—" class="no-spinner tabular" :class="inputClass" @blur="saveFields" @keydown.enter="($event.target as HTMLInputElement).blur()">
          </label>
        </div>
        <p v-if="plan?.notes" class="line-clamp-6 whitespace-pre-line rounded-lg bg-amber-50 px-2.5 py-2 text-[13px] text-stone-700">{{ plan.notes }}</p>
      </div>
    </template>

    <!-- Missed -->
    <template v-else-if="state === 'missed' && plan">
      <div class="flex flex-col gap-1.5">
        <p class="text-sm font-semibold text-stone-800"><span class="text-[10.5px] font-bold uppercase tracking-[.06em] text-rose-600">Missed</span> · {{ plan.name || zoneLabel(plan.type) }}</p>
        <p class="text-[13px] text-stone-600 tabular">
          <span class="line-through">{{ plan.tss ?? 0 }} TSS</span><template v-if="plan.durationMinutes"> · {{ formatMinutes(plan.durationMinutes) }}</template>
        </p>
        <p v-if="plan.notes" class="line-clamp-6 whitespace-pre-line rounded-lg bg-amber-50 px-2.5 py-2 text-[13px] text-stone-700">{{ plan.notes }}</p>
      </div>
    </template>

    <!-- Rest -->
    <p v-else class="text-sm italic text-stone-500">Rest day</p>

    <!-- Form row -->
    <div class="flex items-center gap-2 border-t border-stone-100 pt-2.5">
      <span class="text-[11px] text-stone-500">{{ isProjection ? 'Projected form' : 'Form after this day' }}</span>
      <span class="flex-1" />
      <span class="rounded-[5px] bg-stone-100 px-1.5 py-0.5 text-xs font-semibold text-stone-600 tabular" :style="isProjection ? ctlHeat(metrics.ctl, training.summary.today.ctl) : undefined">CTL {{ metrics.ctl.toFixed(1) }}</span>
      <span class="rounded-[5px] bg-stone-100 px-1.5 py-0.5 text-xs font-semibold text-stone-600 tabular" :style="isProjection ? tsbHeat(metrics.tsb) : undefined">TSB {{ formatSigned(metrics.tsb) }}</span>
    </div>

    <!-- Actions -->
    <div v-if="state === 'planned'" class="flex flex-col gap-2.5">
      <div class="grid grid-cols-2 gap-2">
        <button
          type="button"
          class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-sky-200 bg-white font-semibold text-sky-700 hover:bg-sky-50 disabled:opacity-60"
          :class="primaryHeight"
          :disabled="fuellingLoading"
          @click="actAfterSave({ type: 'fuelling', date: day.date })"
        >
          <UIcon v-if="fuellingLoading" name="i-heroicons-arrow-path" class="size-3.5 animate-spin" />
          <FlameIcon v-else class="size-3.5" />
          Fuelling
        </button>
        <button
          type="button"
          class="inline-flex items-center justify-center gap-1.5 rounded-lg bg-orange-600 font-semibold text-white hover:bg-orange-700"
          :class="primaryHeight"
          @click="actAfterSave({ type: 'build-workout', date: day.date })"
        >
          <IntervalsIcon class="size-3.5" />
          Build workout
        </button>
      </div>
      <div :class="linksLayout">
        <button type="button" :class="linkClass" @click="actAfterSave({ type: 'mark-completed', date: day.date })">Mark as completed</button>
        <button type="button" :class="linkClass" @click="act({ type: 'add-workout', date: day.date })">Add workout</button>
        <button type="button" :class="linkClass" @click="actAfterSave({ type: 'edit-note', date: day.date })">{{ plan?.notes ? 'Edit note' : 'Add note' }}</button>
        <UDropdownMenu v-if="touch" :items="moveItems" :ui="{ content: 'max-h-64 w-64' }">
          <button type="button" :class="linkClass">Move to…</button>
        </UDropdownMenu>
        <button type="button" :class="dangerClass" @click="training.clearPlan(day.date)">Clear</button>
      </div>
    </div>

    <div v-else-if="state === 'missed'" :class="linksLayout">
      <button type="button" :class="linkClass" @click="act({ type: 'add-workout', date: day.date })">Add workout</button>
      <UDropdownMenu :items="moveItems" :ui="{ content: 'max-h-64 w-64' }">
        <button type="button" :class="linkClass">Move to…</button>
      </UDropdownMenu>
      <button type="button" :class="dangerClass" @click="training.clearPlan(day.date)">Clear</button>
    </div>

    <div v-else-if="state === 'ridden' && ride" :class="linksLayout">
      <template v-if="confirmingDelete">
        <span class="text-[12.5px] text-stone-600">Delete this workout?</span>
        <button type="button" class="text-[12.5px] font-semibold text-rose-600" @click="act({ type: 'delete-ride', day })">Confirm</button>
        <button type="button" class="text-[12.5px] text-stone-500" @click="confirmingDelete = false">Cancel</button>
      </template>
      <template v-else>
        <button type="button" :class="linkClass" @click="act({ type: 'edit', day })">Edit</button>
        <button type="button" :class="linkClass" @click="act({ type: 'reupload-fit', day })">Re-upload FIT</button>
        <button
          v-if="isOutdoorRide"
          type="button"
          :class="linkClass"
          :disabled="refreshingRideId === ride.id"
          @click="act({ type: 'refresh-ride', day })"
        >
          {{ refreshingRideId === ride.id ? 'Refreshing…' : 'Refresh from Wahoo' }}
        </button>
        <button v-if="isOutdoorRide && ride.stravaActivityId" type="button" :class="linkClass" @click="navigateTo(`/overlay/${ride.stravaActivityId}`)">Photo overlay</button>
        <button type="button" :class="dangerClass" @click="confirmingDelete = true">Delete</button>
      </template>
    </div>

    <div v-else :class="linksLayout">
      <button type="button" :class="linkClass" @click="act({ type: 'add-workout', date: day.date })">Add workout</button>
      <button type="button" :class="linkClass" @click="planSession">Plan a session</button>
    </div>
  </div>
</template>
