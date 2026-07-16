<script setup lang="ts">
const POWER_BEST_DURATIONS = [
  '5sec', '15sec', '30sec', '1min', '2min', '3min', '5min',
  '8min', '10min', '15min', '20min', '30min', '45min', '1h',
] as const

type GroupBy = 'week' | 'month' | 'year'
type ActiveView = GroupBy | 'bests'

const groupBy = ref<GroupBy>('month')
const activeView = ref<ActiveView>('month')

const tabs = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
  { id: 'bests', label: '⚡️PBs' },
] as const

function selectTab(id: ActiveView) {
  activeView.value = id
  if (id !== 'bests') groupBy.value = id
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

    <!-- Loading -->
    <div v-if="pending" class="flex justify-center py-16">
      <UIcon name="i-heroicons-arrow-path" class="animate-spin text-stone-300 text-2xl" />
    </div>

    <!-- ── Period rows (week / month / year) ──────────────────────────── -->
    <template v-else-if="activeView !== 'bests'">
      <!-- Empty state -->
      <div v-if="!data?.periods?.length" class="text-center py-16">
        <p class="text-stone-300 text-4xl mb-4">○</p>
        <p class="text-sm font-medium text-stone-500">No workouts logged yet</p>
      </div>

      <div
        v-else
        class="bg-white rounded-xl border border-stone-100 overflow-hidden divide-y divide-stone-50"
      >
        <div
          v-for="period in data.periods"
          :key="period.key"
          class="flex items-center gap-4 px-6 py-4 hover:bg-stone-50 transition-colors"
        >
          <!-- Period label -->
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-stone-700 truncate">{{ period.label }}</p>
            <p class="text-xs text-stone-300 mt-0.5">
              {{ period.workoutCount }} workout{{ period.workoutCount !== 1 ? 's' : '' }}
            </p>
          </div>

          <!-- Stats -->
          <div class="flex items-center gap-3 shrink-0">
            <span class="text-sm tabular-nums text-stone-600 font-medium w-16 text-right">
              {{ period.tssTotal }} TSS
            </span>
            <span class="text-sm tabular-nums text-stone-400 w-14 text-right">
              {{ formatHours(period.hoursTotal) }}
            </span>
            <span class="text-sm tabular-nums text-stone-400 w-16 text-right">
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
    <div v-else class="bg-white rounded-xl border border-stone-100 overflow-hidden">
      <div class="px-5 py-3.5 border-b border-stone-50">
        <p class="text-xs font-semibold uppercase tracking-wide text-stone-400">Power bests</p>
      </div>

      <!-- No data state -->
      <div
        v-if="!data?.powerBestsPanel?.durations?.length"
        class="px-5 py-8 text-sm text-stone-300 text-center"
      >
        No power bests recorded
      </div>

      <table v-else class="w-full text-sm">
        <thead>
          <tr class="border-b border-stone-50">
            <th class="px-5 py-2.5 text-left font-semibold text-stone-400 w-24"></th>
            <th class="px-4 py-2.5 text-right font-semibold text-stone-400">8w</th>
            <th class="px-5 py-2.5 text-right font-semibold text-stone-400">All time</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-stone-50">
          <tr
            v-for="dur in POWER_BEST_DURATIONS.filter(d => data?.powerBestsPanel?.durations?.includes(d))"
            :key="dur"
            class="hover:bg-stone-50 transition-colors"
          >
            <td class="px-5 py-2.5 font-medium text-stone-500">{{ dur }}</td>
            <td class="px-4 py-2.5 text-right tabular-nums text-stone-600">
              <span v-if="data?.powerBestsPanel?.last8Weeks?.[dur]">
                {{ data.powerBestsPanel.last8Weeks[dur] }}
              </span>
              <span v-else class="text-stone-200">—</span>
            </td>
            <td class="px-5 py-2.5 text-right tabular-nums font-semibold text-stone-700">
              <span v-if="data?.powerBestsPanel?.allTime?.[dur]">
                {{ data.powerBestsPanel.allTime[dur] }}
              </span>
              <span v-else class="text-stone-200">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

  </div>
</template>
