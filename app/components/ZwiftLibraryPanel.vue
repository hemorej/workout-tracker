<script setup lang="ts">
/**
 * Workout library dialog (Workout builder tab).
 *
 * Lists the mirrored Zwift `.zwo` files (GET /api/zwift/library), filters them
 * by text, duration range, TSS range and zone, previews one as a timeline and hands it to the builder via
 * the zwiftLibrary store. The zone is the file's `zone:*` tag, so untagged files have no zone and drop out when a
 * zone filter is active.
 */

import { useZwiftLibraryStore, type LibraryVersion } from '~/stores/zwiftLibrary'
import type { TimelineSeg } from '~/components/WorkoutTimeline.vue'

interface LibraryRow {
  id: number
  name: string
  path: string
  durationSec: number
  tss: number
  zone: string | null
  editable: boolean
  hasDraft: boolean
  stale: boolean
  updatedAt: string
  timeline: { segs: { d: number, a: number, b: number, t: 'f' | 's' }[], tot: number, ev: { at: number, text: string }[] }
}

interface OpenPayload {
  id: number
  path: string
  editable: boolean
  contentHash: string
  disk: LibraryVersion
  draft: (LibraryVersion & { baseHash: string }) | null
  stale: boolean
}

const props = defineProps<{ ftp: number }>()
const emit = defineEmits<{ close: [], open: [] }>()

const toast = useToast()
const store = useZwiftLibraryStore()

// ── Data ─────────────────────────────────────────────────────────────────

const rows = ref<LibraryRow[]>([])
const loading = ref(true)
const loadError = ref(false)

onMounted(async () => {
  try {
    const res = await $fetch<{ workouts: LibraryRow[] }>('/api/zwift/library')
    rows.value = res.workouts
  }
  catch {
    loadError.value = true
  }
  finally {
    loading.value = false
  }
})

// ── Filters ──────────────────────────────────────────────────────────────

const ZONE_CHIPS = [
  { value: 'ActiveRecovery', label: 'Recovery', tone: 'z1' },
  { value: 'Endurance', label: 'Endurance', tone: 'z2' },
  { value: 'Tempo', label: 'Tempo', tone: 'z3' },
  { value: 'SweetSpot', label: 'Sweet spot', tone: 'z4' },
  { value: 'Threshold', label: 'Threshold', tone: 'z4' },
  { value: 'VO2Max', label: 'VO2 max', tone: 'z5' },
  { value: 'Anaerobic', label: 'Anaerobic', tone: 'z6' },
  { value: 'Sprint', label: 'Sprint', tone: 'z6' },
] as const

const TONES: Record<string, { dot: string, bg: string, fg: string, border: string }> = {
  z1: { dot: '#9AA5B1', bg: '#f5f5f4', fg: '#78716c', border: '#e7e5e4' },
  z2: { dot: '#38BDF8', bg: '#e0f2fe', fg: '#0369a1', border: '#bae6fc' },
  z3: { dot: '#34D399', bg: '#d1fae5', fg: '#047857', border: '#a7f3d0' },
  z4: { dot: '#FBBF24', bg: '#fef9c3', fg: '#a16207', border: '#fef08a' },
  z5: { dot: '#FB923C', bg: '#ffedd5', fg: '#c2410c', border: '#fed7aa' },
  z6: { dot: '#F87171', bg: '#fee2e2', fg: '#b91c1c', border: '#fecaca' },
}

function zoneChip(zone: string | null) {
  return ZONE_CHIPS.find(z => z.value === zone) ?? null
}

const q = ref('')
const durMin = ref('')
const durMax = ref('')
const tssMin = ref('')
const tssMax = ref('')
const zone = ref<string | null>(null)

const digits = (v: string) => v.replace(/\D/g, '')
const bound = (v: string) => (v === '' ? null : Number(v))

const filtersActive = computed(() =>
  !!(q.value || durMin.value || durMax.value || tssMin.value || tssMax.value || zone.value),
)

function resetFilters() {
  q.value = ''
  durMin.value = durMax.value = tssMin.value = tssMax.value = ''
  zone.value = null
}

const filtered = computed(() => {
  const needle = q.value.trim().toLowerCase()
  const dMin = bound(durMin.value), dMax = bound(durMax.value)
  const tMin = bound(tssMin.value), tMax = bound(tssMax.value)
  return rows.value.filter((r) => {
    const mins = Math.round(r.durationSec / 60)
    if (needle && !r.name.toLowerCase().includes(needle) && !r.path.toLowerCase().includes(needle)) return false
    if (dMin !== null && mins < dMin) return false
    if (dMax !== null && mins > dMax) return false
    if (tMin !== null && r.tss < tMin) return false
    if (tMax !== null && r.tss > tMax) return false
    if (zone.value && r.zone !== zone.value) return false
    return true
  })
})

// ── Display helpers ──────────────────────────────────────────────────────

function fmtDuration(sec: number) {
  const mins = Math.round(sec / 60)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

// Row `updatedAt` is when the sync last wrote that row, so the newest one is
// the best available "last synced" signal.
const lastSyncedLabel = computed(() => {
  if (!rows.value.length) return null
  const newest = Math.max(...rows.value.map(r => new Date(r.updatedAt).getTime()))
  const mins = Math.max(0, Math.floor((Date.now() - newest) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
})

function toSegs(row: LibraryRow): TimelineSeg[] {
  return row.timeline.segs.map(s => ({ d: s.d, a: s.a, b: s.b, t: s.t }))
}

// ── Selection / open ─────────────────────────────────────────────────────

const selectedId = ref<number | null>(null)
const selected = computed(() => rows.value.find(r => r.id === selectedId.value) ?? null)

const openHint = computed(() => {
  const r = selected.value
  if (!r) return ''
  if (!r.editable) return 'Uses features the builder can\'t edit.'
  if (r.stale) return 'Draft and disk both changed. You choose in the builder.'
  if (r.hasDraft) return 'Opens your saved draft.'
  return 'Opens the file from disk.'
})

const opening = ref(false)

async function openInBuilder() {
  const r = selected.value
  if (!r || !r.editable || opening.value) return
  opening.value = true
  try {
    const data = await $fetch<OpenPayload>(`/api/zwift/library/${r.id}`)
    const shown = data.draft ?? data.disk
    store.setPendingOpen({
      workoutId: data.id,
      path: data.path,
      baseHash: data.contentHash,
      meta: shown.meta,
      blocks: shown.blocks,
      events: shown.events,
      hasDraft: !!data.draft,
      stale: data.stale,
      disk: data.disk,
    })
    emit('open')
  }
  catch {
    toast.add({ title: 'Could not open that workout', color: 'error' })
  }
  finally {
    opening.value = false
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') return emit('close')
  const inField = (e.target as HTMLElement | null)?.tagName === 'INPUT'
  if (inField) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const list = filtered.value
    if (!list.length) return
    e.preventDefault()
    const idx = list.findIndex(r => r.id === selectedId.value)
    const next = e.key === 'ArrowDown' ? Math.min(idx + 1, list.length - 1) : Math.max(idx - 1, 0)
    selectedId.value = list[idx === -1 ? 0 : next]!.id
    nextTick(() => document.querySelector('[data-lib-selected="true"]')?.scrollIntoView({ block: 'nearest' }))
  }
  else if (e.key === 'Enter' && selected.value) {
    e.preventDefault()
    openInBuilder()
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50"
      style="font-family: 'Hanken Grotesk', sans-serif;"
      role="dialog"
      aria-modal="true"
      aria-label="Workout library"
    >
      <div class="fixed inset-0 bg-black/25 backdrop-blur-sm" @click="emit('close')" />

      <aside
        class="absolute left-1/2 flex flex-col bg-white rounded-2xl overflow-hidden"
        style="top: 36px; transform: translateX(-50%); width: min(960px, calc(100% - 48px)); height: min(748px, calc(100vh - 72px)); box-shadow: 0 24px 60px rgba(28,25,23,.28);"
      >
        <!-- Header -->
        <div class="flex-none px-6 pt-[22px]">
          <div class="flex items-start justify-between">
            <div>
              <h2 style="font: 600 18px 'Hanken Grotesk'; color: #1c1917;">
                Workout library
              </h2>
              <p class="tabular" style="font: 400 14px 'Hanken Grotesk'; color: #a8a29e;">
                Zwift/Workouts · {{ rows.length }} {{ rows.length === 1 ? 'file' : 'files' }}
              </p>
            </div>
            <div class="flex items-center gap-[18px]">
              <p v-if="lastSyncedLabel" class="flex items-center gap-1.5 tabular" style="font: 500 12px 'Hanken Grotesk'; color: #a8a29e;">
                <UIcon name="i-heroicons-arrow-path" style="width: 14px; height: 14px;" />
                Last synced {{ lastSyncedLabel }}
              </p>
              <button
                aria-label="Close"
                class="cursor-pointer text-stone-300 hover:text-stone-500"
                style="background: none; border: none;"
                @click="emit('close')"
              >
                <UIcon name="i-heroicons-x-mark" class="block" style="width: 20px; height: 20px;" />
              </button>
            </div>
          </div>

          <!-- Row 1: search + ranges -->
          <div class="flex flex-wrap items-end gap-4 mt-[18px]">
            <div class="relative flex-1 min-w-[200px]">
              <UIcon name="i-heroicons-magnifying-glass" class="absolute" style="left: 14px; top: 13px; width: 18px; height: 18px; color: #a8a29e;" />
              <input
                v-model="q"
                type="text"
                placeholder="Search workouts"
                class="w-full outline-none search-input"
                style="height: 44px; border-radius: 12px; border: 1.5px solid #e7e5e4; background: #fafaf9; padding: 0 14px 0 42px; font: 500 15px 'Hanken Grotesk'; color: #1c1917;"
              >
            </div>
            <div class="w-[158px] flex-none">
              <p class="mb-1.5" style="font: 500 11px 'Hanken Grotesk'; letter-spacing: .08em; text-transform: uppercase; color: #a8a29e;">
                Duration (min)
              </p>
              <div class="flex items-center gap-1.5">
                <input :value="durMin" inputmode="numeric" placeholder="min" class="range-input" @input="durMin = digits(($event.target as HTMLInputElement).value)">
                <span style="color: #a8a29e;">–</span>
                <input :value="durMax" inputmode="numeric" placeholder="max" class="range-input" @input="durMax = digits(($event.target as HTMLInputElement).value)">
              </div>
            </div>
            <div class="w-[158px] flex-none">
              <p class="mb-1.5" style="font: 500 11px 'Hanken Grotesk'; letter-spacing: .08em; text-transform: uppercase; color: #a8a29e;">
                TSS
              </p>
              <div class="flex items-center gap-1.5">
                <input :value="tssMin" inputmode="numeric" placeholder="min" class="range-input" @input="tssMin = digits(($event.target as HTMLInputElement).value)">
                <span style="color: #a8a29e;">–</span>
                <input :value="tssMax" inputmode="numeric" placeholder="max" class="range-input" @input="tssMax = digits(($event.target as HTMLInputElement).value)">
              </div>
            </div>
          </div>

          <!-- Row 2: zone chips -->
          <div class="flex flex-wrap items-center gap-1.5 mt-[14px] mb-[16px]">
            <button
              v-for="z in ZONE_CHIPS"
              :key="z.value"
              class="inline-flex items-center cursor-pointer"
              :style="{
                height: '28px', gap: '7px', padding: '0 11px 0 9px', borderRadius: '9999px', font: `600 12px 'Hanken Grotesk'`,
                border: `1.5px solid ${zone === z.value ? '#fdba74' : '#e7e5e4'}`,
                background: zone === z.value ? '#fff7ed' : '#fff',
                color: zone === z.value ? '#ea580c' : '#57534e',
              }"
              @click="zone = zone === z.value ? null : z.value"
            >
              <span class="inline-block rounded-full" :style="{ width: '9px', height: '9px', background: TONES[z.tone]!.dot }" />
              {{ z.label }}
            </button>
            <button
              :disabled="!filtersActive"
              class="ml-auto flex-none"
              :class="filtersActive ? 'cursor-pointer' : 'cursor-default'"
              :style="{ font: `600 12px 'Hanken Grotesk'`, color: filtersActive ? '#ea580c' : '#d6d3d1', background: 'none', border: 'none', padding: '6px 0' }"
              @click="resetFilters"
            >
              Reset
            </button>
          </div>
        </div>

        <!-- Body: list + preview -->
        <div class="grid grid-cols-1 min-[900px]:grid-cols-[minmax(0,1fr)_300px] grid-rows-[minmax(0,1fr)] flex-1 min-h-0 border-t" style="border-color: #f0eeec;">
          <!-- List -->
          <div class="flex flex-col min-h-0 min-w-0">
            <div class="flex-none flex items-baseline justify-between px-6 py-3" style="border-bottom: 1px solid #f0eeec;">
              <span style="font: 600 11px 'Hanken Grotesk'; letter-spacing: .12em; text-transform: uppercase; color: #78716c;">Workouts</span>
              <span class="tabular whitespace-nowrap" style="font: 400 12px 'Hanken Grotesk'; color: #a8a29e;">{{ filtered.length }} of {{ rows.length }}</span>
            </div>

            <div class="flex-1 overflow-auto">
              <div v-if="loading" class="flex justify-center py-14">
                <BikeSpinner />
              </div>
              <div v-else-if="loadError" class="text-center py-14" style="font: 500 14px 'Hanken Grotesk'; color: #78716c;">
                Couldn't load the library.
              </div>
              <div v-else-if="filtered.length === 0" class="text-center py-14">
                <p style="font-size: 36px; color: #d6d3d1; line-height: 1;">○</p>
                <p class="mt-2" style="font: 500 14px 'Hanken Grotesk'; color: #78716c;">
                  {{ rows.length ? 'No matching workouts' : 'No workouts synced yet' }}
                </p>
                <p style="font: 400 12px 'Hanken Grotesk'; color: #a8a29e;">
                  {{ rows.length ? 'Adjust or reset the filters' : 'Run the Zwift sync daemon to mirror your folder' }}
                </p>
              </div>
              <ul v-else class="list-none m-0 p-0">
                <li
                  v-for="r in filtered"
                  :key="r.id"
                  :data-lib-selected="r.id === selectedId"
                  class="relative grid grid-cols-[128px_minmax(0,1fr)_auto] items-center gap-[18px] px-6 py-[14px] cursor-pointer row"
                  :class="{ 'row-selected': r.id === selectedId }"
                  style="border-top: 1px solid #f7f5f3;"
                  @click="selectedId = r.id"
                >
                  <span v-if="r.id === selectedId" class="absolute" style="left: 0; top: 12px; bottom: 12px; width: 3px; background: #ea580c; border-radius: 2px;" />
                  <div class="rounded-lg px-2 py-1.5" style="background: #fafaf9; border: 1px solid #f0eeec;">
                    <WorkoutTimeline :segs="toSegs(r)" :total="r.timeline.tot" :width="110" :height="38" mini />
                  </div>
                  <div class="min-w-0">
                    <p class="truncate" style="font: 600 16px 'Hanken Grotesk'; color: #292524;">
                      {{ r.name }}
                    </p>
                    <div class="flex flex-wrap items-center" style="gap: 6px;">
                      <span
                        v-if="zoneChip(r.zone)"
                        class="whitespace-nowrap"
                        :style="{
                          font: `600 12px 'Hanken Grotesk'`, borderRadius: '6px', padding: '1px 6px',
                          color: TONES[zoneChip(r.zone)!.tone]!.fg,
                          background: TONES[zoneChip(r.zone)!.tone]!.bg,
                          border: `1px solid ${TONES[zoneChip(r.zone)!.tone]!.border}`,
                        }"
                      >{{ zoneChip(r.zone)!.label }}</span>
                      <span v-if="r.hasDraft" class="inline-flex items-center whitespace-nowrap" style="gap: 3px; font: 600 12px 'Hanken Grotesk'; color: #7c3aed; background: #f5f3ff; border-radius: 6px; padding: 1px 6px;">
                        <UIcon name="i-heroicons-pencil" style="width: 11px; height: 11px;" />
                        edited
                      </span>
                    </div>
                    <p v-if="r.stale" class="flex items-center" style="gap: 4px; margin-top: 2px; font: 500 12px 'Hanken Grotesk'; color: #b45309;">
                      <UIcon name="i-heroicons-exclamation-triangle" style="width: 13px; height: 13px;" />
                      disk changed since your edit
                    </p>
                  </div>
                  <div class="flex items-center justify-end gap-3">
                    <span class="tabular text-right min-w-14" style="font: 500 14px 'Hanken Grotesk'; color: #78716c;">{{ fmtDuration(r.durationSec) }}</span>
                    <span class="tabular whitespace-nowrap text-center min-w-[52px]" style="font: 600 12px 'Hanken Grotesk'; color: #d97706; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 1px 6px;">{{ r.tss }} TSS</span>
                  </div>
                </li>
              </ul>
            </div>
          </div>

          <!-- Preview pane -->
          <div class="hidden min-[900px]:flex flex-col min-h-0 border-l" style="background: #fafaf9; border-color: #f0eeec;">
            <template v-if="selected">
              <div class="flex-1 min-h-0 overflow-auto p-5">
                <p style="font: 600 11px 'Hanken Grotesk'; letter-spacing: .12em; text-transform: uppercase; color: #78716c;">
                  Preview
                </p>
                <p class="mt-2" style="font: 600 18px 'Hanken Grotesk'; color: #292524;">
                  {{ selected.name }}
                </p>
                <p class="break-all" style="font: 400 12px 'Hanken Grotesk'; color: #a8a29e;">
                  {{ selected.path }}
                </p>
                <div class="flex gap-8 mt-4">
                  <div>
                    <p style="font: 500 11px 'Hanken Grotesk'; letter-spacing: .08em; text-transform: uppercase; color: #a8a29e;">
                      Duration
                    </p>
                    <p class="tabular" style="font: 700 22px 'Hanken Grotesk'; color: #292524;">
                      {{ fmtDuration(selected.durationSec) }}
                    </p>
                  </div>
                  <div>
                    <p style="font: 500 11px 'Hanken Grotesk'; letter-spacing: .08em; text-transform: uppercase; color: #a8a29e;">
                      TSS
                    </p>
                    <p class="tabular" style="font: 700 22px 'Hanken Grotesk'; color: #292524;">
                      {{ selected.tss }}
                    </p>
                  </div>
                </div>
                <div class="mt-4 bg-white rounded-xl p-3" style="border: 1px solid #f0eeec;">
                  <WorkoutTimeline :segs="toSegs(selected)" :events="selected.timeline.ev" :total="selected.timeline.tot" :width="254" :height="120" :ftp="props.ftp" compact />
                </div>
              </div>
              <div class="flex-none p-5 pt-4">
                <button
                  :disabled="!selected.editable || opening"
                  class="open-btn w-full"
                  :class="!selected.editable || opening ? 'cursor-not-allowed' : 'cursor-pointer'"
                  :style="{ opacity: !selected.editable || opening ? 0.5 : 1 }"
                  @click="openInBuilder"
                >
                  Open in builder
                </button>
                <p class="mt-2 text-center" style="font: 400 12px 'Hanken Grotesk'; color: #a8a29e;">
                  {{ openHint }}
                </p>
              </div>
            </template>
            <div v-else class="flex-1 flex items-center justify-center p-5 text-center" style="font: 400 13px 'Hanken Grotesk'; color: #a8a29e;">
              Select a workout to preview
            </div>
          </div>
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.search-input:focus { border-color: #ea580c; }
.range-input {
  width: 100%;
  min-width: 0;
  border: 1.5px solid #e7e5e4;
  border-radius: 9px;
  padding: 9px;
  font: 500 14px 'Hanken Grotesk';
  font-variant-numeric: tabular-nums;
  color: #1c1917;
  background: #fff;
  outline: none;
}
.range-input:focus { border-color: #ea580c; }
.row:hover,
.row-selected { background: #faf9f7; }
.open-btn {
  font: 600 14px 'Hanken Grotesk';
  color: #fff;
  background: #ea580c;
  border: none;
  border-radius: 9px;
  padding: 11px 16px;
}
.open-btn:not(:disabled):hover { background: #c2410c; }
</style>
