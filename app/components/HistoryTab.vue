<script setup lang="ts">
/**
 * History tab
 *
 * Two views behind one sub-tab bar:
 *  - Week / Month / Year — aggregated ride totals (TSS, hours, distance,
 *    ride count) grouped by the selected period, from GET /api/history.
 *  - ⚡️PBs — the power-bests panel: best-ever power for each duration,
 *    grouped into effort bands (Sprint … Endurance), with a bar scaled to a
 *    fixed %FTP ceiling and a notch marking the last-8-weeks best.
 *
 * `groupBy` drives the API query; `activeView` also covers the non-grouping
 * 'bests' view, so selectTab() only mirrors it back into `groupBy` for the
 * three period tabs.
 */

type GroupBy = 'week' | 'month' | 'year'
type ActiveView = GroupBy | 'bests' | 'segments'

const groupBy = ref<GroupBy>('month')
const activeView = ref<ActiveView>('month')

const tabs = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'bests', label: '⚡️PBs' },
  { id: 'segments', label: '🏔️ Segments' },
] as const

const NON_PERIOD_VIEWS = ['bests', 'segments'] as const

/** Switch sub-tab; keep `groupBy` in sync for the three period views. */
function selectTab(id: ActiveView) {
  activeView.value = id
  if (!(NON_PERIOD_VIEWS as readonly string[]).includes(id)) groupBy.value = id as GroupBy
}

const { data, pending } = useFetch('/api/history', {
  query: computed(() => ({ groupBy: groupBy.value })),
})

function formatHours(h: number): string {
  const hours = Math.floor(h)
  const mins = Math.round((h - hours) * 60)
  if (hours === 0) return `${mins}m`
  if (mins === 0) return `${hours}h`
  return `${hours}h ${mins}m`
}

// ── Power bests panel: effort bands ─────────────────────────────────────
const BANDS = [
  { label: 'Sprint', range: '5–30 sec', durations: ['5sec', '15sec', '30sec'] },
  { label: 'Anaerobic', range: '1–2 min', durations: ['1min', '2min'] },
  { label: 'VO2 max', range: '3–8 min', durations: ['3min', '5min', '8min'] },
  { label: 'Threshold', range: '10–30 min', durations: ['10min', '15min', '20min', '30min'] },
  { label: 'Endurance', range: '45 min – 1 h', durations: ['45min', '1h'] },
] as const

// Fixed bar scale. NOT max-of-data: a fixed ceiling means the curve's shape is comparable
// between two riders and between two visits, and 340% comfortably clears a 5sec sprint
// at ~320% of FTP. Values above it clamp at 100% width.
const FTP_BAR_CEILING = 340

function clampPct(pctOfFtp: number | null) {
  if (pctOfFtp == null) return null
  return Math.min(100, Math.round((pctOfFtp / FTP_BAR_CEILING) * 100))
}

function formatBestDate(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso + 'T00:00')
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
}

const bands = computed(() => {
  const panel = data.value?.powerBestsPanel
  const ftp = data.value?.currentFtp ?? null
  const kg = data.value?.weightKg ?? null
  if (!panel?.durations?.length) return []

  return BANDS.map((band) => {
    const rows = band.durations
      .filter((d) => panel.durations.includes(d))
      .map((d) => {
        const all = panel.allTime[d] ?? []
        const best = all[0] ?? null
        const eight = panel.last8Weeks[d] ?? null
        const meta = panel.bestMeta?.[d]
        const pctOf = (w: number | null) =>
          w != null && ftp ? (w / ftp) * 100 : null
        return {
          duration: d,
          best,
          second: all[1] ?? null,
          third: all[2] ?? null,
          eight,
          isFresh: meta?.isFresh ?? false,
          date: meta?.date ?? null,
          ftpPct: pctOf(best),
          wkg: best != null && kg ? best / kg : null,
          barPct: clampPct(pctOf(best)),
          notchPct: eight != null ? clampPct(pctOf(eight)) : null,
        }
      })
    return {
      ...band,
      rows,
      peak: rows.length ? Math.max(...rows.map((r) => r.best ?? 0)) : null,
    }
  }).filter((b) => b.rows.length)
})

const freshCount = computed(() => bands.value.flatMap((b) => b.rows).filter((r) => r.isFresh).length)
</script>

<template>
  <div class="max-w-2xl mx-auto space-y-6">

    <!-- Group selector + current FTP chip -->
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div class="inline-flex gap-1 rounded-xl bg-stone-100 p-1">
        <button
          v-for="opt in tabs"
          :key="opt.id"
          class="rounded-lg px-4 py-1.5 text-sm transition-colors"
          :class="activeView === opt.id
            ? 'bg-white font-semibold text-stone-900 shadow-sm'
            : 'font-medium text-stone-500 hover:text-stone-700'"
          @click="selectTab(opt.id)"
        >
          {{ opt.label }}
        </button>
      </div>

      <span class="inline-flex items-center gap-2 rounded-full bg-violet-50 px-3.5 py-1.5">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-violet-400">FTP</span>
        <span class="text-sm font-bold text-violet-600 tabular-nums">
          {{ data?.currentFtp != null ? `${data.currentFtp}W` : '—' }}
        </span>
      </span>
    </div>

    <!-- Loading (period + PBs views only — the Segments panel loads its own) -->
    <div v-if="pending && activeView !== 'segments'" class="flex justify-center py-16">
      <BikeSpinner :size="24" class="text-stone-300" />
    </div>

    <!-- ── Segments ──────────────────────────────────────────────────── -->
    <HistorySegmentsPanel v-else-if="activeView === 'segments'" />

    <!-- ── Period rows (week / month / year) ──────────────────────────── -->
    <template v-else-if="activeView !== 'bests'">
      <!-- Empty state -->
      <div v-if="!data?.periods?.length" class="text-center py-16">
        <p class="text-stone-300 text-4xl mb-4">○</p>
        <p class="text-sm font-medium text-stone-500">No workouts logged yet</p>
      </div>

      <div
        v-else
        class="bg-white rounded-xl border border-stone-100 overflow-hidden"
      >
        <div
          v-for="(period, i) in data.periods"
          :key="period.key"
          class="flex items-center gap-4 px-6 py-2 hover:bg-stone-100 transition-colors"
          :class="i % 2 === 0 ? 'bg-stone-50' : 'bg-white'"
        >
          <!-- Period label -->
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-stone-700 truncate">{{ period.label }}</p>
            <p class="text-xs text-stone-300">
              {{ period.workoutCount }} workout{{ period.workoutCount !== 1 ? 's' : '' }}
            </p>
          </div>

          <!-- Stats -->
          <div class="flex items-center gap-3 shrink-0">
            <span class="text-sm tabular-nums text-stone-600 font-medium w-20 text-right">
              {{ period.tssTotal }} TSS
            </span>
            <span class="text-sm tabular-nums text-stone-400 w-16 text-right">
              {{ formatHours(period.hoursTotal) }}
            </span>
            <span class="text-sm tabular-nums text-stone-400 w-20 text-right">
              {{ period.kmTotal }} km
            </span>
          </div>

          <!-- Indicators — fixed width so stats column stays aligned across all rows -->
          <div class="flex items-center gap-1.5 shrink-0 justify-end w-32">
            <!-- FTP update -->
            <span
              v-if="period.hasFtp"
              class="inline-flex items-center gap-1 text-xs text-violet-600 font-semibold bg-violet-50 rounded-full px-2 py-0.5"
              :title="`FTP updated to ${period.ftpWatts}W`"
            >
              <svg class="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              {{ period.ftpWatts }}W
            </span>
            <!-- Power bests -->
            <span
              v-if="period.hasPowerBests"
              class="inline-flex items-center gap-1 text-xs text-amber-600 font-semibold bg-amber-50 rounded-full px-2 py-0.5"
              title="Power bests recorded"
            >
              <svg class="w-3 h-3 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
              PR
            </span>
          </div>
        </div>
      </div>
    </template>

    <!-- ── Power bests panel ───────────────────────────────────────────── -->
    <template v-else>
      <!-- No data state -->
      <div
        v-if="!data?.powerBestsPanel?.durations?.length"
        class="bg-white rounded-xl border border-stone-100 px-5 py-8 text-sm text-stone-300 text-center"
      >
        No power bests recorded
      </div>

      <template v-else>
        <!-- Status line -->
        <div class="flex items-center justify-between gap-3 px-0.5">
          <div v-if="freshCount > 0" class="inline-flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-orange-500 shrink-0"></span>
            <span class="text-xs font-medium text-stone-600">
              {{ freshCount }} best{{ freshCount !== 1 ? 's' : '' }} set in the last 8 weeks
            </span>
          </div>
          <div v-else />
          <span v-if="data?.currentFtp != null" class="text-[11.5px] text-stone-400">
            bar = % of FTP · notch = last 8 weeks
          </span>
        </div>

        <!-- Card -->
        <div class="bg-white rounded-xl border border-stone-100 px-4 pt-1 pb-3">
          <!-- Column header -->
          <div
            class="grid grid-cols-[44px_46px_52px_1fr_72px] sm:grid-cols-[54px_52px_56px_82px_1fr_54px_84px] gap-3 items-baseline py-2 border-b border-stone-100"
          >
            <span></span>
            <span class="text-right text-[10px] font-semibold uppercase tracking-wider text-stone-400">8w</span>
            <span class="text-right text-[10px] font-semibold uppercase tracking-wider text-stone-400">Best</span>
            <span class="hidden sm:inline text-right text-[10px] font-semibold uppercase tracking-wider text-stone-400">2nd / 3rd</span>
            <span class="text-right text-[10px] font-semibold uppercase tracking-wider text-stone-400">% FTP</span>
            <span class="hidden sm:inline text-right text-[10px] font-semibold uppercase tracking-wider text-stone-400">W/kg</span>
            <span class="text-right text-[10px] font-semibold uppercase tracking-wider text-stone-400">Set</span>
          </div>

          <!-- Bands -->
          <div v-for="band in bands" :key="band.label">
            <div class="flex items-baseline justify-between gap-2.5 pt-3.5 pb-1.5">
              <div class="flex items-baseline gap-2">
                <span class="text-[10.5px] font-semibold uppercase tracking-wider text-stone-600">{{ band.label }}</span>
                <span class="text-[11px] text-stone-400">{{ band.range }}</span>
              </div>
              <span v-if="band.peak != null" class="text-[11px] font-medium text-stone-400 tabular-nums">peak {{ band.peak }}W</span>
            </div>

            <div
              v-for="row in band.rows"
              :key="row.duration"
              class="py-1.5 hover:bg-stone-50 transition-colors duration-150"
            >
              <div
                class="grid grid-cols-[44px_46px_52px_1fr_72px] sm:grid-cols-[54px_52px_56px_82px_1fr_54px_84px] gap-3 items-baseline"
              >
                <span class="text-xs font-medium text-stone-500">{{ row.duration }}</span>
                <span
                  class="text-right text-[13px] font-medium tabular-nums"
                  :class="row.isFresh ? 'text-orange-600' : row.eight != null ? 'text-stone-400' : 'text-stone-300'"
                >
                  {{ row.eight != null ? row.eight : '—' }}
                </span>
                <span class="text-right text-sm font-semibold text-stone-900 tabular-nums">{{ row.best }}</span>
                <span class="hidden sm:inline text-right text-[12.5px] font-medium text-stone-400 tabular-nums">
                  {{ row.second != null && row.third != null ? `${row.second} / ${row.third}` : '—' }}
                </span>
                <span class="text-right text-[12.5px] font-medium text-stone-500 tabular-nums">
                  {{ row.ftpPct != null ? `${Math.round(row.ftpPct)}%` : '—' }}
                </span>
                <span class="hidden sm:inline text-right text-[12.5px] font-medium text-stone-600 tabular-nums">
                  {{ row.wkg != null ? row.wkg.toFixed(2) : '—' }}
                </span>
                <span
                  class="text-right text-xs font-medium tabular-nums"
                  :class="row.isFresh ? 'text-orange-600' : 'text-stone-400'"
                >
                  {{ formatBestDate(row.date) }}
                </span>
              </div>

              <div v-if="row.barPct != null" class="relative h-[3px] rounded-full bg-stone-100 mt-1.5">
                <div
                  class="h-[3px] rounded-full"
                  :class="row.isFresh ? 'bg-orange-500' : 'bg-orange-300'"
                  :style="{ width: `${row.barPct}%` }"
                ></div>
                <div
                  v-if="row.notchPct != null"
                  class="absolute -top-0.5 h-[7px] w-0.5 rounded-full bg-stone-400"
                  :style="{ left: `${row.notchPct}%` }"
                ></div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </template>

  </div>
</template>
