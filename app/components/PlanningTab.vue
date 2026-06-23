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
}

// ── Projection chart ─────────────────────────────────────────────────────────

const chartWidth = 600
const chartHeight = 160
const padLeft = 36
const padRight = 8
const padTop = 12
const padBottom = 28

const chartData = computed(() => {
  const days = planning.plans
  if (days.length === 0) return null

  const ctlValues = days.map(d => d.projectedCtl)
  const tsbValues = days.map(d => d.projectedTsb)

  const allValues = [...ctlValues, ...tsbValues]
  const minVal = Math.floor(Math.min(...allValues) - 5)
  const maxVal = Math.ceil(Math.max(...allValues) + 5)
  const range = maxVal - minVal || 1

  const innerW = chartWidth - padLeft - padRight
  const innerH = chartHeight - padTop - padBottom

  function x(i: number) { return padLeft + (i / (days.length - 1)) * innerW }
  function y(v: number) { return padTop + (1 - (v - minVal) / range) * innerH }

  const ctlPath = ctlValues.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const tsbPath = tsbValues.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')

  // Y-axis ticks
  const tickCount = 5
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const val = minVal + (range / (tickCount - 1)) * i
    return { val: Math.round(val), y: y(val) }
  })

  // Zero line for TSB
  const zeroY = y(0)
  const showZero = minVal < 0 && maxVal > 0

  // Week separators (every 7 days)
  const weekLines = [7, 14, 21].map(i => x(i))

  // Today marker
  const todayStr = new Date().toISOString().slice(0, 10)
  const todayIdx = days.findIndex(d => d.date === todayStr)

  return { ctlPath, tsbPath, ticks, showZero, zeroY, weekLines, todayIdx, todayX: todayIdx >= 0 ? x(todayIdx) : null }
})
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
          <span class="text-[10px] font-medium uppercase tracking-widest text-stone-400">
            Week of {{ weekLabel(week.monday) }}
          </span>
          <div class="flex items-center gap-2">
            <span class="text-[10px] uppercase tracking-widest text-stone-400">TSS</span>
            <span class="text-sm font-medium tabular text-stone-700 min-w-[2.5rem] text-right">
              {{ weekTss(week.days) }}
            </span>
          </div>
        </div>

        <!-- Day rows -->
        <div class="divide-y divide-stone-50">
          <div
            v-for="day in week.days"
            :key="day.date"
            :class="[
              'flex items-center gap-3 px-4 py-2.5',
              day.isPast ? 'opacity-50' : '',
            ]"
          >
            <!-- Date label -->
            <span class="w-16 shrink-0 text-xs text-stone-500 tabular">
              {{ formatDate(day.date) }}
            </span>

            <!-- Zone badge (click to cycle) -->
            <button
              class="shrink-0 w-8 h-6 rounded border text-[10px] font-semibold uppercase tracking-wide transition-colors cursor-pointer"
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
              class="flex-1 min-w-0 text-xs text-stone-700 placeholder-stone-300 bg-transparent border-0 outline-none focus:bg-stone-50 rounded px-1.5 py-1 -mx-1.5 transition-colors disabled:cursor-default"
              @blur="save(day.date)"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
            >

            <!-- TSS -->
            <div class="flex items-center gap-1 shrink-0">
              <input
                v-model.number="getDraft(day.date).tss"
                type="number"
                min="0"
                max="999"
                placeholder="—"
                :disabled="day.isPast"
                class="w-16 text-xs text-right text-stone-700 placeholder-stone-300 bg-transparent border-0 outline-none focus:bg-stone-50 rounded px-1 py-1 -mx-1 tabular transition-colors disabled:cursor-default"
                @blur="save(day.date)"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
              >
              <span class="text-[10px] text-stone-300">TSS</span>
            </div>

            <!-- Duration -->
            <div class="flex items-center gap-1 shrink-0">
              <input
                v-model.number="getDraft(day.date).durationMinutes"
                type="number"
                min="0"
                max="999"
                placeholder="—"
                :disabled="day.isPast"
                class="w-14 text-xs text-right text-stone-700 placeholder-stone-300 bg-transparent border-0 outline-none focus:bg-stone-50 rounded px-1 py-1 -mx-1 tabular transition-colors disabled:cursor-default"
                @blur="save(day.date)"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
              >
              <span class="text-[10px] text-stone-300">min</span>
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

      <!-- ── Projection chart ─────────────────────────────────────────────── -->
      <div class="bg-white rounded-xl border border-stone-100 p-4">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-[10px] font-medium uppercase tracking-widest text-stone-400">
            Projected fitness &amp; form
          </h3>
          <div class="flex items-center gap-4 text-[10px] text-stone-400">
            <span class="flex items-center gap-1.5">
              <span class="inline-block w-3 h-0.5 bg-sky-400 rounded" />
              CTL (fitness)
            </span>
            <span class="flex items-center gap-1.5">
              <span class="inline-block w-3 h-0.5 bg-amber-400 rounded" />
              TSB (form)
            </span>
          </div>
        </div>

        <div v-if="chartData" class="w-full overflow-x-auto">
          <svg
            :viewBox="`0 0 ${chartWidth} ${chartHeight}`"
            class="w-full"
            :style="`min-width: 320px; height: ${chartHeight}px`"
            aria-label="Projected CTL and TSB over 4 weeks"
          >
            <!-- Week separator lines -->
            <line
              v-for="lx in chartData.weekLines"
              :key="lx"
              :x1="lx"
              :x2="lx"
              :y1="padTop"
              :y2="chartHeight - padBottom"
              stroke="#e7e5e4"
              stroke-width="1"
              stroke-dasharray="3,3"
            />

            <!-- Zero line -->
            <line
              v-if="chartData.showZero"
              :x1="padLeft"
              :x2="chartWidth - padRight"
              :y1="chartData.zeroY"
              :y2="chartData.zeroY"
              stroke="#d6d3d1"
              stroke-width="1"
            />

            <!-- Y-axis ticks + labels -->
            <g v-for="tick in chartData.ticks" :key="tick.val">
              <line
                :x1="padLeft - 4"
                :x2="padLeft"
                :y1="tick.y"
                :y2="tick.y"
                stroke="#d6d3d1"
                stroke-width="1"
              />
              <text
                :x="padLeft - 6"
                :y="tick.y + 4"
                text-anchor="end"
                font-size="9"
                fill="#a8a29e"
                font-family="Inter, sans-serif"
              >
                {{ tick.val }}
              </text>
            </g>

            <!-- TSB line (amber) -->
            <path
              :d="chartData.tsbPath"
              fill="none"
              stroke="#fbbf24"
              stroke-width="1.5"
              stroke-linejoin="round"
              stroke-linecap="round"
            />

            <!-- CTL line (sky) -->
            <path
              :d="chartData.ctlPath"
              fill="none"
              stroke="#38bdf8"
              stroke-width="1.5"
              stroke-linejoin="round"
              stroke-linecap="round"
            />

            <!-- Today marker -->
            <line
              v-if="chartData.todayX !== null"
              :x1="chartData.todayX"
              :x2="chartData.todayX"
              :y1="padTop"
              :y2="chartHeight - padBottom"
              stroke="#0ea5e9"
              stroke-width="1"
              stroke-dasharray="4,2"
            />

            <!-- Week labels on x-axis -->
            <text
              v-for="(week, wi) in weeks"
              :key="wi"
              :x="padLeft + (wi * 7 / 27) * (chartWidth - padLeft - padRight) + (wi === 0 ? 0 : -4)"
              :y="chartHeight - 6"
              font-size="9"
              :text-anchor="wi === 0 ? 'start' : 'middle'"
              fill="#a8a29e"
              font-family="Inter, sans-serif"
            >
              {{ weekLabel(week.monday) }}
            </text>
          </svg>
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
