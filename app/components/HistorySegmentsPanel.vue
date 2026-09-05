<script setup lang="ts">
/**
 * History → 🏔️ Segments
 *
 * Lists the user's tracked Strava segments (their starred list, mirrored
 * locally — see CLAUDE.md's Strava segments section). Each row expands to a
 * sorted top-5 of the athlete's fastest efforts on that segment: time,
 * speed, power, HR, rank and date. Elevation gain is a property of the
 * segment, so it's shown once in the row's summary, not per effort.
 *
 * "Sync segments" pulls the current starred list from Strava and backfills
 * efforts for anything new. Ongoing efforts arrive automatically when an
 * outdoor ride is logged, plus a nightly reconcile — this button is only
 * needed after starring/un-starring something.
 */

interface SegmentEffort {
  rank: number
  elapsedTime: number
  movingTime: number | null
  speedKmh: number | null
  averageWatts: number | null
  deviceWatts: boolean | null
  averageHeartrate: number | null
  maxHeartrate: number | null
  averageCadence: number | null
  prRank: number | null
  startDate: string
  stravaActivityId: number
}

interface TrackedSegment {
  id: number
  name: string
  distanceMeters: number
  averageGrade: number | null
  climbCategory: number | null
  totalElevationGain: number | null
  city: string | null
  state: string | null
  country: string | null
  effortCount: number
  prElapsedTime: number | null
  efforts: SegmentEffort[]
}

const { data, pending, refresh } = useFetch<{ segments: TrackedSegment[] }>('/api/segments')
const toast = useToast()

const segments = computed(() => data.value?.segments ?? [])

// ── Sync button ──────────────────────────────────────────────────────────
const syncing = ref(false)

async function syncSegments() {
  if (syncing.value) return
  syncing.value = true
  try {
    const res = await $fetch<{
      starredCount: number
      newlyTracked: number
      unstarred: number
      backfilledSegments: number
      effortsWritten: number
      failures: number
    }>('/api/segments/sync', { method: 'POST' })

    await refresh()

    const bits: string[] = []
    if (res.newlyTracked) bits.push(`${res.newlyTracked} new`)
    if (res.unstarred) bits.push(`${res.unstarred} un-starred`)
    if (res.backfilledSegments) bits.push(`${res.effortsWritten} efforts pulled`)
    toast.add({
      title: `${res.starredCount} starred segment${res.starredCount === 1 ? '' : 's'}`,
      description: bits.length ? bits.join(' · ') : 'Everything already up to date.',
      color: res.failures ? 'warning' : 'success',
    })
  }
  catch {
    toast.add({
      title: "Couldn't sync segments",
      description: 'Strava may be unreachable — try again in a moment.',
      color: 'error',
    })
  }
  finally {
    syncing.value = false
  }
}

// ── Accordion ────────────────────────────────────────────────────────────
const open = ref<Set<number>>(new Set())

function toggle(id: number) {
  const next = new Set(open.value)
  next.has(id) ? next.delete(id) : next.add(id)
  open.value = next
}

// ── Formatting ───────────────────────────────────────────────────────────
function formatElapsed(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`
}

function formatEffortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
}

/** 🥇/🥈/🥉 for the podium, plain position after that. */
function medal(rank: number): string {
  return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : String(rank)
}

function climbLabel(cat: number | null): string | null {
  if (cat == null || cat <= 0) return null
  return cat >= 5 ? 'HC' : `Cat ${cat}`
}

function locationLine(s: TrackedSegment): string {
  return [s.city, s.state].filter(Boolean).join(', ')
}

function power(e: SegmentEffort): string {
  if (e.averageWatts == null) return '—'
  // device_watts === false ⇒ Strava's estimate, not a real meter.
  return `${e.deviceWatts === false ? '~' : ''}${Math.round(e.averageWatts)} W`
}
</script>

<template>
  <div class="space-y-4">
    <!-- Header: count + sync button -->
    <div class="flex items-center justify-between gap-3 px-0.5">
      <span class="text-xs font-medium text-stone-500">
        {{ segments.length }} tracked segment{{ segments.length === 1 ? '' : 's' }}
      </span>
      <button
        class="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm shadow-orange-600/20 transition-colors hover:bg-orange-700 disabled:opacity-60"
        :disabled="syncing"
        @click="syncSegments"
      >
        <BikeSpinner v-if="syncing" :size="13" class="text-white" />
        <UIcon v-else name="i-heroicons-arrow-path" class="h-3.5 w-3.5" />
        {{ syncing ? 'Syncing…' : 'Sync segments' }}
      </button>
    </div>

    <!-- Loading -->
    <div v-if="pending" class="flex justify-center py-16">
      <BikeSpinner :size="24" class="text-stone-300" />
    </div>

    <!-- Empty -->
    <div
      v-else-if="segments.length === 0"
      class="bg-white rounded-xl border border-stone-100 px-5 py-10 text-center"
    >
      <p class="text-stone-300 text-4xl mb-3">⛰</p>
      <p class="text-sm font-medium text-stone-500">No segments tracked yet</p>
      <p class="text-xs text-stone-400 mt-1.5">
        Star some segments on Strava, then hit "Sync segments".
      </p>
    </div>

    <!-- Segment list -->
    <div v-else class="bg-white rounded-xl border border-stone-100 overflow-hidden divide-y divide-[#f7f5f3]">
      <div v-for="(seg, i) in segments" :key="seg.id" :class="i % 2 === 0 ? 'bg-stone-50' : 'bg-white'">
        <!-- Summary row — everything aligns to the first text line (name / best time) -->
        <div class="flex items-start hover:bg-stone-100 transition-colors">
        <button
          class="flex min-w-0 flex-1 items-start gap-4 py-2.5 pl-5 text-left"
          @click="toggle(seg.id)"
        >
          <UIcon
            :name="open.has(seg.id) ? 'i-heroicons-chevron-down' : 'i-heroicons-chevron-right'"
            class="mt-0.5 h-4 w-4 shrink-0 text-stone-300"
          />

          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <p class="text-sm font-semibold text-stone-700 truncate">{{ seg.name }}</p>
              <span
                v-if="climbLabel(seg.climbCategory)"
                class="shrink-0 rounded-full bg-orange-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-orange-500"
              >
                {{ climbLabel(seg.climbCategory) }}
              </span>
            </div>
            <p class="text-xs text-stone-400 truncate">
              {{ locationLine(seg) || '—' }}
            </p>
          </div>

          <!-- Segment-level stats -->
          <div class="hidden sm:flex items-center gap-3 shrink-0 tabular-nums">
            <span class="w-20 text-right text-xs text-stone-400">{{ formatDistance(seg.distanceMeters) }}</span>
            <span class="w-12 text-right text-xs text-stone-400">
              {{ seg.averageGrade != null ? `${seg.averageGrade.toFixed(1)}%` : '—' }}
            </span>
            <span class="w-16 text-right text-xs text-stone-400">
              {{ seg.totalElevationGain != null ? `${Math.round(seg.totalElevationGain)} m` : '—' }}
            </span>
          </div>

          <!-- PR time + effort count -->
          <div class="shrink-0 text-right w-20">
            <p class="text-sm font-semibold text-stone-900 tabular-nums">
              {{ seg.prElapsedTime != null ? formatElapsed(seg.prElapsedTime) : (seg.efforts[0] ? formatElapsed(seg.efforts[0].elapsedTime) : '—') }}
            </p>
            <p class="text-[11px] text-stone-300">
              {{ seg.effortCount }} effort{{ seg.effortCount === 1 ? '' : 's' }}
            </p>
          </div>
        </button>

        <!-- Open the segment on Strava (my results) -->
        <a
          :href="`https://www.strava.com/segments/${seg.id}?filter=my_results`"
          target="_blank"
          rel="noopener noreferrer"
          :title="`Open ${seg.name} on Strava`"
          class="shrink-0 flex items-start px-4 pt-3 text-stone-300 hover:text-orange-600 transition-colors"
          @click.stop
        >
          <UIcon name="i-heroicons-arrow-top-right-on-square" class="h-4 w-4" />
        </a>
        </div>

        <!-- Expanded: top-5 efforts -->
        <div v-if="open.has(seg.id)" class="px-5 pb-3.5 pt-1">
          <div v-if="seg.efforts.length === 0" class="py-3 text-center text-xs text-stone-400">
            No efforts recorded yet.
          </div>

          <template v-else>
            <!-- column header -->
            <div
              class="grid grid-cols-[28px_54px_1fr_1fr_60px] sm:grid-cols-[28px_60px_72px_64px_64px_1fr] gap-2 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-stone-300"
            >
              <span></span>
              <span>Time</span>
              <span class="text-right">Speed</span>
              <span class="text-right">Power</span>
              <span class="hidden sm:inline text-right">HR</span>
              <span class="text-right">Date</span>
            </div>

            <div
              v-for="e in seg.efforts"
              :key="e.rank"
              class="grid grid-cols-[28px_54px_1fr_1fr_60px] sm:grid-cols-[28px_60px_72px_64px_64px_1fr] items-baseline gap-2 rounded-lg px-2 py-1.5 odd:bg-stone-50/70 tabular-nums"
            >
              <span class="block text-center text-sm" :class="e.rank > 3 ? 'text-xs font-semibold text-stone-400' : ''">
                {{ medal(e.rank) }}
              </span>
              <span class="text-[13px] font-semibold text-stone-900">{{ formatElapsed(e.elapsedTime) }}</span>
              <span class="text-right text-[12.5px] text-stone-500">
                {{ e.speedKmh != null ? `${e.speedKmh.toFixed(1)} km/h` : '—' }}
              </span>
              <span class="text-right text-[12.5px] text-stone-500">{{ power(e) }}</span>
              <span class="hidden sm:inline text-right text-[12.5px] text-stone-500">
                {{ e.averageHeartrate != null ? `${Math.round(e.averageHeartrate)}` : '—' }}
              </span>
              <span class="text-right text-[12px] text-stone-400">{{ formatEffortDate(e.startDate) }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <p class="text-center text-[11.5px] text-stone-300">
      Efforts sync automatically with each outdoor ride · use Sync after starring a new segment on Strava
    </p>
  </div>
</template>
