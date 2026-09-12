<script setup lang="ts">
interface ClimbPortalEntry {
  portal: string
  name: string
  slug: string
  distanceKm: number
  elevationM: number
  gradientPercent: number
}

interface RaceEventEntry {
  id: number
  name: string
  type: 'TT' | 'CRIT'
  eventStart: string
  laps: number
  distanceKm: number | null
}

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const loading = ref(false)
const loaded = ref(false)
const climbs = ref<ClimbPortalEntry[]>([])
const races = ref<RaceEventEntry[]>([])

/** "YYYY-MM-DD" in the browser's own local timezone — see the timezone note in server/utils/zwiftEvents.ts for why this matters. */
function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function load() {
  loading.value = true
  try {
    const data = await $fetch<{ climbs: ClimbPortalEntry[], races: RaceEventEntry[] }>('/api/zwift/today', {
      query: { date: todayStr() },
    })
    climbs.value = data.climbs
    races.value = data.races
    loaded.value = true
  }
  catch {
    // Leave whatever was loaded before (if anything) — the empty-state copy
    // below covers the "nothing loaded at all" case without a scary error.
  }
  finally {
    loading.value = false
  }
}

watch(() => props.open, (isOpen) => {
  if (isOpen) load()
})

function raceTimeLabel(iso: string): string {
  const start = new Date(iso)
  const diffMin = Math.round((start.getTime() - Date.now()) / 60_000)
  const time = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (diffMin <= 0) return `${time} · in progress`
  if (diffMin < 60) return `${time} · in ${diffMin}m`
  const hours = Math.floor(diffMin / 60)
  const mins = diffMin % 60
  return `${time} · in ${hours}h${mins ? ` ${mins}m` : ''}`
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Today's Zwift events"
    >
      <div
        class="fixed inset-0 bg-black/25 backdrop-blur-sm"
        @click="emit('close')"
      />

      <div class="relative bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 my-8">
        <div class="flex items-start justify-between gap-3 mb-5">
          <h2 class="font-semibold text-stone-900 text-[17px]">
            Today's Zwift events
          </h2>
          <button
            type="button"
            class="flex-none w-[26px] h-[26px] grid place-items-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-600 transition-colors"
            aria-label="Close"
            @click="emit('close')"
          >
            <UIcon name="i-heroicons-x-mark" class="w-[13px] h-[13px]" />
          </button>
        </div>

        <div v-if="loading && !loaded" class="text-sm text-stone-400 py-6 text-center">
          Loading…
        </div>

        <div v-else class="space-y-6">
          <!-- Climb portals -->
          <div>
            <p class="text-[11px] font-semibold uppercase tracking-[0.13em] text-stone-400 mb-2.5">
              Climb portal
            </p>
            <div v-if="climbs.length" class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div
                v-for="climb in climbs"
                :key="climb.slug"
                class="rounded-xl border border-stone-100 bg-stone-50 p-3"
              >
                <p class="text-[11px] font-medium text-stone-400 mb-0.5">
                  {{ climb.portal }}
                </p>
                <p class="font-semibold text-stone-900 text-sm mb-1">
                  {{ climb.name }}
                </p>
                <p class="tabular text-xs text-stone-500">
                  {{ climb.distanceKm.toFixed(1) }} km · {{ climb.elevationM }} m · {{ climb.gradientPercent.toFixed(1) }}%
                </p>
              </div>
            </div>
            <p v-else class="text-sm text-stone-400">
              Couldn't load the climb portal schedule.
            </p>
          </div>

          <!-- Races -->
          <div>
            <p class="text-[11px] font-semibold uppercase tracking-[0.13em] text-stone-400 mb-2.5">
              TTs &amp; crits coming up
            </p>
            <div v-if="races.length" class="divide-y divide-stone-100 rounded-xl border border-stone-100 overflow-hidden">
              <div
                v-for="race in races"
                :key="race.id"
                class="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div class="min-w-0">
                  <p class="font-medium text-stone-900 text-sm truncate">
                    {{ race.name }}
                  </p>
                  <p class="tabular text-xs text-stone-500">
                    {{ raceTimeLabel(race.eventStart) }}
                    <template v-if="race.distanceKm"> · {{ race.distanceKm.toFixed(1) }} km</template>
                    <template v-else-if="race.laps"> · {{ race.laps }} laps</template>
                  </p>
                </div>
                <span
                  class="flex-none text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5"
                  :class="race.type === 'TT' ? 'bg-sky-100 text-sky-700' : 'bg-orange-100 text-orange-700'"
                >
                  {{ race.type }}
                </span>
              </div>
            </div>
            <p v-else class="text-sm text-stone-400">
              No TTs or crits starting in the next few hours.
            </p>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
