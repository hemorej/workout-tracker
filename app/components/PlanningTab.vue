<script setup lang="ts">
import { usePlanningStore } from '~/stores/planning'
import type { PlanEntry } from '~/stores/planning'

const planning = usePlanningStore()

onMounted(() => planning.fetchPlans())

// ── Zone config ──────────────────────────────────────────────────────────────

const ZONES = [
  { value: 'zone2', label: 'Z2', color: 'sky' },
  { value: 'zone4', label: 'Z4', color: 'yellow' },
  { value: 'zone5', label: 'Z5', color: 'orange' },
  { value: 'zone6', label: 'Z6', color: 'red' },
  { value: 'rest', label: 'REST', color: 'pink' },
]

const ZONE_CLASSES: Record<string, string> = {
  zone2: 'bg-sky-100 text-sky-700 border-sky-200',
  zone4: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  zone5: 'bg-orange-100 text-orange-700 border-orange-200',
  zone6: 'bg-red-100 text-red-700 border-red-200',
  rest: 'bg-pink-100 text-pink-600 border-pink-200',
  '': 'bg-stone-100 text-stone-500 border-stone-200',
}

function zoneClass(type: string | null) {
  return ZONE_CLASSES[type ?? ''] ?? ZONE_CLASSES['']
}

// ── Date formatting ──────────────────────────────────────────────────────────

function formatDate(dateStr: string) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })
  const num = d.getUTCDate()
  const suffix = ['th', 'st', 'nd', 'rd'][num % 10 > 3 ? 0 : (num % 100 - 20 < 0 ? num % 100 : num % 10)] ?? 'th'
  return `${day} ${num}${suffix}`
}

function weekLabel(mondayDate: string) {
  const d = new Date(`${mondayDate}T00:00:00Z`)
  return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// ── Weeks grouping ───────────────────────────────────────────────────────────

const weeks = computed(() => {
  const days = planning.plans
  const result: { monday: string, days: typeof days }[] = []
  for (let i = 0; i < days.length; i += 7) {
    result.push({ monday: days[i]!.date, days: days.slice(i, i + 7) })
  }
  return result
})

function weekTss(days: typeof planning.plans) {
  return days.reduce((sum, d) => sum + (d.plan?.tss ?? 0), 0)
}

function weekHours(days: typeof planning.plans) {
  const mins = days.reduce((sum, d) => sum + (d.plan?.durationMinutes ?? 0), 0)
  if (!mins) return null
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

// ── Inline editing ───────────────────────────────────────────────────────────

// Per-date draft state (only for dates being edited)
const drafts = reactive<Record<string, PlanEntry>>({})
const saving = reactive<Record<string, boolean>>({})

function getDraft(date: string): PlanEntry {
  if (!drafts[date]) {
    const plan = planning.plans.find(d => d.date === date)?.plan
    drafts[date] = {
      name: plan?.name ?? null,
      type: plan?.type ?? null,
      tss: plan?.tss ?? null,
      durationMinutes: plan?.durationMinutes ?? null,
    }
  }
  return drafts[date]!
}

function isDirty(date: string) {
  const original = planning.plans.find(d => d.date === date)?.plan
  const draft = drafts[date]
  if (!draft) return false
  return (
    draft.name !== (original?.name ?? null)
    || draft.type !== (original?.type ?? null)
    || draft.tss !== (original?.tss ?? null)
    || draft.durationMinutes !== (original?.durationMinutes ?? null)
  )
}

async function save(date: string) {
  if (!isDirty(date)) return
  saving[date] = true
  try {
    await planning.savePlan(date, drafts[date]!)
    // Don't delete the draft — keeping the same reactive object prevents the
    // input from remounting and stealing/losing focus on blur.
  }
  finally {
    saving[date] = false
  }
}

function cycleType(date: string) {
  const draft = getDraft(date)
  const zones = [null, 'zone2', 'zone4', 'zone5', 'zone6', 'rest']
  const idx = zones.indexOf(draft.type)
  draft.type = zones[(idx + 1) % zones.length] ?? null
  save(date)
}

// ── Swap with day above ──────────────────────────────────────────────────────
// Swaps the workout content (name/type/tss/duration) with the previous row,
// keeping each row's own date fixed. Projections are recomputed via savePlan.

function canSwapUp(date: string) {
  const idx = planning.plans.findIndex(d => d.date === date)
  if (idx <= 0) return false
  return !planning.plans[idx]!.isPast && !planning.plans[idx - 1]!.isPast
}

async function swapWithAbove(date: string) {
  const idx = planning.plans.findIndex(d => d.date === date)
  if (idx <= 0) return
  const day = planning.plans[idx]!
  const aboveDay = planning.plans[idx - 1]!
  if (day.isPast || aboveDay.isPast) return

  const current = getDraft(date)
  const above = getDraft(aboveDay.date)
  const temp = { ...current }
  current.name = above.name
  current.type = above.type
  current.tss = above.tss
  current.durationMinutes = above.durationMinutes
  above.name = temp.name
  above.type = temp.type
  above.tss = temp.tss
  above.durationMinutes = temp.durationMinutes

  saving[date] = true
  saving[aboveDay.date] = true
  try {
    await Promise.all([
      planning.savePlan(date, { ...current }),
      planning.savePlan(aboveDay.date, { ...above }),
    ])
  }
  finally {
    saving[date] = false
    saving[aboveDay.date] = false
  }
}

// ── Live projections ─────────────────────────────────────────────────────────
// Recomputes CTL/TSB for every future day using draft TSS values so the
// numbers update as the user types, before the field is saved.

const CTL_DECAY = 2 / 43
const ATL_DECAY = 2 / 8

const liveProjections = computed(() => {
  let ctl = planning.currentCtl
  let atl = planning.currentAtl
  const result: Record<string, { ctl: number, tsb: number }> = {}

  for (const day of planning.plans) {
    if (day.isPast) {
      result[day.date] = { ctl: day.projectedCtl, tsb: day.projectedTsb }
      ctl = day.projectedCtl
      atl = day.projectedCtl - day.projectedTsb
    }
    else {
      const tss = drafts[day.date]?.tss ?? day.plan?.tss ?? 0
      ctl = tss * CTL_DECAY + ctl * (1 - CTL_DECAY)
      atl = tss * ATL_DECAY + atl * (1 - ATL_DECAY)
      result[day.date] = {
        ctl: Math.round(ctl * 10) / 10,
        tsb: Math.round((ctl - atl) * 10) / 10,
      }
    }
  }
  return result
})

function tsbColor(tsb: number) {
  if (tsb > 25) return 'text-sky-400'
  if (tsb > 10) return 'text-emerald-400'
  if (tsb > -10) return 'text-stone-400'
  if (tsb > -30) return 'text-amber-400'
  return 'text-rose-400'
}
</script>

<template>
  <div class="space-y-8">

    <!-- Loading -->
    <div v-if="planning.isLoading" class="flex justify-center py-16">
      <UIcon name="i-heroicons-arrow-path" class="animate-spin text-stone-300 text-2xl" />
    </div>

    <template v-else-if="weeks.length">

      <!-- ── 4 weeks ──────────────────────────────────────────────────────── -->
      <div
        v-for="week in weeks"
        :key="week.monday"
        class="bg-white rounded-xl border border-stone-100 overflow-hidden"
      >
        <!-- Week header -->
        <div class="flex items-center justify-between px-4 py-2.5 bg-stone-50 border-b border-stone-100">
          <span class="text-xs font-semibold uppercase tracking-widest text-stone-400">
            Week of {{ weekLabel(week.monday) }}
          </span>
          <div class="flex items-center gap-4">
            <div v-if="weekHours(week.days)" class="flex items-center gap-2">
              <span class="text-base font-semibold tabular text-stone-700 min-w-[2.5rem] text-right">
                {{ weekHours(week.days) }}
              </span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs uppercase tracking-widest text-stone-400">TSS</span>
              <span class="text-base font-semibold tabular text-stone-700 min-w-[2.5rem] text-right">
                {{ weekTss(week.days) }}
              </span>
            </div>
          </div>
        </div>

        <!-- Day rows -->
        <div class="divide-y divide-stone-50">
          <div
            v-for="day in week.days"
            :key="day.date"
            :class="[
              'group flex items-center gap-3 px-4 py-2.5',
              day.isPast ? 'opacity-50' : '',
            ]"
          >
            <!-- Date label -->
            <span class="w-16 shrink-0 text-sm text-stone-500 tabular">
              {{ formatDate(day.date) }}
            </span>

            <!-- Zone badge (click to cycle) -->
            <button
              class="shrink-0 w-9 h-7 rounded-md border text-xs font-bold uppercase tracking-wide transition-colors cursor-pointer"
              :class="zoneClass(getDraft(day.date).type)"
              :disabled="day.isPast"
              :title="getDraft(day.date).type ?? 'No zone — click to set'"
              @click="!day.isPast && cycleType(day.date)"
            >
              {{ getDraft(day.date).type ? ZONES.find(z => z.value === getDraft(day.date).type)?.label : '·' }}
            </button>

            <!-- Workout name -->
            <input
              v-model="getDraft(day.date).name"
              type="text"
              placeholder="Workout name"
              :disabled="day.isPast"
              class="flex-1 min-w-0 text-sm text-stone-700 placeholder-stone-300 bg-transparent border-0 outline-none focus:bg-stone-50 rounded px-1.5 py-1 -mx-1.5 transition-colors disabled:cursor-default"
              @blur="save(day.date)"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
            >

            <!-- Swap with day above -->
            <button
              v-if="canSwapUp(day.date)"
              type="button"
              class="shrink-0 w-5 h-5 flex items-center justify-center rounded text-stone-300 opacity-0 group-hover:opacity-100 hover:text-stone-500 hover:bg-stone-50 transition-colors cursor-pointer"
              title="Swap with day above"
              @click="swapWithAbove(day.date)"
            >
              <UIcon name="i-heroicons-arrows-up-down" class="w-3.5 h-3.5" />
            </button>
            <div v-else class="w-5 shrink-0" />

            <!-- TSS -->
            <div class="flex items-center gap-1 shrink-0">
              <input
                v-model.number="getDraft(day.date).tss"
                type="number"
                inputmode="numeric"
                min="0"
                max="999"
                placeholder="—"
                :disabled="day.isPast"
                class="w-16 text-sm text-right text-stone-700 placeholder-stone-300 bg-transparent border-0 outline-none focus:bg-stone-50 rounded px-1 py-1 -mx-1 tabular transition-colors disabled:cursor-default"
                @blur="save(day.date)"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
              >
              <span class="text-xs text-stone-300">TSS</span>
            </div>

            <!-- Duration -->
            <div class="flex items-center gap-1 shrink-0">
              <input
                v-model.number="getDraft(day.date).durationMinutes"
                type="number"
                inputmode="numeric"
                min="0"
                max="999"
                placeholder="—"
                :disabled="day.isPast"
                class="w-14 text-sm text-right text-stone-700 placeholder-stone-300 bg-transparent border-0 outline-none focus:bg-stone-50 rounded px-1 py-1 -mx-1 tabular transition-colors disabled:cursor-default"
                @blur="save(day.date)"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
              >
              <span class="text-xs text-stone-300">min</span>
            </div>

            <!-- Projected CTL -->
            <div class="flex items-center gap-1 shrink-0">
              <span class="text-xs text-stone-300">CTL</span>
              <span class="w-10 text-sm text-right tabular text-stone-500">
                {{ liveProjections[day.date]?.ctl ?? '—' }}
              </span>
            </div>

            <!-- Projected TSB -->
            <div class="flex items-center gap-1 shrink-0">
              <span class="text-xs text-stone-300">TSB</span>
              <span
                class="w-10 text-sm text-right tabular"
                :class="liveProjections[day.date] ? tsbColor(liveProjections[day.date]!.tsb) : 'text-stone-300'"
              >
                {{ liveProjections[day.date]?.tsb ?? '—' }}
              </span>
            </div>

            <!-- Save indicator -->
            <div class="w-4 shrink-0 flex justify-center">
              <UIcon
                v-if="saving[day.date]"
                name="i-heroicons-arrow-path"
                class="animate-spin text-stone-300 w-3 h-3"
              />
            </div>
          </div>
        </div>
      </div>

    </template>

    <!-- Empty state (no history yet to seed projection) -->
    <div v-else-if="!planning.isLoading" class="text-center py-20">
      <p class="text-stone-300 text-4xl mb-4">○</p>
      <p class="text-sm font-medium text-stone-500">No training history yet</p>
      <p class="text-xs text-stone-400 mt-1.5">Log some workouts first to enable planning.</p>
    </div>

  </div>
</template>
