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

// Header subtitle: "Thursday 11 September"
const todayLabel = computed(() =>
  new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
)

function raceTime(iso: string): { time: string, rel: string } {
  const start = new Date(iso)
  const diffMin = Math.round((start.getTime() - Date.now()) / 60_000)
  const time = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (diffMin <= 0) return { time, rel: 'in progress' }
  if (diffMin < 60) return { time, rel: `in ${diffMin}m` }
  const h = Math.floor(diffMin / 60)
  const m = diffMin % 60
  return { time, rel: `in ${h}h${m ? ` ${m}m` : ''}` }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    load()
    window.addEventListener('keydown', onKeydown)
  }
  else {
    window.removeEventListener('keydown', onKeydown)
  }
})
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

      <div class="relative bg-white rounded-2xl shadow-xl w-full max-w-3xl my-8 flex flex-col max-h-[min(720px,85vh)] overflow-hidden">
        <!-- Header -->
        <div class="flex items-start justify-between gap-3 px-[22px] pt-5 pb-4 border-b border-[#f0efed]">
          <div class="min-w-0">
            <h2 class="font-semibold text-stone-900 text-[17px] leading-tight">
              Today's Zwift events
            </h2>
            <p class="text-[12.5px] text-stone-400 mt-1">
              {{ todayLabel }}
            </p>
          </div>
          <button
            type="button"
            class="flex-none w-[26px] h-[26px] grid place-items-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-600 transition-colors cursor-pointer"
            aria-label="Close"
            @click="emit('close')"
          >
            <UIcon name="i-heroicons-x-mark" class="w-[13px] h-[13px]" />
          </button>
        </div>

        <div v-if="loading && !loaded" class="text-sm text-stone-400 py-10 text-center">
          Loading…
        </div>

        <div v-else class="grid grid-cols-1 min-[720px]:grid-cols-[268px_1fr] min-h-0 overflow-y-auto min-[720px]:overflow-hidden">
          <!-- Climb portals (left rail at 720px+, plain block below) -->
          <div class="min-[720px]:border-r min-[720px]:border-[#f0efed] min-[720px]:bg-[#fcfbfa] px-[18px] pt-[18px] pb-5">
            <p class="text-[10px] font-semibold uppercase tracking-[0.13em] text-stone-400 mb-3">
              Climb portal
            </p>
            <div v-if="climbs.length" class="flex flex-col gap-2.5">
              <div
                v-for="climb in climbs"
                :key="climb.slug"
                class="rounded-xl border border-[#eeebe8] bg-white p-3"
              >
                <div class="flex items-center gap-1.5 mb-1.5">
                  <MountainIcon class="w-3.5 h-3.5 text-primary" />
                  <span class="text-[10px] font-semibold uppercase tracking-[0.09em] text-stone-400">
                    {{ climb.portal }}
                  </span>
                </div>
                <p class="font-semibold text-stone-900 text-[14.5px] leading-tight text-pretty">
                  {{ climb.name }}
                </p>
                <div class="tabular flex gap-2.5 mt-2.5 pt-2.5 border-t border-[#f5f3f1]">
                  <span class="text-[12.5px] font-semibold text-stone-600">{{ climb.distanceKm.toFixed(1) }}<span class="text-[10.5px] font-medium text-stone-300"> km</span></span>
                  <span class="text-[12.5px] font-semibold text-stone-600">{{ climb.elevationM }}<span class="text-[10.5px] font-medium text-stone-300"> m</span></span>
                  <span class="text-[12.5px] font-semibold text-stone-600">{{ climb.gradientPercent.toFixed(1) }}<span class="text-[10.5px] font-medium text-stone-300">%</span></span>
                </div>
              </div>
            </div>
            <p v-else class="text-[13px] text-stone-400">
              Couldn't load the climb portal schedule.
            </p>
          </div>

          <!-- Races -->
          <div class="flex flex-col min-h-0">
            <div class="flex items-baseline justify-between px-5 pt-[18px] pb-2">
              <span class="text-[10px] font-semibold uppercase tracking-[0.13em] text-stone-400">
                TTs &amp; crits coming up
              </span>
              <span class="text-[11px] text-stone-300">{{ races.length }} events</span>
            </div>
            <div class="laps-scroll min-[720px]:overflow-y-auto px-3.5 pb-[18px]">
              <div v-if="races.length" class="flex flex-col">
                <div
                  v-for="race in races"
                  :key="race.id"
                  class="flex items-center gap-[13px] px-2.5 py-2.5 rounded-[10px] hover:bg-[#faf9f8] transition-colors"
                >
                  <span
                    class="flex-none w-10 text-center text-[9.5px] font-bold uppercase tracking-[0.03em] rounded-full px-[7px] py-[3px]"
                    :class="race.type === 'TT' ? 'bg-sky-100 text-sky-700' : 'bg-orange-100 text-orange-700'"
                  >
                    {{ race.type }}
                  </span>
                  <div class="min-w-0 flex-1">
                    <p class="font-medium text-stone-900 text-[13.5px] truncate">
                      {{ race.name }}
                    </p>
                    <p class="tabular text-[11.5px] text-stone-400 mt-px">
                      <template v-if="race.distanceKm">{{ race.distanceKm.toFixed(1) }} km</template>
                      <template v-else-if="race.laps">{{ race.laps }} laps</template>
                    </p>
                  </div>
                  <div class="tabular flex-none text-right">
                    <p class="font-semibold text-stone-900 text-[13px]">
                      {{ raceTime(race.eventStart).time }}
                    </p>
                    <p
                      class="text-[11px] font-medium mt-px"
                      :class="race === races[0] ? 'text-primary' : 'text-stone-400'"
                    >
                      {{ raceTime(race.eventStart).rel }}
                    </p>
                  </div>
                </div>
              </div>
              <p v-else class="text-[13px] text-stone-400 px-2.5">
                No TTs or crits starting in the next few hours.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Thin orange-themed scrollbar for the race list — Firefox */
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
