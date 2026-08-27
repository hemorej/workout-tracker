<script setup lang="ts">
/**
 * WorkoutFitOverlay — small "brief ride stats" popup shown when clicking a
 * logged workout's title in the training log, for workouts that have a
 * parsed FIT file's extra stats (`workout.fitData`) attached.
 *
 * Self-contained (owns its own Teleport + v-if), unlike AddWorkoutModal
 * (whose Teleport wrapper lives in the parent) — there's no shared open
 * state to coordinate here, just "show when a workout is passed in".
 *
 * Everything shown comes straight off the WorkoutDetail already loaded by
 * the training log list — no extra fetch.
 */

import type { WorkoutDetail } from '~/stores/workouts'

const props = defineProps<{
  /** The workout to show stats for. Overlay is visible whenever this is non-null. */
  workout: WorkoutDetail | null
}>()

const emit = defineEmits<{
  close: []
}>()

const POWER_BEST_DURATIONS = [
  '5sec', '15sec', '30sec', '1min', '2min', '3min', '5min',
  '8min', '10min', '15min', '20min', '30min', '45min', '1h',
] as const

const sortedPowerBests = computed(() => {
  const bests = props.workout?.powerBests ?? []
  const order = new Map(POWER_BEST_DURATIONS.map((d, i) => [d, i]))
  return [...bests].sort((a, b) => (order.get(a.duration as typeof POWER_BEST_DURATIONS[number]) ?? 99) - (order.get(b.duration as typeof POWER_BEST_DURATIONS[number]) ?? 99))
})

const durationDisplay = computed(() => {
  const mins = props.workout?.durationMinutes ?? 0
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
})

const distanceDisplay = computed(() => {
  const km = props.workout?.distanceKm
  return km != null ? `${km.toFixed(1)} km` : null
})

/** Only worth a "Laps" page when there are at least 2 splits — a single lap covering the whole ride isn't worth its own view. */
const hasLaps = computed(() => (props.workout?.laps?.length ?? 0) >= 2)

/**
 * Warm zone ramp for the Power tab's time-in-zone block, ordered Z1→Z6 so
 * darkness reads as intensity. Names/order mirror `ZONES` in
 * WorkoutBuilderTab.vue; the seconds are bucketed server-side against the
 * same thresholds (see computeZoneBuckets in server/utils/fit.ts).
 * Deliberately not the builder's categorical rainbow — see
 * design_handoff_time_in_zone/README.md.
 */
const ZONE_RAMP = [
  { label: 'Z1', name: 'Recovery', pctRange: '<55%', loPct: 0, hiPct: 0.55, midpoint: 0.45, color: '#d6d3d1' },
  { label: 'Z2', name: 'Endurance', pctRange: '55–75%', loPct: 0.55, hiPct: 0.75, midpoint: 0.65, color: '#fed7aa' },
  { label: 'Z3', name: 'Tempo', pctRange: '75–90%', loPct: 0.75, hiPct: 0.90, midpoint: 0.825, color: '#fdba74' },
  { label: 'Z4', name: 'Threshold', pctRange: '90–105%', loPct: 0.90, hiPct: 1.05, midpoint: 0.975, color: '#fb923c' },
  { label: 'Z5', name: 'VO2 max', pctRange: '105–120%', loPct: 1.05, hiPct: 1.20, midpoint: 1.125, color: '#f97316' },
  { label: 'Z6', name: 'Anaerobic', pctRange: '120%+', loPct: 1.20, hiPct: Infinity, midpoint: 1.30, color: '#ea580c' },
] as const

/** Watt band for a zone at the given FTP, e.g. "127–173 W". Falls back to the %FTP text while FTP is still loading. */
function zoneWattRange(z: typeof ZONE_RAMP[number], ftp: number | null): string {
  if (!ftp) return `${z.pctRange} FTP`
  const lo = Math.round(z.loPct * ftp)
  const hi = Math.round(z.hiPct * ftp)
  if (z.loPct === 0) return `< ${hi} W`
  if (!Number.isFinite(z.hiPct)) return `${lo}+ W`
  return `${lo}–${hi} W`
}

/** Per-zone seconds from the parsed FIT file. Absent on rides parsed before this existed, or with no power stream / no ride-time FTP. */
const zoneBuckets = computed<number[] | null>(() => {
  const b = props.workout?.fitData?.zoneBuckets
  return Array.isArray(b) && b.length === 6 ? b : null
})

/** Power tab only exists when there's a usable zone breakdown. */
const hasPower = computed(() => !!zoneBuckets.value && zoneBuckets.value.some((s) => s > 0))

/**
 * Current FTP (most recent logged `ftp_watts`, or the 230 fallback), used
 * only to render each zone's watt band. Fetched lazily the first time a
 * power-capable overlay opens rather than on dashboard load.
 */
const { data: ftpData, execute: loadFtp } = useFetch<{ currentFtp: number }>('/api/ftp/current', {
  immediate: false,
  server: false,
})
const currentFtp = computed(() => ftpData.value?.currentFtp ?? null)
watch(
  () => hasPower.value && !!props.workout,
  (need) => { if (need && ftpData.value == null) loadFtp() },
  { immediate: true },
)

/** < 60 min → M:SS; ≥ 60 min → Hh Mm. Matches the design's `fmt`. */
function zoneTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

const zoneTotalSeconds = computed(() => (zoneBuckets.value ?? []).reduce((s, v) => s + v, 0))

/** Coarser h/m form for the "… total" label beside the section head. */
const zoneTotalDisplay = computed(() => {
  const totalMin = Math.round(zoneTotalSeconds.value / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h === 0 ? `${m}m` : `${h}h ${m}m`
})

/** Per-zone display values. Row bar widths are relative to the biggest zone so short zones stay legible. */
const zoneRows = computed(() => {
  const buckets = zoneBuckets.value ?? [0, 0, 0, 0, 0, 0]
  const total = zoneTotalSeconds.value || 1
  const largest = Math.max(1, ...buckets)
  return ZONE_RAMP.map((z, i) => {
    const seconds = buckets[i] ?? 0
    return {
      ...z,
      seconds,
      time: zoneTime(seconds),
      watts: zoneWattRange(z, currentFtp.value),
      pct: Math.round((seconds / total) * 100),
      bar: Math.round((seconds / largest) * 100),
    }
  })
})

/**
 * The zone that carried the session. Not a raw seconds count — that would
 * let a long easy recovery outweigh the hard work it was resting between —
 * but weighted by training load: seconds × intensity², intensity being the
 * zone's midpoint %FTP, the same quadratic shape as the NP/TSS model. So
 * e.g. 25 min of threshold intervals beats 35 min of scattered recovery.
 * Ties resolve to the lower zone (strict `>`, scanning Z1→Z6).
 */
const dominantZone = computed(() => {
  const rows = zoneRows.value
  let best = rows[0]!
  let bestLoad = -1
  for (const z of rows) {
    const load = z.seconds * z.midpoint * z.midpoint
    if (load > bestLoad) {
      bestLoad = load
      best = z
    }
  }
  return best
})

const page = ref<'summary' | 'power' | 'laps'>('summary')
watch(() => props.workout, () => { page.value = 'summary' })

/** Falls back to Summary if the selected tab doesn't apply to the current workout. */
const activePage = computed(() => {
  if (page.value === 'power' && !hasPower.value) return 'summary'
  if (page.value === 'laps' && !hasLaps.value) return 'summary'
  return page.value
})

const tabCount = computed(() => 1 + (hasPower.value ? 1 : 0) + (hasLaps.value ? 1 : 0))

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.workout) emit('close')
}
onMounted(() => window.addEventListener('keydown', handleKeydown))
onUnmounted(() => window.removeEventListener('keydown', handleKeydown))

function lapDurationDisplay(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Scale for the power-breakdown bars: relative to this ride's own range, not
 * to FTP, so small differences between e.g. 179W and 217W are visible.
 */
const bestsScale = computed(() => {
  const ws = sortedPowerBests.value.map(b => b.watts)
  if (!ws.length) return null
  const lo = Math.min(...ws) - 12
  const hi = Math.max(...ws) + 6
  return { lo, hi }
})
function bestPct(watts: number): number {
  const s = bestsScale.value
  if (!s || s.hi === s.lo) return 0
  return Math.round(((watts - s.lo) / (s.hi - s.lo)) * 100)
}

/** Lap effort bar: width vs the ride's peak lap power, colour vs the ride's average power. */
const lapPeak = computed(() => Math.max(1, ...(props.workout?.laps ?? []).map(l => l.avgPower ?? 0)))
function lapPct(w: number | null): number {
  return w == null ? 0 : Math.round((w / (lapPeak.value * 1.05)) * 100)
}
function lapIsWork(w: number | null): boolean {
  const avg = props.workout?.fitData?.avgPower
  return w != null && avg != null && w >= avg
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="workout"
      class="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Ride stats"
    >
      <div
        class="fixed inset-0 bg-black/25 backdrop-blur-sm"
        @click="emit('close')"
      />

      <div class="relative bg-white rounded-2xl shadow-xl w-full max-w-md my-8 overflow-hidden @container">
      <div class="p-4 @[420px]:p-[22px] @[420px]:pb-5">
        <!-- Header row — title/meta only, no action in this row -->
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <h2 class="font-semibold text-stone-900 text-[15.5px] leading-[1.3] @[420px]:text-[17px] @[420px]:leading-[1.25]">
              {{ workout.name }}
            </h2>
            <p class="tabular text-stone-400 mt-1 text-[12.5px] @[420px]:text-[13px]">
              {{ durationDisplay }}<template v-if="distanceDisplay"> · {{ distanceDisplay }}</template><template v-if="activePage === 'laps'"> · {{ workout.laps?.length }} laps</template>
            </p>
          </div>
          <button
            type="button"
            class="flex-none w-[26px] h-[26px] grid place-items-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-600 transition-colors"
            aria-label="Close"
            @click="emit('close')"
          >
            <UIcon name="i-heroicons-x-mark" class="w-[13px] h-[13px]" />
          </button>
        </div>

        <!-- Segmented control — page switch, own row -->
        <div
          v-if="tabCount > 1"
          class="mt-4 mb-[14px] @[420px]:mb-[18px] grid @[420px]:inline-flex bg-stone-100 rounded-[9px] p-[3px]"
          :style="{ gridTemplateColumns: `repeat(${tabCount}, 1fr)` }"
          role="tablist"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="activePage === 'summary'"
            class="rounded-md text-xs py-1.5 px-3.5 transition-colors duration-150"
            :class="activePage === 'summary'
              ? 'bg-white text-stone-900 font-semibold shadow-[0_1px_2px_rgba(28,25,23,.08)]'
              : 'text-stone-500 font-medium hover:text-stone-900'"
            @click="page = 'summary'"
          >
            Summary
          </button>
          <button
            v-if="hasPower"
            type="button"
            role="tab"
            :aria-selected="activePage === 'power'"
            class="rounded-md text-xs py-1.5 px-3.5 transition-colors duration-150"
            :class="activePage === 'power'
              ? 'bg-white text-stone-900 font-semibold shadow-[0_1px_2px_rgba(28,25,23,.08)]'
              : 'text-stone-500 font-medium hover:text-stone-900'"
            @click="page = 'power'"
          >
            Power
          </button>
          <button
            v-if="hasLaps"
            type="button"
            role="tab"
            :aria-selected="activePage === 'laps'"
            class="rounded-md text-xs py-1.5 px-3.5 transition-colors duration-150"
            :class="activePage === 'laps'
              ? 'bg-white text-stone-900 font-semibold shadow-[0_1px_2px_rgba(28,25,23,.08)]'
              : 'text-stone-500 font-medium hover:text-stone-900'"
            @click="page = 'laps'"
          >
            Laps
          </button>
        </div>

        <!-- Laps page -->
        <div v-if="activePage === 'laps'">
          <div
            class="grid gap-1.5 @[420px]:gap-2.5 pl-2 pr-3 pb-1.5 border-b border-stone-200 [grid-template-columns:20px_40px_1fr_46px_1fr_1fr] @[420px]:[grid-template-columns:26px_56px_1fr_64px_1fr_1fr]"
          >
            <span class="text-[9px] @[420px]:text-[10px] font-semibold text-stone-400 uppercase tracking-wide">#</span>
            <span class="text-right text-[9px] @[420px]:text-[10px] font-semibold text-stone-400 uppercase tracking-wide">Time</span>
            <span class="text-right text-[9px] @[420px]:text-[10px] font-semibold text-stone-400 uppercase tracking-wide">Km</span>
            <span class="text-right text-[9px] @[420px]:text-[10px] font-semibold text-stone-400 uppercase tracking-wide">W</span>
            <span class="text-right text-[9px] @[420px]:text-[10px] font-semibold text-stone-400 uppercase tracking-wide">Bpm</span>
            <span class="text-right text-[9px] @[420px]:text-[10px] font-semibold text-stone-400 uppercase tracking-wide">Km/h</span>
          </div>
          <div class="laps-scroll max-h-[440px] @[420px]:max-h-[520px] overflow-y-auto pt-0.5 pr-1.5">
            <div
              v-for="(lap, i) in workout.laps"
              :key="lap.lapNumber"
              class="tabular grid gap-1.5 @[420px]:gap-2.5 items-center rounded-lg py-1.5 @[420px]:py-[7px] pl-2 pr-1.5 [grid-template-columns:20px_40px_1fr_46px_1fr_1fr] @[420px]:[grid-template-columns:26px_56px_1fr_64px_1fr_1fr]"
              :class="i % 2 === 0 ? 'bg-stone-50' : 'bg-white'"
            >
              <span class="text-[11px] @[420px]:text-xs text-stone-300">{{ lap.lapNumber }}</span>
              <span class="text-right text-xs @[420px]:text-[13px] font-medium text-stone-500">{{ lapDurationDisplay(lap.durationSeconds) }}</span>
              <span class="text-right text-xs @[420px]:text-[13px] font-medium text-stone-600">{{ (lap.distanceMeters / 1000).toFixed(2) }}</span>
              <span
                class="flex flex-col items-end gap-1"
                :aria-label="lap.avgPower != null ? `${lap.avgPower} W, ${lapIsWork(lap.avgPower) ? 'above' : 'below'} ride average` : undefined"
              >
                <span class="text-xs @[420px]:text-[13px] font-semibold text-stone-900">{{ lap.avgPower ?? '—' }}</span>
                <span v-if="lap.avgPower != null" class="w-full h-[3px] rounded-full bg-[#eeebe8] relative overflow-hidden" aria-hidden="true">
                  <span
                    class="absolute inset-y-0 left-0 rounded-full"
                    :class="lapIsWork(lap.avgPower) ? 'bg-orange-500' : 'bg-stone-300'"
                    :style="{ width: lapPct(lap.avgPower) + '%' }"
                  />
                </span>
              </span>
              <span class="text-right text-xs @[420px]:text-[13px] font-medium text-stone-600">{{ lap.avgHr ?? '—' }}</span>
              <span class="text-right text-xs @[420px]:text-[13px] font-medium text-stone-600">{{ lap.avgSpeedKph ?? '—' }}</span>
            </div>
          </div>
        </div>

        <!-- Power page -->
        <template v-else-if="activePage === 'power'">
          <!-- Headline — the zone that carried the session (training-load weighted), and time spent in it -->
          <div class="border border-stone-200 rounded-xl px-3.5 py-3">
            <p class="tabular font-semibold text-stone-900 leading-none text-[22px] @[420px]:text-[26px]">
              {{ dominantZone.label }} {{ dominantZone.name }}<span class="font-medium text-stone-400 text-xs @[420px]:text-sm"> · {{ dominantZone.time }}</span>
            </p>
            <p class="font-semibold text-stone-400 uppercase tracking-[.09em] mt-[5px] text-[9.5px] @[420px]:text-[10px]">Dominant zone</p>
          </div>

          <!-- Time in zone -->
          <div class="flex items-baseline justify-between mt-5 mb-1.5">
            <span class="font-semibold text-stone-400 uppercase tracking-[.09em] text-[9.5px] @[420px]:text-[10px]">Time in zone</span>
            <span class="text-[11px] text-stone-300">{{ zoneTotalDisplay }} total</span>
          </div>

          <!-- Zone rows — always Z1→Z6, including zero-time zones. Bars are relative to the biggest zone. -->
          <div class="grid gap-y-px">
            <div
              v-for="z in zoneRows"
              :key="z.label"
              class="grid items-center gap-1.5 @[420px]:gap-2.5 p-1.5 rounded-lg hover:bg-[#faf9f8] [grid-template-columns:20px_92px_1fr_46px_34px] @[420px]:[grid-template-columns:22px_104px_1fr_52px_40px]"
            >
              <span class="font-semibold text-stone-400 text-[11px]">{{ z.label }}</span>
              <span class="min-w-0">
                <span class="block truncate font-medium text-stone-600 text-xs @[420px]:text-[12.5px] leading-tight">{{ z.name }}</span>
                <span class="block tabular text-stone-400 text-[9.5px] @[420px]:text-[10px] leading-tight">{{ z.watts }}</span>
              </span>
              <span class="h-[5px] @[420px]:h-1.5 rounded-[3px] bg-[#f2f0ee] relative overflow-hidden">
                <span class="absolute inset-y-0 left-0 rounded-[3px]" :style="{ background: z.color, width: z.bar + '%' }" />
              </span>
              <span class="tabular text-right font-semibold text-stone-900 text-xs @[420px]:text-[12.5px]">{{ z.time }}</span>
              <span class="tabular text-right font-medium text-stone-400 text-[11px] @[420px]:text-[11.5px]">{{ z.pct }}%</span>
            </div>
          </div>

          <!-- Power breakdown — moved off Summary, otherwise unchanged -->
          <div v-if="sortedPowerBests.length > 0" class="mt-[18px] pt-4 border-t border-[#f0efed]">
            <div class="flex items-baseline justify-between mb-2 @[420px]:mb-2.5">
              <span class="font-semibold text-stone-400 uppercase tracking-[.09em] text-[9.5px] @[420px]:text-[10px]">
                Power breakdown<span class="@[420px]:hidden"> · best average, W</span>
              </span>
              <span class="hidden @[420px]:inline text-[11px] text-stone-300">best average, W</span>
            </div>
            <div class="grid grid-cols-2 gap-x-4 @[420px]:gap-x-[22px] gap-y-0.5">
              <div v-for="pb in sortedPowerBests" :key="pb.duration" class="grid items-center gap-1.5 @[420px]:gap-2 py-[3px] [grid-template-columns:34px_1fr_34px] @[420px]:[grid-template-columns:38px_1fr_40px]">
                <span class="font-medium text-stone-400 text-[10.5px] @[420px]:text-[11px]">{{ pb.duration }}</span>
                <span class="h-[5px] @[420px]:h-1.5 rounded-full bg-[#f2f0ee] relative overflow-hidden">
                  <span class="absolute inset-y-0 left-0 rounded-full bg-orange-300" :style="{ width: bestPct(pb.watts) + '%' }" />
                </span>
                <span class="tabular text-right font-semibold text-stone-900 text-xs @[420px]:text-[12.5px]">{{ pb.watts }}</span>
              </div>
            </div>
          </div>
        </template>

        <!-- Summary page -->
        <template v-else>
          <!-- Headline TSS / NP / IF strip -->
          <div
            class="grid border border-stone-200 rounded-xl overflow-hidden"
            :style="{ gridTemplateColumns: `repeat(${workout.fitData ? 3 : 1}, 1fr)` }"
          >
            <div class="px-3.5 py-3 border-r border-stone-200">
              <p class="tabular font-semibold text-stone-900 leading-none text-[22px] @[420px]:text-[26px]">{{ workout.tss }}</p>
              <p class="font-semibold text-stone-400 uppercase tracking-[.09em] mt-[5px] text-[9.5px] @[420px]:text-[10px]">TSS</p>
            </div>
            <template v-if="workout.fitData">
              <div class="px-3.5 py-3 border-r border-stone-200">
                <p class="tabular font-semibold text-stone-900 leading-none text-[22px] @[420px]:text-[26px]">
                  {{ workout.fitData.normalizedPower }}<span class="font-medium text-stone-400 text-xs @[420px]:text-sm">W</span>
                </p>
                <p class="font-semibold text-stone-400 uppercase tracking-[.09em] mt-[5px] text-[9.5px] @[420px]:text-[10px]">NP</p>
              </div>
              <div class="px-3.5 py-3">
                <p class="tabular font-semibold text-stone-900 leading-none text-[22px] @[420px]:text-[26px]">{{ workout.fitData.intensityFactor.toFixed(2) }}</p>
                <p class="font-semibold text-stone-400 uppercase tracking-[.09em] mt-[5px] text-[9.5px] @[420px]:text-[10px]">IF</p>
              </div>
            </template>
          </div>

          <!-- Avg / max table -->
          <div v-if="workout.fitData" class="mt-4">
            <div class="grid pb-1.5 border-b border-[#f0efed] [grid-template-columns:1fr_66px_66px] @[420px]:[grid-template-columns:1fr_84px_84px]">
              <span />
              <span class="text-right font-semibold text-stone-400 uppercase tracking-[.09em] text-[9.5px] @[420px]:text-[10px]">Avg</span>
              <span class="text-right font-semibold text-stone-400 uppercase tracking-[.09em] text-[9.5px] @[420px]:text-[10px]">Max</span>
            </div>
            <div class="grid items-baseline py-2 @[420px]:py-[9px] border-b border-[#f7f6f5] [grid-template-columns:1fr_66px_66px] @[420px]:[grid-template-columns:1fr_84px_84px]">
              <span class="text-[13px] @[420px]:text-[13.5px] text-stone-500">Power</span>
              <span class="tabular text-right font-semibold text-stone-900 text-[13px] @[420px]:text-sm">{{ workout.fitData.avgPower }}<span class="font-medium text-stone-400 text-[10px] @[420px]:text-[11px]"> W</span></span>
              <span class="tabular text-right font-semibold text-stone-900 text-[13px] @[420px]:text-sm">{{ workout.fitData.maxPower }}<span class="font-medium text-stone-400 text-[10px] @[420px]:text-[11px]"> W</span></span>
            </div>
            <div v-if="workout.fitData.avgHr != null || workout.fitData.maxHr != null" class="grid items-baseline py-2 @[420px]:py-[9px] border-b border-[#f7f6f5] [grid-template-columns:1fr_66px_66px] @[420px]:[grid-template-columns:1fr_84px_84px]">
              <span class="text-[13px] @[420px]:text-[13.5px] text-stone-500">Heart rate</span>
              <span class="tabular text-right font-semibold text-stone-900 text-[13px] @[420px]:text-sm">{{ workout.fitData.avgHr ?? '—' }}<span v-if="workout.fitData.avgHr != null" class="font-medium text-stone-400 text-[10px] @[420px]:text-[11px]"> bpm</span></span>
              <span class="tabular text-right font-semibold text-stone-900 text-[13px] @[420px]:text-sm">{{ workout.fitData.maxHr ?? '—' }}<span v-if="workout.fitData.maxHr != null" class="font-medium text-stone-400 text-[10px] @[420px]:text-[11px]"> bpm</span></span>
            </div>
            <div v-if="workout.fitData.avgCadence != null || workout.fitData.maxCadence != null" class="grid items-baseline py-2 @[420px]:py-[9px] [grid-template-columns:1fr_66px_66px] @[420px]:[grid-template-columns:1fr_84px_84px]">
              <span class="text-[13px] @[420px]:text-[13.5px] text-stone-500">Cadence</span>
              <span class="tabular text-right font-semibold text-stone-900 text-[13px] @[420px]:text-sm">{{ workout.fitData.avgCadence ?? '—' }}<span v-if="workout.fitData.avgCadence != null" class="font-medium text-stone-400 text-[10px] @[420px]:text-[11px]"> rpm</span></span>
              <span class="tabular text-right font-semibold text-stone-900 text-[13px] @[420px]:text-sm">{{ workout.fitData.maxCadence ?? '—' }}<span v-if="workout.fitData.maxCadence != null" class="font-medium text-stone-400 text-[10px] @[420px]:text-[11px]"> rpm</span></span>
            </div>
          </div>

          <!-- RPE -->
          <div v-if="workout.rpe" class="flex items-center justify-between mt-4 @[420px]:mt-[18px] pt-[13px] @[420px]:pt-3.5 border-t border-[#f0efed]">
            <span class="text-[13px] @[420px]:text-[13.5px] text-stone-500">RPE</span>
            <span class="tabular font-semibold text-stone-900 text-[13px] @[420px]:text-sm">{{ workout.rpe }}<span class="font-medium text-stone-400 text-[11px] @[420px]:text-xs">/10</span></span>
          </div>

          <!-- Notes -->
          <div v-if="workout.notes" class="mt-[13px] @[420px]:mt-[14px] pt-[13px] @[420px]:pt-[14px] border-t border-[#f0efed]">
            <p class="font-semibold text-stone-400 uppercase tracking-[.09em] mb-1.5 text-[9.5px] @[420px]:text-[10px]">Notes</p>
            <p class="text-[13px] @[420px]:text-[13.5px] leading-[1.5] text-stone-600 whitespace-pre-wrap" style="text-wrap:pretty">{{ workout.notes }}</p>
          </div>
        </template>
      </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Thin orange-themed scrollbar for the laps list — Firefox */
.laps-scroll {
  scrollbar-width: thin;
  scrollbar-color: var(--ui-primary) transparent;
}

/* Chrome/Safari */
.laps-scroll::-webkit-scrollbar {
  width: 6px;
}
.laps-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.laps-scroll::-webkit-scrollbar-thumb {
  background-color: var(--ui-primary);
  border-radius: 9999px;
}
</style>
