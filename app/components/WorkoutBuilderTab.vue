<script setup lang="ts">
/**
 * Workout builder tab
 *
 * Lets the user compose a structured cycling workout (warm up, cool down,
 * steady-power blocks, on/off intervals) on a zone-colored timeline, see
 * live Duration/TSS totals, edit blocks inline via a stepper popover, and
 * export the result as a Zwift `.zwo` file.
 *
 * Single source of truth is local component state. Two things cross the
 * component boundary: the AI-coach hand-off (`coach` store) and the Zwift
 * library (`zwiftLibrary` store + panel), which can open a mirrored `.zwo` for
 * editing — saved as a server-side *draft*, never written back to the file.
 */

import { useCoachStore } from '~/stores/coach'
import { usePlanningStore } from '~/stores/planning'
import { useZwiftLibraryStore, type LibraryPendingOpen, type LibraryVersion } from '~/stores/zwiftLibrary'
import type { ZwoBlock, ZwoMeta, ZwoZoneName } from '#shared/utils/zwo'

// ── Data model ───────────────────────────────────────────────────────────

type RampBlock = { id: number, type: 'warmup' | 'cooldown', duration: number, powerStart: number, powerEnd: number, cadence: number | null }
type SteadyBlock = { id: number, type: 'steady', duration: number, power: number, cadence: number | null }
type IntervalBlock = { id: number, type: 'interval', reps: number, onDuration: number, onPower: number, onCadence: number | null, offDuration: number, offPower: number, offCadence: number | null }
type FreeRideBlock = { id: number, type: 'freeride', duration: number, flatRoad: boolean, ftpTest: boolean }
type Block = RampBlock | SteadyBlock | IntervalBlock | FreeRideBlock

/** A text cue on the absolute timeline (seconds from workout start). */
interface TextEvent { id: number, at: number, text: string, attrs: Record<string, string> }

// ── Zone config ──────────────────────────────────────────────────────────

const ZONES = [
  { label: 'Z1', name: 'Recovery', range: '<55% FTP', max: 0.55, color: '#9AA5B1', midpoint: 0.45 },
  { label: 'Z2', name: 'Endurance', range: '55–75% FTP', max: 0.75, color: '#38BDF8', midpoint: 0.65 },
  { label: 'Z3', name: 'Tempo', range: '75–90% FTP', max: 0.90, color: '#34D399', midpoint: 0.825 },
  { label: 'Z4', name: 'Threshold', range: '90–105% FTP', max: 1.05, color: '#FBBF24', midpoint: 0.975 },
  { label: 'Z5', name: 'VO2 max', range: '105–120% FTP', max: 1.20, color: '#FB923C', midpoint: 1.125 },
  { label: 'Z6', name: 'Anaerobic', range: '120%+ FTP', max: Infinity, color: '#F87171', midpoint: 1.3 },
]

// Toolbar chips: Z1–Z6 plus Sweet spot (88–94% FTP, steady at the midpoint)
// between Z4 and Z5.
const ZONE_CHIPS = [
  ...ZONES.slice(0, 4).map(z => ({ key: z.label, label: z.label, color: z.color, power: z.midpoint, title: `${z.label} · ${z.name} · ${z.range}` })),
  { key: 'SS', label: 'SS', color: '#FBBF24', power: 0.91, title: 'Sweet spot · 88–94% FTP' },
  ...ZONES.slice(4).map(z => ({ key: z.label, label: z.label, color: z.color, power: z.midpoint, title: `${z.label} · ${z.name} · ${z.range}` })),
]

// ── State ────────────────────────────────────────────────────────────────

const title = ref('')

// Optional `zone:<Name>` tag written into the .zwo on download (the library's zone filter reads it).
const ZONE_TYPES = [
  { value: 'ActiveRecovery', label: 'Recovery', dot: '#9AA5B1' },
  { value: 'Endurance', label: 'Endurance', dot: '#38BDF8' },
  { value: 'Tempo', label: 'Tempo', dot: '#34D399' },
  { value: 'SweetSpot', label: 'Sweet spot', dot: '#FBBF24' },
  { value: 'Threshold', label: 'Threshold', dot: '#FBBF24' },
  { value: 'VO2Max', label: 'VO2 max', dot: '#FB923C' },
  { value: 'Anaerobic', label: 'Anaerobic', dot: '#F87171' },
  { value: 'Sprint', label: 'Sprint', dot: '#F87171' },
] as const satisfies readonly { value: ZwoZoneName, label: string, dot: string }[]

const zoneType = ref<ZwoZoneName | null>(null)
const zoneTypeSelected = computed(() => ZONE_TYPES.find(z => z.value === zoneType.value) ?? null)
const zoneTypeItems = computed(() => [
  ...ZONE_TYPES.map(z => ({
    label: z.label,
    value: z.value,
    dot: z.dot,
    selected: z.value === zoneType.value,
    onSelect: () => { zoneType.value = z.value },
  })),
  { label: 'No type', value: null, dot: '', selected: zoneType.value === null, onSelect: () => { zoneType.value = null } },
])
const ftp = ref(240)

// Seed FTP from the athlete's most recent logged value (same field HistoryTab
// shows) so the builder doesn't default to a stale/generic number. Still a
// plain local ref after that — the user can override it and it won't be
// clobbered, matching this component's "local state only" design.
const { data: currentFtpData } = useFetch<{ currentFtp: number | null }>('/api/history')
watch(currentFtpData, (data) => {
  if (data?.currentFtp) ftp.value = data.currentFtp
}, { immediate: true })

const nextId = ref(1)
const selectedId = ref<number | null>(null)
const blocks = ref<Block[]>([])

// ── Current week summary (reminder of what's already planned) ──────────────
// planning.plans is the 4-week grid starting at the current Monday (see
// stores/planning.ts), so the first 7 entries are this week.
const planning = usePlanningStore()
onMounted(() => planning.fetchPlans())

const currentWeekPlan = computed(() =>
  planning.plans.slice(0, 7).filter(day => day.plan && (day.plan.name || day.plan.tss || day.plan.durationMinutes)),
)

function weekSummaryDateLabel(dateStr: string) {
  const d = new Date(`${dateStr}T00:00`)
  return d.toLocaleDateString('en-US', { weekday: 'short' })
}

function isToday(dateStr: string) {
  return dateStr === todayLocalDate()
}

function weekSummaryDurationLabel(mins: number | null) {
  if (!mins) return '—'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

// ── Fuelling guide + save-to-planned-workout ────────────────────────────

const fuellingNotes = ref('')

// Today's date as YYYY-MM-DD (local time) — matches the format planned_workouts
// and the training log use elsewhere (see todayStr in [[tab]].vue).
function todayLocalDate() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const saveDate = ref(todayLocalDate())
const isSaving = ref(false)
const toast = useToast()

// Consumed the same way as the `planName` query param above — this tab is
// remounted on navigation (see the comment on that block, and on
// useCoachStore itself), so a pending AI-generated workout is read from the
// store on setup rather than passed via a prop/ref call from the parent.
const coach = useCoachStore()
const pendingWorkout = coach.consumePendingWorkout()
if (pendingWorkout) {
  title.value = pendingWorkout.name
  fuellingNotes.value = pendingWorkout.fuellingGuide
  blocks.value = pendingWorkout.blocks.map((b) => {
    const block = { ...b, id: nextId.value } as Block
    nextId.value += 1
    return block
  })
}

async function saveToPlannedWorkout() {
  isSaving.value = true
  try {
    await $fetch('/api/planned-workouts', {
      method: 'PUT',
      body: {
        date: saveDate.value,
        name: title.value || null,
        // No `type` here: AI-generated/manually-built workouts mix zones, so this
        // save shouldn't classify one — and omitting the key (rather than sending
        // `type: null`) lets the PUT endpoint preserve whatever zone type is
        // already set for this date (e.g. from the Planning tab).
        tss: totalTSS.value,
        durationMinutes: Math.round(totalDuration.value / 60),
        notes: fuellingNotes.value || null,
      },
    })
    toast.add({ title: 'Saved to planned workout', color: 'success' })
  }
  catch {
    toast.add({ title: 'Could not save planned workout', color: 'error' })
  }
  finally {
    isSaving.value = false
  }
}

// ── Formatting ───────────────────────────────────────────────────────────

function fmtClock(totalSecIn: number) {
  const totalSec = Math.max(0, Math.round(totalSecIn))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function powerLabel(pct: number) {
  return `${Math.round(pct * 100)}% · ${Math.round(pct * ftp.value)}W`
}

function cadenceLabel(cadence: number | null) {
  return cadence ? `${cadence} rpm` : '—'
}

// ── Segments (derived) ───────────────────────────────────────────────────
// Every block type reduces to one or more ramp segments — a flat top is
// just a ramp whose start/end power are equal. The reduction itself lives in
// shared/utils/zwo.ts (zwoSegments) so the library thumbnails, the server's
// TSS estimate and this chart can't disagree.

const segments = computed(() =>
  zwoSegments(blocks.value).map(s => ({
    blockId: blocks.value[s.blockIndex]!.id,
    duration: s.duration,
    powerStart: s.powerStart,
    powerEnd: s.powerEnd,
    free: s.free,
  })),
)

const timelineSegs = computed(() =>
  segments.value.map(s => ({
    d: s.duration,
    a: s.powerStart,
    b: s.powerEnd,
    t: s.free ? 'f' as const : 's' as const,
    blockId: s.blockId,
  })),
)

const totalDuration = computed(() => segments.value.reduce((s, x) => s + x.duration, 0))
const totalDurationLabel = computed(() => fmtClock(totalDuration.value))

// Same Coggan-NP estimate the library list shows for this file (FreeRide is
// assumed at FREERIDE_IF of FTP), so a workout's TSS reads the same in both.
const totalTSS = computed(() => estimateTss(blocks.value))

// ── Chart geometry ───────────────────────────────────────────────────────

const chartHeight = 280
const POPOVER_WIDTH = 280

// Visible chart width tracks the scroll container's actual rendered width
// (the design's 938px was tuned to its own canvas — we measure ours instead).
const chartScrollEl = ref<HTMLElement | null>(null)
const visibleWidth = ref(640)
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (!chartScrollEl.value) return
  resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width
    if (width) visibleWidth.value = Math.max(width, 200)
  })
  resizeObserver.observe(chartScrollEl.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
})

// The edit popover is absolutely positioned inside the chart wrapper, so its
// own height doesn't naturally reserve space — for tall popovers (intervals,
// with 7 rows) that pushed the popover bottom past the wrapper, forcing the
// whole page to scroll. We measure its real rendered height and grow the
// wrapper to fit, so the timeline card just gets taller instead.
const popoverEl = ref<HTMLElement | null>(null)
const popoverHeight = ref(0)
const POPOVER_TOP = 12
let popoverResizeObserver: ResizeObserver | null = null

watch(popoverEl, (el) => {
  popoverResizeObserver?.disconnect()
  popoverResizeObserver = null
  if (!el) {
    popoverHeight.value = 0
    return
  }
  popoverResizeObserver = new ResizeObserver((entries) => {
    // contentRect excludes the popover's own padding — use offsetHeight
    // (border-box, matches actual rendered height) so the reserved space
    // isn't ~32px short of what the popover really occupies.
    const height = (entries[0]?.target as HTMLElement | undefined)?.offsetHeight
    if (height) popoverHeight.value = height
  })
  popoverResizeObserver.observe(el)
})

onBeforeUnmount(() => {
  popoverResizeObserver?.disconnect()
})

const chartAreaMinHeight = computed(() => {
  const rulerHeight = ruler.height + ruler.marginTop
  const baseHeight = chartHeight + rulerHeight + (events.value.length ? EVENT_ROW_HEIGHT : 0)
  if (!selectedBlock.value) return baseHeight
  return Math.max(baseHeight, POPOVER_TOP + popoverHeight.value + 16)
})

const scaleMax = computed(() => {
  const maxPower = segments.value.reduce((m, x) => Math.max(m, x.powerStart, x.powerEnd), 0.5)
  return Math.max(1.3, maxPower + 0.15)
})

const durForScale = computed(() => Math.max(totalDuration.value, 600))
const pxPerSecond = computed(() => Math.max(visibleWidth.value / durForScale.value, 0.15))
const chartWidth = computed(() => Math.max(visibleWidth.value, durForScale.value * pxPerSecond.value))

const ruler = { height: 22, marginTop: 6 }
const EVENT_ROW_HEIGHT = 22

// Y-axis zone labels sit at each zone's upper boundary.
const axisZones = computed(() => {
  return ZONES
    .map(z => ({
      label: z.label,
      top: chartHeight - (Math.min(z.max, scaleMax.value) / scaleMax.value) * chartHeight,
    }))
    .filter(z => z.top >= 0 && z.top <= chartHeight)
})

function selectBlock(blockId: number | null) {
  selectedId.value = blockId
}

function clearSelection() {
  selectedId.value = null
}

// ── Selected block / popover ─────────────────────────────────────────────

const selectedBlock = computed(() => blocks.value.find(b => b.id === selectedId.value) ?? null)

const popoverLeft = computed(() => {
  const id = selectedId.value
  if (id == null) return 0
  let cursor = 0
  let minLeft = Infinity
  let maxRight = -Infinity
  for (const seg of segments.value) {
    if (seg.blockId === id) {
      minLeft = Math.min(minLeft, cursor * pxPerSecond.value)
      maxRight = Math.max(maxRight, (cursor + seg.duration) * pxPerSecond.value)
    }
    cursor += seg.duration
  }
  if (!Number.isFinite(minLeft)) return 0
  const center = (minLeft + maxRight) / 2
  return Math.max(0, Math.min(center - POPOVER_WIDTH / 2, visibleWidth.value - POPOVER_WIDTH))
})

// ── Block mutations ──────────────────────────────────────────────────────

function bumpPower(id: number, field: string, delta: number) {
  const b = blocks.value.find(x => x.id === id) as Record<string, unknown> | undefined
  if (!b) return
  const v = Math.max(0.2, Math.min(2.0, ((b[field] as number) || 0) + delta))
  b[field] = Math.round(v * 100) / 100
  if (isPowerDraft(id, field)) powerDraft.value = null
}

function bumpDuration(id: number, field: string, delta: number) {
  const b = blocks.value.find(x => x.id === id) as Record<string, unknown> | undefined
  if (!b) return
  b[field] = Math.max(5, ((b[field] as number) || 0) + delta)
  if (isHmsDraft(id, field)) hmsDraft.value = null
}

function bumpCadence(id: number, field: string, delta: number) {
  const b = blocks.value.find(x => x.id === id) as Record<string, unknown> | undefined
  if (!b) return
  const cur = (b[field] as number) || 80
  b[field] = Math.max(0, Math.min(140, cur + delta))
}

// ── Direct input editing (duration as h:m:s, power in watts or %) ────────

function powerWatts(power: number) {
  return Math.round(power * ftp.value)
}

function blockField(id: number, field: string): number {
  const b = blocks.value.find(x => x.id === id) as Record<string, unknown> | undefined
  return (b?.[field] as number) ?? 0
}

function splitHms(totalSeconds: number) {
  const t = Math.max(0, Math.round(totalSeconds))
  return { h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 }
}

// Live-typed h/m/s parts live in a draft keyed to the field being edited, so
// typing into one part doesn't clobber the other two mid-edit. Committed
// (blur) into the block's total-seconds field with the same min-5s floor as
// before, falling back to 30s (the design's stated default) if all three
// parts are empty/zero rather than collapsing to a 0s block.
interface HmsDraft { id: number, field: string, h: number, m: number, s: number }
const hmsDraft = ref<HmsDraft | null>(null)

function isHmsDraft(id: number, field: string) {
  return hmsDraft.value?.id === id && hmsDraft.value?.field === field
}

function hmsPart(duration: number, id: number, field: string, part: 'h' | 'm' | 's') {
  return isHmsDraft(id, field) ? hmsDraft.value![part] : splitHms(duration)[part]
}

function onHmsInput(e: Event, id: number, field: string, part: 'h' | 'm' | 's') {
  const raw = (e.target as HTMLInputElement).valueAsNumber
  const val = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0
  const base = isHmsDraft(id, field) ? hmsDraft.value! : { id, field, ...splitHms(blockField(id, field)) }
  hmsDraft.value = { ...base, [part]: val }
}

function onHmsCommit(id: number, field: string) {
  if (!isHmsDraft(id, field)) return
  const { h, m, s } = hmsDraft.value!
  const total = h * 3600 + m * 60 + s
  const b = blocks.value.find(x => x.id === id) as Record<string, unknown> | undefined
  if (b) b[field] = total > 0 ? Math.max(5, total) : 30
  hmsDraft.value = null
}

// Power is stored as a single fraction of FTP, but the watts and % fields
// each edit it directly — the draft holds that shared un-rounded fraction
// so a keystroke in either field is reflected live in the other, and only
// commits into the block (with min/max clamping) on blur.
interface PowerDraft { id: number, field: string, fraction: number }
const powerDraft = ref<PowerDraft | null>(null)

function isPowerDraft(id: number, field: string) {
  return powerDraft.value?.id === id && powerDraft.value?.field === field
}

function powerFieldWatts(power: number, id: number, field: string) {
  return isPowerDraft(id, field) ? Math.round(powerDraft.value!.fraction * ftp.value) : powerWatts(power)
}

function powerFieldPercent(power: number, id: number, field: string) {
  return isPowerDraft(id, field) ? Math.round(powerDraft.value!.fraction * 100) : Math.round(power * 100)
}

function onPowerWattsInput(e: Event, id: number, field: string) {
  const watts = (e.target as HTMLInputElement).valueAsNumber
  const fraction = ftp.value > 0 && Number.isFinite(watts) ? watts / ftp.value : 0
  powerDraft.value = { id, field, fraction }
}

function onPowerPercentInput(e: Event, id: number, field: string) {
  const pct = (e.target as HTMLInputElement).valueAsNumber
  powerDraft.value = { id, field, fraction: Number.isFinite(pct) ? pct / 100 : 0 }
}

function onPowerCommit(id: number, field: string) {
  if (!isPowerDraft(id, field)) return
  const b = blocks.value.find(x => x.id === id) as Record<string, unknown> | undefined
  if (b) b[field] = Math.round(Math.min(2.0, Math.max(0.2, powerDraft.value!.fraction)) * 100) / 100
  powerDraft.value = null
}

function bumpReps(id: number, delta: number) {
  const b = blocks.value.find(x => x.id === id)
  if (!b || b.type !== 'interval') return
  b.reps = Math.max(1, Math.min(50, b.reps + delta))
}

function moveBlock(id: number, dir: -1 | 1) {
  const idx = blocks.value.findIndex(b => b.id === id)
  const newIdx = idx + dir
  if (idx < 0 || newIdx < 0 || newIdx >= blocks.value.length) return
  const arr = [...blocks.value]
  const [item] = arr.splice(idx, 1)
  arr.splice(newIdx, 0, item!)
  blocks.value = arr
}

function duplicateBlock(id: number) {
  const idx = blocks.value.findIndex(b => b.id === id)
  if (idx < 0) return
  const copy = { ...blocks.value[idx]!, id: nextId.value }
  const arr = [...blocks.value]
  arr.splice(idx + 1, 0, copy)
  blocks.value = arr
  nextId.value += 1
  selectedId.value = copy.id
}

function deleteBlock(id: number) {
  blocks.value = blocks.value.filter(b => b.id !== id)
  if (selectedId.value === id) selectedId.value = null
}

function addBlock(type: 'warmup' | 'cooldown' | 'interval') {
  let block: Block
  if (type === 'warmup') block = { id: nextId.value, type: 'warmup', duration: 300, powerStart: 0.5, powerEnd: 0.7, cadence: null }
  else if (type === 'cooldown') block = { id: nextId.value, type: 'cooldown', duration: 300, powerStart: 0.65, powerEnd: 0.45, cadence: null }
  else block = { id: nextId.value, type: 'interval', reps: 4, onDuration: 180, onPower: 1.0, onCadence: null, offDuration: 120, offPower: 0.55, offCadence: null }
  blocks.value = [...blocks.value, block]
  nextId.value += 1
  selectedId.value = block.id
}

function addSteady(pct: number) {
  const block: Block = { id: nextId.value, type: 'steady', duration: 300, power: pct, cadence: null }
  blocks.value = [...blocks.value, block]
  nextId.value += 1
  selectedId.value = block.id
}

function addFreeRide() {
  const block: Block = { id: nextId.value, type: 'freeride', duration: 300, flatRoad: false, ftpTest: false }
  blocks.value = [...blocks.value, block]
  nextId.value += 1
  selectedId.value = block.id
}

function clearWorkout() {
  blocks.value = []
  events.value = []
  selectedId.value = null
  exitLibraryEditing()
}

// ── Text events ──────────────────────────────────────────────────────────
// Cues drawn as a dashed pin + label on the chart. Stored in absolute seconds;
// shared/utils/zwo.ts converts to/from per-block `timeoffset`s on load/save.

const events = ref<TextEvent[]>([])
const nextEventId = ref(1)

const timelineEvents = computed(() => events.value.map(e => ({ at: e.at, text: e.text })))

/** Start (seconds) of the selected block, else the workout start. */
function selectedBlockStart() {
  const id = selectedId.value
  if (id == null) return 0
  let cursor = 0
  for (const seg of segments.value) {
    if (seg.blockId === id) return cursor
    cursor += seg.duration
  }
  return 0
}

function addTextEvent() {
  if (!blocks.value.length) return
  events.value = [...events.value, { id: nextEventId.value, at: selectedBlockStart(), text: 'New cue', attrs: {} }]
  nextEventId.value += 1
}

function removeTextEvent(id: number) {
  events.value = events.value.filter(e => e.id !== id)
}

function clearTextEvents() {
  events.value = []
}

function eventTimeLabel(at: number) {
  return fmtClock(at)
}

// Accepts "m:ss", "h:mm:ss" or plain seconds.
function onEventTimeCommit(ev: TextEvent, raw: string) {
  const parts = raw.trim().split(':').map(Number)
  if (!parts.length || parts.some(n => !Number.isFinite(n) || n < 0)) return
  const seconds = parts.reduce((acc, n) => acc * 60 + n, 0)
  ev.at = Math.min(Math.round(seconds), Math.max(0, Math.round(totalDuration.value)))
  events.value = [...events.value].sort((a, b) => a.at - b.at)
}

// ── Library file editing ─────────────────────────────────────────────────
// Opened from the library panel via the zwiftLibrary store. The builder edits
// a local copy; "Save draft" PUTs it as the workout's draft and Download writes
// a .zwo named exactly like the original so it can be saved over it. Nothing
// here ever writes the mirrored file.

interface Editing { workoutId: number, path: string, baseHash: string }

const library = useZwiftLibraryStore()
const libraryOpen = ref(false)
const editing = ref<Editing | null>(null)
const libraryMeta = ref<ZwoMeta | null>(null)
const diskVersion = ref<LibraryVersion | null>(null)
const hasDraft = ref(false)
const stale = ref(false)
const baselineSig = ref('')

const editSig = computed(() => JSON.stringify({ t: title.value, z: zoneType.value, b: blocks.value, e: events.value }))
const dirty = computed(() => !!editing.value && editSig.value !== baselineSig.value)

const editingFileName = computed(() => editing.value?.path.split('/').pop() ?? '')

function stripId(b: Block): ZwoBlock {
  const { id: _id, ...rest } = b
  return rest as ZwoBlock
}

function loadVersion(v: { meta: ZwoMeta, blocks: ZwoBlock[], events: { at: number, text: string, attrs: Record<string, string> }[] }) {
  libraryMeta.value = v.meta
  title.value = v.meta.name
  zoneType.value = zoneFromTags(v.meta.tags)
  blocks.value = v.blocks.map(b => ({ ...b, id: nextId.value++ }) as Block)
  events.value = v.events.map(e => ({ ...e, id: nextEventId.value++ }))
  selectedId.value = null
  hmsDraft.value = null
  powerDraft.value = null
  baselineSig.value = editSig.value
}

function applyOpen(open: LibraryPendingOpen) {
  loadVersion(open)
  editing.value = { workoutId: open.workoutId, path: open.path, baseHash: open.baseHash }
  diskVersion.value = open.disk
  hasDraft.value = open.hasDraft
  stale.value = open.stale
  baselineSig.value = editSig.value
}

function applyPendingOpen() {
  const open = library.consumePendingOpen()
  if (open) applyOpen(open)
}

function onLibraryOpen() {
  libraryOpen.value = false
  applyPendingOpen()
}

onMounted(applyPendingOpen)

/** Drop the library-file context (banner, stale lock, baseline). A saved server-side draft is left intact. */
function exitLibraryEditing() {
  editing.value = null
  libraryMeta.value = null
  diskVersion.value = null
  hasDraft.value = false
  stale.value = false
  baselineSig.value = ''
  confirmingRevert.value = false
  clearTimeout(confirmTimer)
}

const isSavingDraft = ref(false)
const confirmingRevert = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | undefined

function buildXml() {
  const base: ZwoMeta = libraryMeta.value
    ? { ...libraryMeta.value, name: title.value }
    : { name: title.value, author: '', description: '', sportType: 'bike', tags: [], extraMeta: {} }
  // Replace any existing zone tag (even an invalid one) with the picked type; other tags ride along.
  const tags = base.tags.filter(t => !t.startsWith('zone:'))
  if (zoneType.value) tags.unshift(`zone:${zoneType.value}`)
  const meta: ZwoMeta = { ...base, tags }
  const withEvents = attachTextEvents(blocks.value.map(stripId), events.value.map(({ at, text, attrs }) => ({ at, text, attrs })))
  return serializeZwo(meta, withEvents)
}

async function saveDraft() {
  const ed = editing.value
  if (!ed || stale.value || isSavingDraft.value) return
  isSavingDraft.value = true
  try {
    const res = await $fetch<{ baseHash: string }>('/api/zwift/drafts', {
      method: 'PUT',
      body: { workoutId: ed.workoutId, baseHash: ed.baseHash, xml: buildXml() },
    })
    ed.baseHash = res.baseHash
    hasDraft.value = true
    baselineSig.value = editSig.value
    toast.add({ title: 'Draft saved', color: 'success' })
  }
  catch (e) {
    const status = (e as { statusCode?: number, status?: number }).statusCode ?? (e as { status?: number }).status
    toast.add({
      title: status === 409 ? 'The file on disk changed — reopen it from the library' : 'Could not save draft',
      color: 'error',
    })
  }
  finally {
    isSavingDraft.value = false
  }
}

async function revertToDisk() {
  const ed = editing.value
  if (!ed || !diskVersion.value || stale.value) return
  if (!confirmingRevert.value && (dirty.value || hasDraft.value)) {
    confirmingRevert.value = true
    clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => { confirmingRevert.value = false }, 4000)
    return
  }
  confirmingRevert.value = false
  clearTimeout(confirmTimer)
  try {
    if (hasDraft.value) await $fetch(`/api/zwift/drafts/${ed.workoutId}`, { method: 'DELETE' })
    loadVersion(diskVersion.value)
    hasDraft.value = false
    toast.add({ title: 'Reverted to the version on disk', color: 'success' })
  }
  catch {
    toast.add({ title: 'Could not revert', color: 'error' })
  }
}

onBeforeUnmount(() => clearTimeout(confirmTimer))

// Stale draft resolution — nothing is overwritten until the user picks one.
async function keepMyEdit() {
  const ed = editing.value
  if (!ed) return
  try {
    const res = await $fetch<{ baseHash: string }>(`/api/zwift/drafts/${ed.workoutId}/rebase`, { method: 'POST' })
    ed.baseHash = res.baseHash
    stale.value = false
    toast.add({ title: 'Draft re-based onto the current file on disk', color: 'success' })
  }
  catch {
    toast.add({ title: 'Could not re-base the draft', color: 'error' })
  }
}

async function discardMyEdit() {
  const ed = editing.value
  if (!ed || !diskVersion.value) return
  try {
    await $fetch(`/api/zwift/drafts/${ed.workoutId}`, { method: 'DELETE' })
    loadVersion(diskVersion.value)
    hasDraft.value = false
    stale.value = false
    toast.add({ title: 'Draft discarded. Showing the file on disk', color: 'success' })
  }
  catch {
    toast.add({ title: 'Could not discard the draft', color: 'error' })
  }
}

// ── Download (.zwo export) ───────────────────────────────────────────────

function download() {
  if (stale.value) return
  // Serialization lives in shared/utils/zwo.ts so the builder, the library
  // sync and the CLI scripts all write/read .zwo identically.
  const xml = buildXml()
  const fileName = editing.value
    ? editingFileName.value
    : `${(title.value || 'workout').replace(/[^a-z0-9]+/gi, '_')}.zwo`

  const blob = new Blob([xml], { type: 'application/xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)

  if (editing.value) {
    toast.add({ title: `Downloaded ${fileName}. Save it over the original in Zwift/Workouts.`, color: 'success' })
  }
}
</script>

<template>
  <div class="space-y-6" style="font-family: 'Hanken Grotesk', sans-serif;">
    <!-- ── Row 1: name + library, stat cards ───────────────────────────── -->
    <!-- Narrower than the timeline card below — stays put while the timeline widens. -->
    <div class="max-w-4xl mx-auto flex items-end gap-4 flex-wrap">
      <!-- Workout name + library entry -->
      <div class="flex items-end gap-3 flex-none">
        <!-- Optional workout type → `zone:*` tag on download -->
        <div class="flex-none">
          <label class="block mb-[7px]" style="font: 600 12px 'Hanken Grotesk'; color: #78716c; letter-spacing: .04em; text-transform: uppercase;">
            Type
          </label>
          <UDropdownMenu :items="zoneTypeItems" :content="{ align: 'start' }" :ui="{ content: 'w-44' }">
            <button
              type="button"
              class="type-btn inline-flex items-center cursor-pointer"
              style="gap: 8px; font: 600 15px 'Hanken Grotesk'; border: 1.5px solid #e7e5e4; border-radius: 10px; padding: 12px 12px 12px 14px; background: #fff;"
              :style="{ color: zoneTypeSelected ? '#1c1917' : '#a8a29e' }"
              aria-label="Workout type. Change"
            >
              <span
                class="flex-none rounded-full"
                :style="{ width: '10px', height: '10px', background: zoneTypeSelected?.dot ?? 'transparent', border: zoneTypeSelected ? 'none' : '1.5px dashed #d6d3d1' }"
              />
              <span style="min-width: 76px; text-align: left;">{{ zoneTypeSelected?.label ?? 'No type' }}</span>
              <UIcon name="i-heroicons-chevron-down" style="width: 14px; height: 14px; color: #a8a29e;" />
            </button>

            <template #item-leading="{ item }">
              <span
                v-if="item.dot"
                class="flex-none rounded-full"
                :style="{ width: '10px', height: '10px', background: item.dot }"
              />
            </template>
            <template #item-trailing="{ item }">
              <UIcon v-if="item.selected" name="i-heroicons-check" class="w-3 h-3 text-stone-500" />
            </template>
          </UDropdownMenu>
        </div>
        <div class="flex-none" style="width: 280px;">
          <label class="block mb-[7px]" style="font: 600 12px 'Hanken Grotesk'; color: #78716c; letter-spacing: .04em; text-transform: uppercase;">
            Workout name
          </label>
          <input
            v-model="title"
            type="text"
            placeholder="Name this workout"
            class="w-full outline-none"
            style="font: 600 15px 'Hanken Grotesk'; color: #1c1917; border: 1.5px solid #e7e5e4; border-radius: 10px; padding: 12px 14px; background: #fff;"
          >
        </div>
        <button
          class="library-pill inline-flex items-center cursor-pointer"
          :class="{ 'library-pill-active': libraryOpen }"
          style="height: 34px; gap: 7px; padding: 0 14px 0 11px; margin-bottom: 7px; border-radius: 9999px; font: 600 13px 'Hanken Grotesk';"
          @click="libraryOpen = true"
        >
          <UIcon name="i-heroicons-book-open" style="width: 16px; height: 16px;" />
          Library
        </button>
      </div>

      <div class="flex-1" />

      <!-- Stat cards -->
      <div class="flex gap-2 items-stretch flex-none">
        <div class="text-center bg-white" style="border: 1px solid #f0eeec; border-radius: 12px; padding: 9px 14px; min-width: 78px;">
          <p class="mb-[5px]" style="font: 600 11px 'Hanken Grotesk'; letter-spacing: .1em; text-transform: uppercase; color: #a8a29e;">
            Duration
          </p>
          <p class="tabular" style="font: 700 20px 'Hanken Grotesk'; color: #1c1917;">
            {{ totalDurationLabel }}
          </p>
        </div>
        <div class="text-center bg-white" style="border: 1px solid #f0eeec; border-radius: 12px; padding: 9px 14px; min-width: 70px;">
          <p class="mb-[5px]" style="font: 600 11px 'Hanken Grotesk'; letter-spacing: .1em; text-transform: uppercase; color: #a8a29e;">
            TSS
          </p>
          <p class="tabular" style="font: 700 20px 'Hanken Grotesk'; color: #1c1917;">
            {{ totalTSS }}
          </p>
        </div>
        <div class="text-center bg-white" style="border: 1px solid #f0eeec; border-radius: 12px; padding: 9px 12px; min-width: 70px;">
          <p class="mb-[5px]" style="font: 600 11px 'Hanken Grotesk'; letter-spacing: .1em; text-transform: uppercase; color: #a8a29e;">
            FTP (W)
          </p>
          <input
            v-model.number="ftp"
            type="number"
            min="1"
            class="tabular text-center outline-none"
            style="width: 62px; font: 700 18px 'Hanken Grotesk'; color: #1c1917; border: none; background: transparent; color-scheme: light;"
          >
        </div>
      </div>
    </div>

    <!-- ── Timeline card ────────────────────────────────────────────────── -->
    <div class="bg-white relative overflow-hidden" style="border: 1px solid #f0eeec; border-radius: 14px;">
      <!-- Editing-a-library-file banner -->
      <div
        v-if="editing"
        class="flex items-center gap-2.5"
        style="background: #fff7ed; border-bottom: 1px solid #ffedd5; padding: 10px 24px;"
      >
        <UIcon name="i-heroicons-pencil-square" class="flex-none" style="width: 16px; height: 16px; color: #ea580c;" />
        <span class="flex-none" style="font: 600 11px 'Hanken Grotesk'; letter-spacing: .12em; text-transform: uppercase; color: #c2410c;">Editing library file</span>
        <span class="truncate min-w-0" style="font: 500 13px 'Hanken Grotesk'; color: #78716c;">{{ editing.path }}</span>
        <span v-if="dirty" class="flex-none" style="font: 600 12px 'Hanken Grotesk'; color: #c2410c; background: #ffedd5; border-radius: 6px; padding: 1px 8px;">edited</span>
        <button
          class="revert-btn ml-auto inline-flex items-center flex-none whitespace-nowrap"
          :class="[{ 'revert-confirm': confirmingRevert }, stale ? 'locked' : 'cursor-pointer']"
          style="gap: 6px; font: 600 13px 'Hanken Grotesk'; border: none; border-radius: 8px; padding: 5px 10px;"
          :disabled="stale"
          @click="revertToDisk"
        >
          <UIcon name="i-heroicons-arrow-uturn-left" style="width: 15px; height: 15px;" />
          {{ confirmingRevert ? 'Confirm' : 'Revert to disk' }}
        </button>
      </div>

      <!-- Stale draft: disk changed under the edit and the two differ -->
      <div
        v-if="editing && stale"
        class="flex items-start gap-3"
        style="background: #fffbeb; border-bottom: 1px solid #fde68a; padding: 16px 24px;"
      >
        <UIcon name="i-heroicons-exclamation-triangle" class="flex-none" style="width: 20px; height: 20px; color: #d97706; margin-top: 1px;" />
        <div class="min-w-0">
          <p style="font: 600 15px 'Hanken Grotesk'; color: #92400e;">
            Disk changed since your edit
          </p>
          <p class="mt-1" style="font: 400 13px/1.5 'Hanken Grotesk'; color: #78716c;">
            The file was modified outside Sprocket after you started this draft, and your draft differs from the new version. Nothing is overwritten until you choose.
          </p>
          <div class="flex flex-wrap gap-2 mt-3">
            <button
              class="cursor-pointer"
              style="font: 600 13px 'Hanken Grotesk'; color: #fff; background: #ea580c; border: none; border-radius: 8px; padding: 8px 14px;"
              @click="keepMyEdit"
            >
              Keep my edit (re-base)
            </button>
            <button
              class="cursor-pointer"
              style="font: 600 13px 'Hanken Grotesk'; color: #57534e; background: #fff; border: 1.5px solid #e7e5e4; border-radius: 8px; padding: 7px 14px;"
              @click="discardMyEdit"
            >
              Discard my edit
            </button>
          </div>
        </div>
      </div>

      <div :style="{ padding: '24px 8px 16px 24px', opacity: editing && stale ? 0.55 : 1 }">
        <div class="flex">
          <!-- Y-axis -->
          <div
            class="relative flex-none"
            style="width: 34px;"
            :style="{ height: `${chartHeight}px`, marginTop: events.length ? `${EVENT_ROW_HEIGHT}px` : '0px' }"
          >
            <div
              v-for="az in axisZones"
              :key="az.label"
              class="absolute"
              style="font: 600 11px 'Hanken Grotesk'; color: #cbc8c4; transform: translateY(-50%);"
              :style="{ left: '0px', top: `${az.top}px` }"
            >
              {{ az.label }}
            </div>
          </div>

          <!-- Chart + popover wrapper -->
          <div
            ref="chartScrollEl"
            class="relative flex-1 min-w-0 no-scrollbar"
            style="overflow-x: auto;"
            :style="{ minHeight: `${chartAreaMinHeight}px` }"
          >
            <WorkoutTimeline
              :segs="timelineSegs"
              :events="timelineEvents"
              :total="durForScale"
              :width="chartWidth"
              :height="chartHeight"
              :ftp="ftp"
              :scale-max="scaleMax"
              :axis="false"
              :selected-id="selectedId"
              interactive
              @select="selectBlock"
            />

          <!-- Block edit popover -->
          <div
            v-if="selectedBlock"
            ref="popoverEl"
            class="absolute"
            style="background: #292524; border-radius: 14px; padding: 16px 18px; box-shadow: 0 16px 34px rgba(0,0,0,.3); z-index: 10;"
            :style="{ left: `${popoverLeft}px`, top: `${POPOVER_TOP}px`, width: `${POPOVER_WIDTH}px` }"
            @click.stop
          >
            <!-- Action row -->
            <div class="flex justify-end gap-2 mb-3.5">
              <button
                title="Move before previous"
                class="inline-flex items-center justify-center cursor-pointer text-white"
                style="width: 30px; height: 30px; border-radius: 50%; background: #44403c; border: none;"
                @click="moveBlock(selectedBlock.id, -1)"
              >
                <UIcon name="i-heroicons-arrow-left" class="h-4 w-4" />
              </button>
              <button
                title="Move after next"
                class="inline-flex items-center justify-center cursor-pointer text-white"
                style="width: 30px; height: 30px; border-radius: 50%; background: #44403c; border: none;"
                @click="moveBlock(selectedBlock.id, 1)"
              >
                <UIcon name="i-heroicons-arrow-right" class="h-4 w-4" />
              </button>
              <button
                title="Duplicate"
                class="inline-flex items-center justify-center cursor-pointer text-white"
                style="width: 30px; height: 30px; border-radius: 50%; background: #44403c; border: none;"
                @click="duplicateBlock(selectedBlock.id)"
              >
                <UIcon name="i-heroicons-square-2-stack" class="h-4 w-4" />
              </button>
              <button
                title="Delete"
                class="inline-flex items-center justify-center cursor-pointer text-white"
                style="width: 30px; height: 30px; border-radius: 50%; background: #7f1d1d; border: none;"
                @click="deleteBlock(selectedBlock.id)"
              >
                <UIcon name="i-heroicons-trash" class="h-4 w-4" />
              </button>
            </div>

            <!-- Steady fields -->
            <template v-if="selectedBlock.type === 'steady'">
              <div class="flex items-center justify-between mb-2.5">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Duration</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpDuration(selectedBlock.id, 'duration', -15)">–</button>
                  <div class="hms-input">
                    <input
                      type="number" step="1" min="0" class="tabular hms-field"
                      :value="hmsPart(selectedBlock.duration, selectedBlock.id, 'duration', 'h')"
                      @input="onHmsInput($event, selectedBlock.id, 'duration', 'h')"
                      @blur="onHmsCommit(selectedBlock.id, 'duration')"
                    >
                    <span class="hms-colon">:</span>
                    <input
                      type="number" step="1" min="0" max="59" class="tabular hms-field"
                      :value="hmsPart(selectedBlock.duration, selectedBlock.id, 'duration', 'm')"
                      @input="onHmsInput($event, selectedBlock.id, 'duration', 'm')"
                      @blur="onHmsCommit(selectedBlock.id, 'duration')"
                    >
                    <span class="hms-colon">:</span>
                    <input
                      type="number" step="1" min="0" max="59" class="tabular hms-field"
                      :value="hmsPart(selectedBlock.duration, selectedBlock.id, 'duration', 's')"
                      @input="onHmsInput($event, selectedBlock.id, 'duration', 's')"
                      @blur="onHmsCommit(selectedBlock.id, 'duration')"
                    >
                  </div>
                  <button class="stepper-btn" @click="bumpDuration(selectedBlock.id, 'duration', 15)">+</button>
                </div>
              </div>
              <div class="flex items-center justify-between mb-2.5">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Power</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'power', -0.01)">–</button>
                  <div class="unit-input">
                    <input
                      type="number" step="1" min="0" class="tabular unit-input-field"
                      :value="powerFieldWatts(selectedBlock.power, selectedBlock.id, 'power')"
                      @input="onPowerWattsInput($event, selectedBlock.id, 'power')"
                      @blur="onPowerCommit(selectedBlock.id, 'power')"
                    >
                    <span class="unit-input-suffix">W</span>
                  </div>
                  <div class="unit-input">
                    <input
                      type="number" step="1" min="0" class="tabular unit-input-field unit-input-field-pct"
                      :value="powerFieldPercent(selectedBlock.power, selectedBlock.id, 'power')"
                      @input="onPowerPercentInput($event, selectedBlock.id, 'power')"
                      @blur="onPowerCommit(selectedBlock.id, 'power')"
                    >
                    <span class="unit-input-suffix">%</span>
                  </div>
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'power', 0.01)">+</button>
                </div>
              </div>
              <div class="flex items-center justify-between">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Cadence</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpCadence(selectedBlock.id, 'cadence', -5)">–</button>
                  <span class="tabular stepper-value" style="min-width: 56px;">{{ cadenceLabel(selectedBlock.cadence) }}</span>
                  <button class="stepper-btn" @click="bumpCadence(selectedBlock.id, 'cadence', 5)">+</button>
                </div>
              </div>
            </template>

            <!-- Ramp fields (warmup / cooldown) -->
            <template v-else-if="selectedBlock.type === 'warmup' || selectedBlock.type === 'cooldown'">
              <div class="flex items-center justify-between mb-2.5">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Duration</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpDuration(selectedBlock.id, 'duration', -15)">–</button>
                  <div class="hms-input">
                    <input
                      type="number" step="1" min="0" class="tabular hms-field"
                      :value="hmsPart(selectedBlock.duration, selectedBlock.id, 'duration', 'h')"
                      @input="onHmsInput($event, selectedBlock.id, 'duration', 'h')"
                      @blur="onHmsCommit(selectedBlock.id, 'duration')"
                    >
                    <span class="hms-colon">:</span>
                    <input
                      type="number" step="1" min="0" max="59" class="tabular hms-field"
                      :value="hmsPart(selectedBlock.duration, selectedBlock.id, 'duration', 'm')"
                      @input="onHmsInput($event, selectedBlock.id, 'duration', 'm')"
                      @blur="onHmsCommit(selectedBlock.id, 'duration')"
                    >
                    <span class="hms-colon">:</span>
                    <input
                      type="number" step="1" min="0" max="59" class="tabular hms-field"
                      :value="hmsPart(selectedBlock.duration, selectedBlock.id, 'duration', 's')"
                      @input="onHmsInput($event, selectedBlock.id, 'duration', 's')"
                      @blur="onHmsCommit(selectedBlock.id, 'duration')"
                    >
                  </div>
                  <button class="stepper-btn" @click="bumpDuration(selectedBlock.id, 'duration', 15)">+</button>
                </div>
              </div>
              <div class="flex items-center justify-between mb-2.5">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Start power</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'powerStart', -0.01)">–</button>
                  <div class="unit-input">
                    <input
                      type="number" step="1" min="0" class="tabular unit-input-field"
                      :value="powerFieldWatts(selectedBlock.powerStart, selectedBlock.id, 'powerStart')"
                      @input="onPowerWattsInput($event, selectedBlock.id, 'powerStart')"
                      @blur="onPowerCommit(selectedBlock.id, 'powerStart')"
                    >
                    <span class="unit-input-suffix">W</span>
                  </div>
                  <div class="unit-input">
                    <input
                      type="number" step="1" min="0" class="tabular unit-input-field unit-input-field-pct"
                      :value="powerFieldPercent(selectedBlock.powerStart, selectedBlock.id, 'powerStart')"
                      @input="onPowerPercentInput($event, selectedBlock.id, 'powerStart')"
                      @blur="onPowerCommit(selectedBlock.id, 'powerStart')"
                    >
                    <span class="unit-input-suffix">%</span>
                  </div>
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'powerStart', 0.01)">+</button>
                </div>
              </div>
              <div class="flex items-center justify-between mb-2.5">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">End power</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'powerEnd', -0.01)">–</button>
                  <div class="unit-input">
                    <input
                      type="number" step="1" min="0" class="tabular unit-input-field"
                      :value="powerFieldWatts(selectedBlock.powerEnd, selectedBlock.id, 'powerEnd')"
                      @input="onPowerWattsInput($event, selectedBlock.id, 'powerEnd')"
                      @blur="onPowerCommit(selectedBlock.id, 'powerEnd')"
                    >
                    <span class="unit-input-suffix">W</span>
                  </div>
                  <div class="unit-input">
                    <input
                      type="number" step="1" min="0" class="tabular unit-input-field unit-input-field-pct"
                      :value="powerFieldPercent(selectedBlock.powerEnd, selectedBlock.id, 'powerEnd')"
                      @input="onPowerPercentInput($event, selectedBlock.id, 'powerEnd')"
                      @blur="onPowerCommit(selectedBlock.id, 'powerEnd')"
                    >
                    <span class="unit-input-suffix">%</span>
                  </div>
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'powerEnd', 0.01)">+</button>
                </div>
              </div>
              <div class="flex items-center justify-between">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Cadence</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpCadence(selectedBlock.id, 'cadence', -5)">–</button>
                  <span class="tabular stepper-value" style="min-width: 56px;">{{ cadenceLabel(selectedBlock.cadence) }}</span>
                  <button class="stepper-btn" @click="bumpCadence(selectedBlock.id, 'cadence', 5)">+</button>
                </div>
              </div>
            </template>

            <!-- FreeRide fields -->
            <template v-else-if="selectedBlock.type === 'freeride'">
              <div class="flex items-center justify-between">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Duration</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpDuration(selectedBlock.id, 'duration', -15)">–</button>
                  <div class="hms-input">
                    <input
                      type="number" step="1" min="0" class="tabular hms-field"
                      :value="hmsPart(selectedBlock.duration, selectedBlock.id, 'duration', 'h')"
                      @input="onHmsInput($event, selectedBlock.id, 'duration', 'h')"
                      @blur="onHmsCommit(selectedBlock.id, 'duration')"
                    >
                    <span class="hms-colon">:</span>
                    <input
                      type="number" step="1" min="0" max="59" class="tabular hms-field"
                      :value="hmsPart(selectedBlock.duration, selectedBlock.id, 'duration', 'm')"
                      @input="onHmsInput($event, selectedBlock.id, 'duration', 'm')"
                      @blur="onHmsCommit(selectedBlock.id, 'duration')"
                    >
                    <span class="hms-colon">:</span>
                    <input
                      type="number" step="1" min="0" max="59" class="tabular hms-field"
                      :value="hmsPart(selectedBlock.duration, selectedBlock.id, 'duration', 's')"
                      @input="onHmsInput($event, selectedBlock.id, 'duration', 's')"
                      @blur="onHmsCommit(selectedBlock.id, 'duration')"
                    >
                  </div>
                  <button class="stepper-btn" @click="bumpDuration(selectedBlock.id, 'duration', 15)">+</button>
                </div>
              </div>
            </template>

            <!-- Interval fields -->
            <template v-else-if="selectedBlock.type === 'interval'">
              <div class="flex items-center justify-between mb-3 pb-3" style="border-bottom: 1px solid #44403c;">
                <span style="font: 600 13px 'Hanken Grotesk'; color: #d6d3d1;">Repeats</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpReps(selectedBlock.id, -1)">–</button>
                  <span class="tabular stepper-value" style="min-width: 36px;">×{{ selectedBlock.reps }}</span>
                  <button class="stepper-btn" @click="bumpReps(selectedBlock.id, 1)">+</button>
                </div>
              </div>

              <p class="mb-2" style="font: 700 11px 'Hanken Grotesk'; text-transform: uppercase; letter-spacing: .08em; color: #f97316;">
                On
              </p>
              <div class="flex items-center justify-between mb-2">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Duration</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpDuration(selectedBlock.id, 'onDuration', -15)">–</button>
                  <div class="hms-input">
                    <input
                      type="number" step="1" min="0" class="tabular hms-field"
                      :value="hmsPart(selectedBlock.onDuration, selectedBlock.id, 'onDuration', 'h')"
                      @input="onHmsInput($event, selectedBlock.id, 'onDuration', 'h')"
                      @blur="onHmsCommit(selectedBlock.id, 'onDuration')"
                    >
                    <span class="hms-colon">:</span>
                    <input
                      type="number" step="1" min="0" max="59" class="tabular hms-field"
                      :value="hmsPart(selectedBlock.onDuration, selectedBlock.id, 'onDuration', 'm')"
                      @input="onHmsInput($event, selectedBlock.id, 'onDuration', 'm')"
                      @blur="onHmsCommit(selectedBlock.id, 'onDuration')"
                    >
                    <span class="hms-colon">:</span>
                    <input
                      type="number" step="1" min="0" max="59" class="tabular hms-field"
                      :value="hmsPart(selectedBlock.onDuration, selectedBlock.id, 'onDuration', 's')"
                      @input="onHmsInput($event, selectedBlock.id, 'onDuration', 's')"
                      @blur="onHmsCommit(selectedBlock.id, 'onDuration')"
                    >
                  </div>
                  <button class="stepper-btn" @click="bumpDuration(selectedBlock.id, 'onDuration', 15)">+</button>
                </div>
              </div>
              <div class="flex items-center justify-between mb-2">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Power</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'onPower', -0.01)">–</button>
                  <div class="unit-input">
                    <input
                      type="number" step="1" min="0" class="tabular unit-input-field"
                      :value="powerFieldWatts(selectedBlock.onPower, selectedBlock.id, 'onPower')"
                      @input="onPowerWattsInput($event, selectedBlock.id, 'onPower')"
                      @blur="onPowerCommit(selectedBlock.id, 'onPower')"
                    >
                    <span class="unit-input-suffix">W</span>
                  </div>
                  <div class="unit-input">
                    <input
                      type="number" step="1" min="0" class="tabular unit-input-field unit-input-field-pct"
                      :value="powerFieldPercent(selectedBlock.onPower, selectedBlock.id, 'onPower')"
                      @input="onPowerPercentInput($event, selectedBlock.id, 'onPower')"
                      @blur="onPowerCommit(selectedBlock.id, 'onPower')"
                    >
                    <span class="unit-input-suffix">%</span>
                  </div>
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'onPower', 0.01)">+</button>
                </div>
              </div>
              <div class="flex items-center justify-between mb-3">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Cadence</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpCadence(selectedBlock.id, 'onCadence', -5)">–</button>
                  <span class="tabular stepper-value" style="min-width: 56px;">{{ cadenceLabel(selectedBlock.onCadence) }}</span>
                  <button class="stepper-btn" @click="bumpCadence(selectedBlock.id, 'onCadence', 5)">+</button>
                </div>
              </div>

              <p class="mb-2" style="font: 700 11px 'Hanken Grotesk'; text-transform: uppercase; letter-spacing: .08em; color: #78716c;">
                Off
              </p>
              <div class="flex items-center justify-between mb-2">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Duration</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpDuration(selectedBlock.id, 'offDuration', -15)">–</button>
                  <div class="hms-input">
                    <input
                      type="number" step="1" min="0" class="tabular hms-field"
                      :value="hmsPart(selectedBlock.offDuration, selectedBlock.id, 'offDuration', 'h')"
                      @input="onHmsInput($event, selectedBlock.id, 'offDuration', 'h')"
                      @blur="onHmsCommit(selectedBlock.id, 'offDuration')"
                    >
                    <span class="hms-colon">:</span>
                    <input
                      type="number" step="1" min="0" max="59" class="tabular hms-field"
                      :value="hmsPart(selectedBlock.offDuration, selectedBlock.id, 'offDuration', 'm')"
                      @input="onHmsInput($event, selectedBlock.id, 'offDuration', 'm')"
                      @blur="onHmsCommit(selectedBlock.id, 'offDuration')"
                    >
                    <span class="hms-colon">:</span>
                    <input
                      type="number" step="1" min="0" max="59" class="tabular hms-field"
                      :value="hmsPart(selectedBlock.offDuration, selectedBlock.id, 'offDuration', 's')"
                      @input="onHmsInput($event, selectedBlock.id, 'offDuration', 's')"
                      @blur="onHmsCommit(selectedBlock.id, 'offDuration')"
                    >
                  </div>
                  <button class="stepper-btn" @click="bumpDuration(selectedBlock.id, 'offDuration', 15)">+</button>
                </div>
              </div>
              <div class="flex items-center justify-between mb-2">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Power</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'offPower', -0.01)">–</button>
                  <div class="unit-input">
                    <input
                      type="number" step="1" min="0" class="tabular unit-input-field"
                      :value="powerFieldWatts(selectedBlock.offPower, selectedBlock.id, 'offPower')"
                      @input="onPowerWattsInput($event, selectedBlock.id, 'offPower')"
                      @blur="onPowerCommit(selectedBlock.id, 'offPower')"
                    >
                    <span class="unit-input-suffix">W</span>
                  </div>
                  <div class="unit-input">
                    <input
                      type="number" step="1" min="0" class="tabular unit-input-field unit-input-field-pct"
                      :value="powerFieldPercent(selectedBlock.offPower, selectedBlock.id, 'offPower')"
                      @input="onPowerPercentInput($event, selectedBlock.id, 'offPower')"
                      @blur="onPowerCommit(selectedBlock.id, 'offPower')"
                    >
                    <span class="unit-input-suffix">%</span>
                  </div>
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'offPower', 0.01)">+</button>
                </div>
              </div>
              <div class="flex items-center justify-between">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Cadence</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpCadence(selectedBlock.id, 'offCadence', -5)">–</button>
                  <span class="tabular stepper-value" style="min-width: 56px;">{{ cadenceLabel(selectedBlock.offCadence) }}</span>
                  <button class="stepper-btn" @click="bumpCadence(selectedBlock.id, 'offCadence', 5)">+</button>
                </div>
              </div>
            </template>
          </div>

          </div>
        </div>

        <!-- Text events -->
        <div v-if="events.length" class="mt-4 pt-3 space-y-2" style="border-top: 1px solid #f0eeec;">
          <p style="font: 600 11px 'Hanken Grotesk'; letter-spacing: .1em; text-transform: uppercase; color: #a8a29e;">
            Text events
          </p>
          <div v-for="ev in events" :key="ev.id" class="flex items-center gap-2">
            <input
              :value="eventTimeLabel(ev.at)"
              class="tabular text-center outline-none event-field"
              style="width: 72px;"
              aria-label="Time"
              @change="onEventTimeCommit(ev, ($event.target as HTMLInputElement).value)"
            >
            <input
              v-model="ev.text"
              type="text"
              class="outline-none event-field flex-1 min-w-0"
              aria-label="Message"
            >
            <button
              title="Remove text event"
              class="cursor-pointer event-remove"
              style="background: none; border: none; color: #a8a29e;"
              @click="removeTextEvent(ev.id)"
            >
              <UIcon name="i-heroicons-x-mark" class="block" style="width: 16px; height: 16px;" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Toolbar (left) + actions (right) ─────────────────────────────── -->
    <div class="max-w-3xl mx-auto flex items-start justify-between gap-8" style="padding-bottom: 44px;">
      <div class="flex flex-col gap-2.5 min-w-0" style="width: max-content; max-width: 100%;">
        <!-- Row 1: block adders, FreeRide, text events, clear -->
        <div class="flex flex-wrap items-center justify-between gap-2">
          <button
            title="Warm up"
            class="tool-chip"
            style="width: 38px;"
            @click="addBlock('warmup')"
          >
            <svg viewBox="0 0 20 14" width="18" height="13" fill="none" stroke="#34D399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12 L19 2" /></svg>
          </button>
          <button
            title="Cool down"
            class="tool-chip"
            style="width: 38px;"
            @click="addBlock('cooldown')"
          >
            <svg viewBox="0 0 20 14" width="18" height="13" fill="none" stroke="#9AA5B1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 2 L19 12" /></svg>
          </button>
          <button
            title="Interval"
            class="tool-chip"
            style="width: 38px;"
            @click="addBlock('interval')"
          >
            <svg viewBox="0 0 24 14" width="20" height="13" fill="none">
              <rect x="0.5" y="1" width="4" height="13" rx="1" fill="#FB923C" />
              <rect x="6.5" y="8" width="4" height="6" rx="1" fill="#9AA5B1" />
              <rect x="13" y="1" width="4" height="13" rx="1" fill="#FB923C" />
              <rect x="19" y="8" width="4" height="6" rx="1" fill="#9AA5B1" />
            </svg>
          </button>

          <div style="width: 1px; height: 22px; background: #e7e5e4; margin: 0 2px;" />

          <button
            title="FreeRide"
            class="tool-chip"
            style="width: 38px; color: #9AA5B1;"
            @click="addFreeRide"
          >
            <FreeRideIcon style="width: 20px; height: 13px;" />
          </button>

          <div class="inline-flex items-center overflow-hidden" style="height: 34px; background: #fff; border: 1px solid #e7e5e4; border-radius: 20px;">
            <button
              title="Text event"
              :disabled="blocks.length === 0"
              class="inline-flex items-center justify-center"
              :class="blocks.length === 0 ? 'cursor-not-allowed' : 'cursor-pointer'"
              :style="{ width: '38px', height: '100%', background: 'none', border: 'none', color: '#9AA5B1', opacity: blocks.length === 0 ? 0.4 : 1 }"
              @click="addTextEvent"
            >
              <TextEventIcon style="width: 20px; height: 13px;" />
            </button>
            <button
              title="Remove all text events"
              :disabled="events.length === 0"
              class="clear-events inline-flex items-center"
              :class="events.length === 0 ? 'cursor-default' : 'cursor-pointer'"
              :style="{ opacity: events.length === 0 ? 0.4 : 1 }"
              @click="clearTextEvents"
            >
              <UIcon name="i-heroicons-trash" style="width: 14px; height: 14px;" />
              <span class="tabular">{{ events.length }}</span>
            </button>
          </div>

          <div style="width: 1px; height: 22px; background: #e7e5e4; margin: 0 2px;" />

          <button
            title="Clear workout"
            :disabled="blocks.length === 0 && events.length === 0"
            class="tool-chip clear-workout"
            :style="{ width: '38px', color: '#a8a29e', opacity: blocks.length === 0 && events.length === 0 ? 0.4 : 1 }"
            @click="clearWorkout"
          >
            <UIcon name="i-heroicons-trash" style="width: 16px; height: 16px;" />
          </button>
        </div>

        <!-- Row 2: zone chips (SS = sweet spot, between Z4 and Z5) -->
        <div class="flex flex-wrap items-center gap-2">
          <button
            v-for="c in ZONE_CHIPS"
            :key="c.key"
            :title="c.title"
            class="inline-flex items-center cursor-pointer shrink-0 zone-chip"
            @click="addSteady(c.power)"
          >
            <span class="inline-block rounded-full" style="width: 10px; height: 10px;" :style="{ background: c.color }" />
            {{ c.label }}
          </button>
        </div>
      </div>

      <!-- Actions -->
      <div class="flex-none flex flex-col gap-2" style="width: 200px;" :class="{ 'locked': editing && stale }">
        <button
          title="Download .zwo"
          :disabled="blocks.length === 0"
          class="inline-flex items-center justify-center gap-2 w-full"
          :class="blocks.length === 0 ? 'cursor-not-allowed' : 'cursor-pointer'"
          :style="{
            font: `600 14px 'Hanken Grotesk'`, color: '#fff', background: '#EA580C', border: 'none', borderRadius: '10px', padding: '10px 14px',
            boxShadow: blocks.length === 0 ? 'none' : '0 3px 10px rgba(234,88,12,.28)',
            opacity: blocks.length === 0 ? 0.4 : 1,
          }"
          @click="download"
        >
          <UIcon name="i-heroicons-arrow-down-tray" style="width: 18px; height: 18px;" />
          Download .zwo
        </button>

        <template v-if="editing">
          <button
            :disabled="isSavingDraft"
            class="inline-flex items-center justify-center gap-2 w-full cursor-pointer"
            style="font: 600 14px 'Hanken Grotesk'; color: #57534e; background: #fff; border: 1.5px solid #e7e5e4; border-radius: 10px; padding: 9px 14px;"
            @click="saveDraft"
          >
            <UIcon name="i-heroicons-bookmark" style="width: 18px; height: 18px;" />
            {{ isSavingDraft ? 'Saving…' : 'Save draft' }}
          </button>
          <p class="text-right" style="font: 400 12px/1.45 'Hanken Grotesk'; color: #a8a29e;">
            Downloads as <span style="color: #78716c; font-weight: 500;">{{ editingFileName }}</span>. Save it over the original to update the library.
          </p>
        </template>
      </div>
    </div>

    <!-- ── Week reminder + fuelling guide/save — even 50/50 split, divided
         by a thin vertical rule. Falls back to a single stacked column below
         `lg` (the builder tab itself is lg+ only, but the split still needs
         real width to avoid squeezing either side). -->
    <div class="max-w-3xl mx-auto grid gap-0" style="padding-bottom: 8px;" :class="currentWeekPlan.length ? 'lg:[grid-template-columns:1fr_1px_1fr]' : ''">
      <div v-if="currentWeekPlan.length" class="pr-6">
        <p class="mb-2" style="font: 600 12px 'Hanken Grotesk'; letter-spacing: .04em; text-transform: uppercase; color: #78716c;">
          This week's plan
        </p>
        <table class="w-full" style="font: 500 13px 'Hanken Grotesk'; color: #44403c; border-collapse: collapse; table-layout: fixed;">
          <tbody>
            <tr v-for="day in currentWeekPlan" :key="day.date">
              <td
                class="py-1 pr-2 whitespace-nowrap"
                :style="isToday(day.date) ? 'color: #EA580C; font-weight: 700; width: 34px;' : 'color: #a8a29e; width: 34px;'"
              >
                {{ weekSummaryDateLabel(day.date) }}
              </td>
              <td class="py-1 pr-2 truncate">{{ day.plan?.name || '—' }}</td>
              <td class="py-1 pr-2 text-right tabular whitespace-nowrap" style="width: 60px;">{{ day.plan?.tss ?? '—' }}</td>
              <td class="py-1 text-right tabular whitespace-nowrap" style="width: 52px;">{{ weekSummaryDurationLabel(day.plan?.durationMinutes ?? null) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="currentWeekPlan.length" class="hidden lg:block" style="background: #e7e5e4;" />

      <div :class="currentWeekPlan.length ? 'lg:pl-6 space-y-3 mt-6 lg:mt-0' : 'space-y-3'">
        <div>
          <label class="block mb-[7px]" style="font: 600 12px 'Hanken Grotesk'; color: #78716c; letter-spacing: .04em; text-transform: uppercase;">
            Fuelling guide
          </label>
          <textarea
            v-model="fuellingNotes"
            rows="4"
            placeholder="Optional — pre/during/post-ride fuelling notes"
            class="w-full outline-none resize-y"
            style="font: 400 14px 'Hanken Grotesk'; color: #1c1917; border: 1.5px solid #e7e5e4; border-radius: 10px; padding: 12px 14px; background: #fff;"
          />
        </div>

        <div class="flex items-end gap-2 flex-wrap">
          <div class="flex-1 min-w-[110px]">
            <label class="block mb-[7px]" style="font: 600 12px 'Hanken Grotesk'; color: #78716c; letter-spacing: .04em; text-transform: uppercase;">
              Date
            </label>
            <input
              v-model="saveDate"
              type="date"
              class="w-full outline-none"
              style="font: 600 14px 'Hanken Grotesk'; color: #1c1917; border: 1.5px solid #e7e5e4; border-radius: 10px; padding: 11px 12px; background: #fff;"
            >
          </div>

          <button
            :disabled="blocks.length === 0 || isSaving"
            class="inline-flex items-center justify-center flex-1 min-w-[140px]"
            :class="blocks.length === 0 || isSaving ? 'cursor-not-allowed' : 'cursor-pointer'"
            style="font: 600 14px 'Hanken Grotesk'; color: #fff; background: #7c3aed; border: none; border-radius: 10px; padding: 11px 14px;"
            :style="{ opacity: blocks.length === 0 || isSaving ? 0.5 : 1 }"
            @click="saveToPlannedWorkout"
          >
            {{ isSaving ? 'Saving…' : 'Save to planned workout' }}
          </button>
        </div>
      </div>
    </div>
    <ZwiftLibraryPanel
      v-if="libraryOpen"
      :ftp="ftp"
      @close="libraryOpen = false"
      @open="onLibraryOpen"
    />
  </div>
</template>

<style scoped>
.type-btn:hover {
  border-color: #fdba74 !important;
}
.library-pill {
  color: #57534e;
  background: #fff;
  border: 1px solid #e7e5e4;
}
.library-pill:hover {
  color: #ea580c;
  border-color: #fdba74;
}
.library-pill-active {
  color: #ea580c;
  background: #fff7ed;
  border-color: #fdba74;
}
.tool-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  height: 34px;
  background: #fff;
  border: 1px solid #e7e5e4;
  border-radius: 20px;
  cursor: pointer;
}
.tool-chip:disabled { cursor: default; }
.clear-workout:not(:disabled):hover { background: #fff1f2; border-color: #fecdd3; color: #e11d48 !important; }
.clear-events {
  height: 100%;
  gap: 5px;
  border: none;
  border-left: 1px solid #e7e5e4;
  background: #fff;
  color: #a8a29e;
  font: 600 12px 'Hanken Grotesk';
  padding: 0 11px;
}
.clear-events:not(:disabled):hover { background: #fff1f2; color: #e11d48; }
.zone-chip {
  gap: 7px;
  height: 28px;
  font: 600 12px 'Hanken Grotesk';
  color: #57534e;
  background: #fff;
  border: 1px solid #e7e5e4;
  border-radius: 20px;
  padding: 0 12px 0 10px;
}
.revert-btn { color: #c2410c; background: transparent; }
.revert-btn:not(:disabled):hover { background: #ffedd5; }
.revert-confirm { color: #f43f5e; }
.locked { opacity: 0.4; pointer-events: none; }
.event-field {
  font: 500 13px 'Hanken Grotesk';
  color: #1c1917;
  border: 1.5px solid #e7e5e4;
  border-radius: 8px;
  padding: 6px 10px;
  background: #fff;
}
.event-field:focus { border-color: #ea580c; }
.event-remove:hover { color: #e11d48 !important; }
.stepper-btn {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: #44403c;
  border: none;
  color: #fff;
  cursor: pointer;
}
.stepper-value {
  font: 700 15px 'Hanken Grotesk';
  color: #fff;
  text-align: center;
  display: inline-block;
}
/* Compound "one field, baked-in unit" boxes used by the power (W / %) and
   duration (h:m:s) inputs — a bordered box styled like a single input, with
   the unit character(s) rendered as a fixed, non-editable span alongside a
   borderless <input>, so the unit reads as part of the field without being
   part of the editable text. */
.unit-input,
.hms-input {
  display: inline-flex;
  align-items: center;
  background: #1c1917;
  border: 1px solid #44403c;
  border-radius: 6px;
  outline: none;
}
.unit-input:focus-within,
.hms-input:focus-within {
  border-color: #78716c;
}
.unit-input {
  gap: 2px;
  padding: 2px 6px;
}
.unit-input-field {
  width: 30px;
  font: 700 14px 'Hanken Grotesk';
  color: #fff;
  text-align: right;
  background: transparent;
  border: none;
  outline: none;
  padding: 0;
}
.unit-input-field-pct {
  width: 24px;
}
.unit-input-suffix {
  font: 600 12px 'Hanken Grotesk';
  color: #a8a29e;
  user-select: none;
  pointer-events: none;
}
.hms-input {
  padding: 2px 4px;
}
.hms-field {
  width: 18px;
  font: 700 14px 'Hanken Grotesk';
  color: #fff;
  text-align: center;
  background: transparent;
  border: none;
  outline: none;
  padding: 0;
}
.hms-colon {
  font: 700 14px 'Hanken Grotesk';
  color: #78716c;
  user-select: none;
  pointer-events: none;
  padding: 0 1px;
}
/* Hide native spinner arrows on all the compound-field inputs. */
.unit-input-field::-webkit-outer-spin-button,
.unit-input-field::-webkit-inner-spin-button,
.hms-field::-webkit-outer-spin-button,
.hms-field::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.unit-input-field[type='number'],
.hms-field[type='number'] {
  -moz-appearance: textfield;
}

/* Timeline chart stays scrollable but hides the visible scrollbar chrome. */
.no-scrollbar {
  scrollbar-width: none; /* Firefox */
  -ms-overflow-style: none; /* old Edge/IE */
}
.no-scrollbar::-webkit-scrollbar {
  display: none; /* Chrome/Safari */
}
</style>
