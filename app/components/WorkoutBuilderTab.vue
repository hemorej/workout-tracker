<script setup lang="ts">
/**
 * Workout builder tab
 *
 * Lets the user compose a structured cycling workout (warm up, cool down,
 * steady-power blocks, on/off intervals) on a zone-colored timeline, see
 * live Duration/TSS totals, edit blocks inline via a stepper popover, and
 * export the result as a Zwift `.zwo` file.
 *
 * Single source of truth is local component state — nothing here is
 * persisted or shared with other tabs (see design_handoff_workout_builder/README.md).
 */

// ── Data model ───────────────────────────────────────────────────────────

type RampBlock = { id: number, type: 'warmup' | 'cooldown', duration: number, powerStart: number, powerEnd: number, cadence: number | null }
type SteadyBlock = { id: number, type: 'steady', duration: number, power: number, cadence: number | null }
type IntervalBlock = { id: number, type: 'interval', reps: number, onDuration: number, onPower: number, onCadence: number | null, offDuration: number, offPower: number, offCadence: number | null }
type Block = RampBlock | SteadyBlock | IntervalBlock

interface Segment {
  blockId: number
  duration: number
  powerStart: number
  powerEnd: number
}

// ── Zone config ──────────────────────────────────────────────────────────

const ZONES = [
  { label: 'Z1', name: 'Recovery', range: '<55% FTP', max: 0.55, color: '#9AA5B1', midpoint: 0.45 },
  { label: 'Z2', name: 'Endurance', range: '55–75% FTP', max: 0.75, color: '#38BDF8', midpoint: 0.65 },
  { label: 'Z3', name: 'Tempo', range: '75–90% FTP', max: 0.90, color: '#34D399', midpoint: 0.825 },
  { label: 'Z4', name: 'Threshold', range: '90–105% FTP', max: 1.05, color: '#FBBF24', midpoint: 0.975 },
  { label: 'Z5', name: 'VO2 max', range: '105–120% FTP', max: 1.20, color: '#FB923C', midpoint: 1.125 },
  { label: 'Z6', name: 'Anaerobic', range: '120%+ FTP', max: Infinity, color: '#F87171', midpoint: 1.3 },
]

function zoneFor(pct: number) {
  return ZONES.find(z => pct <= z.max) ?? ZONES[ZONES.length - 1]!
}

// ── State ────────────────────────────────────────────────────────────────

const title = ref('')
const ftp = ref(240)

// Seed FTP from the athlete's most recent logged value (same field HistoryTab
// shows) so the builder doesn't default to a stale/generic number. Still a
// plain local ref after that — the user can override it and it won't be
// clobbered, matching this component's "local state only" design.
const { data: currentFtpData } = useFetch<{ currentFtp: number | null }>('/api/history')
watch(currentFtpData, (data) => {
  if (data?.currentFtp) ftp.value = data.currentFtp
}, { immediate: true })

// Prefilled by the "Planned" shortcut on the training log (see goToBuilder()
// in [[tab]].vue) via a query param rather than a parent-called setter —
// switching to this tab remounts the page, so a ref call from the old
// instance can't reach the one that survives. Read once, then scrub the
// param so it doesn't linger in the URL or reapply on a later remount.
const route = useRoute()
if (typeof route.query.planName === 'string') {
  title.value = route.query.planName
  navigateTo({ query: { ...route.query, planName: undefined } }, { replace: true })
}

const nextId = ref(1)
const selectedId = ref<number | null>(null)
const blocks = ref<Block[]>([])

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
// just a ramp whose start/end power are equal, so a single clip-path
// formula covers warmup/cooldown/steady/interval alike.

function buildSegments(source: Block[]): Segment[] {
  const segs: Segment[] = []
  for (const b of source) {
    if (b.type === 'warmup' || b.type === 'cooldown') {
      segs.push({ blockId: b.id, duration: b.duration, powerStart: b.powerStart, powerEnd: b.powerEnd })
    }
    else if (b.type === 'steady') {
      segs.push({ blockId: b.id, duration: b.duration, powerStart: b.power, powerEnd: b.power })
    }
    else if (b.type === 'interval') {
      for (let i = 0; i < b.reps; i++) {
        segs.push({ blockId: b.id, duration: b.onDuration, powerStart: b.onPower, powerEnd: b.onPower })
        segs.push({ blockId: b.id, duration: b.offDuration, powerStart: b.offPower, powerEnd: b.offPower })
      }
    }
  }
  return segs
}

const segments = computed(() => buildSegments(blocks.value))

const totalDuration = computed(() => segments.value.reduce((s, x) => s + x.duration, 0))
const totalDurationLabel = computed(() => fmtClock(totalDuration.value))

// Real Normalized Power, not a per-segment RMS approximation — a duration-
// weighted mean of instantaneous power² is exact for flat blocks but badly
// underestimates high/low interval workouts, since it lacks NP's 30s
// smoothing + 4th-power weighting that disproportionately counts sustained
// hard efforts over recovery valleys. So: materialize a 1Hz power stream
// (fraction of FTP, ramps interpolated), take a trailing 30s rolling
// average, mean the 4th power of that, then 4th-root — matching how
// Zwift/TrainingPeaks derive NP from a real power stream.
const NP_WINDOW_SEC = 30

const totalTSS = computed(() => {
  const totalSec = Math.round(totalDuration.value)
  if (totalSec <= 0) return 0

  const series = new Float64Array(totalSec)
  let cursor = 0
  for (const seg of segments.value) {
    const dur = Math.round(seg.duration)
    for (let i = 0; i < dur && cursor + i < totalSec; i++) {
      const t = dur > 0 ? i / dur : 0
      series[cursor + i] = seg.powerStart + (seg.powerEnd - seg.powerStart) * t
    }
    cursor += dur
  }

  let windowSum = 0
  let quarticSum = 0
  let sampleCount = 0
  for (let i = 0; i < totalSec; i++) {
    windowSum += series[i] ?? 0
    if (i >= NP_WINDOW_SEC) windowSum -= series[i - NP_WINDOW_SEC] ?? 0
    if (i >= NP_WINDOW_SEC - 1) {
      const rollingAvg = windowSum / NP_WINDOW_SEC
      quarticSum += rollingAvg ** 4
      sampleCount++
    }
  }

  // Workouts shorter than the smoothing window have no defined NP — fall
  // back to a plain average of instantaneous power.
  const intensity = sampleCount > 0
    ? (quarticSum / sampleCount) ** 0.25
    : series.reduce((s, p) => s + p, 0) / totalSec

  return Math.round((totalSec / 3600) * intensity * intensity * 100)
})

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
  const rulerHeight = 28
  const baseHeight = chartHeight + rulerHeight
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

interface Bar {
  key: string
  blockId: number
  left: number
  width: number
  color: string
  clipPath: string
  opacity: number
}

const bars = computed<Bar[]>(() => {
  let cursor = 0
  const result: Bar[] = []
  segments.value.forEach((x, i) => {
    const left = cursor * pxPerSecond.value
    const width = Math.max(1, x.duration * pxPerSecond.value - 1.5)
    const hs = (x.powerStart / scaleMax.value) * 100
    const he = (x.powerEnd / scaleMax.value) * 100
    const clipPath = `polygon(0% ${100 - hs}%, 100% ${100 - he}%, 100% 100%, 0% 100%)`
    const zone = zoneFor((x.powerStart + x.powerEnd) / 2)
    const selected = selectedId.value === x.blockId
    const dim = selectedId.value != null && !selected
    result.push({
      key: `bar${i}`,
      blockId: x.blockId,
      left,
      width,
      color: zone.color,
      clipPath,
      opacity: dim ? 0.3 : 1,
    })
    cursor += x.duration
  })
  return result
})

const ticks = computed(() => {
  const dur = durForScale.value
  const step = dur <= 300 ? 30 : dur <= 900 ? 60 : dur <= 2400 ? 120 : 300
  const result: { key: string, left: number, label: string }[] = []
  for (let t = 0; t <= dur + 1; t += step) {
    result.push({ key: `t${t}`, left: t * pxPerSecond.value, label: fmtClock(t) })
  }
  return result
})

const axisZones = computed(() => {
  return ZONES
    .map(z => ({
      label: z.label,
      top: chartHeight - (Math.min(z.max, scaleMax.value) / scaleMax.value) * chartHeight,
    }))
    .filter(z => z.top >= 0 && z.top <= chartHeight)
})

function onBarClick(blockId: number) {
  selectedId.value = selectedId.value === blockId ? null : blockId
}

function clearSelection() {
  selectedId.value = null
}

// ── Selected block / popover ─────────────────────────────────────────────

const selectedBlock = computed(() => blocks.value.find(b => b.id === selectedId.value) ?? null)

const popoverLeft = computed(() => {
  const id = selectedId.value
  if (id == null) return 0
  const myBars = bars.value.filter(b => b.blockId === id)
  if (!myBars.length) return 0
  const minLeft = Math.min(...myBars.map(b => b.left))
  const maxRight = Math.max(...myBars.map(b => b.left + b.width))
  const center = (minLeft + maxRight) / 2
  return Math.max(0, Math.min(center - POPOVER_WIDTH / 2, visibleWidth.value - POPOVER_WIDTH))
})

// ── Block mutations ──────────────────────────────────────────────────────

function bumpPower(id: number, field: string, delta: number) {
  const b = blocks.value.find(x => x.id === id) as Record<string, unknown> | undefined
  if (!b) return
  const v = Math.max(0.2, Math.min(2.0, ((b[field] as number) || 0) + delta))
  b[field] = Math.round(v * 100) / 100
}

function bumpDuration(id: number, field: string, delta: number) {
  const b = blocks.value.find(x => x.id === id) as Record<string, unknown> | undefined
  if (!b) return
  b[field] = Math.max(5, ((b[field] as number) || 0) + delta)
}

function bumpCadence(id: number, field: string, delta: number) {
  const b = blocks.value.find(x => x.id === id) as Record<string, unknown> | undefined
  if (!b) return
  const cur = (b[field] as number) || 80
  b[field] = Math.max(0, Math.min(140, cur + delta))
}

// ── Direct input editing (duration in seconds, power in absolute watts) ──

function powerWatts(power: number) {
  return Math.round(power * ftp.value)
}

function powerPercentLabel(power: number) {
  return `${Math.round(power * 100)}%`
}

// Bounds are only enforced on commit (blur/Enter), not on every keystroke —
// clamping mid-typing would snap "120" down to the minimum after the first
// digit and make it impossible to type a value below the previous one.
function setDurationSeconds(id: number, field: string, seconds: number, commit: boolean) {
  if (!Number.isFinite(seconds)) return
  const b = blocks.value.find(x => x.id === id) as Record<string, unknown> | undefined
  if (!b) return
  const rounded = Math.round(seconds)
  b[field] = commit ? Math.max(5, rounded) : rounded
}

function onDurationInput(e: Event, id: number, field: string) {
  setDurationSeconds(id, field, (e.target as HTMLInputElement).valueAsNumber, false)
}

function onDurationCommit(e: Event, id: number, field: string) {
  setDurationSeconds(id, field, (e.target as HTMLInputElement).valueAsNumber, true)
}

// Power is stored as a fraction of FTP rounded to the nearest 1% — writing
// every keystroke straight into the block would round small in-progress
// watt values (e.g. the "1" in "120") down to 0%, snapping the field back
// to 0W mid-type. So the live-typed watts live in a draft here and only
// commit into the block (with min/max clamping) on blur — the draft still
// drives the % readout so it updates as you type.
interface PowerDraft { id: number, field: string, watts: number }
const powerDraft = ref<PowerDraft | null>(null)

function isPowerDraft(id: number, field: string) {
  return powerDraft.value?.id === id && powerDraft.value?.field === field
}

function powerInputValue(power: number, id: number, field: string) {
  return isPowerDraft(id, field) ? powerDraft.value!.watts : powerWatts(power)
}

function powerPercentDisplay(power: number, id: number, field: string) {
  if (!isPowerDraft(id, field)) return powerPercentLabel(power)
  const pct = ftp.value > 0 ? Math.round((powerDraft.value!.watts / ftp.value) * 100) : 0
  return `${pct}%`
}

function onPowerWattsInput(e: Event, id: number, field: string) {
  const watts = (e.target as HTMLInputElement).valueAsNumber
  powerDraft.value = { id, field, watts: Number.isFinite(watts) ? Math.round(watts) : 0 }
}

function onPowerWattsCommit(e: Event, id: number, field: string) {
  const watts = (e.target as HTMLInputElement).valueAsNumber
  const b = blocks.value.find(x => x.id === id) as Record<string, unknown> | undefined
  if (b && Number.isFinite(watts)) {
    const fraction = ftp.value > 0 ? Math.round(watts) / ftp.value : 0
    b[field] = Math.round(Math.min(2.0, Math.max(0.2, fraction)) * 100) / 100
  }
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

function addSweetSpot() {
  const block: Block = { id: nextId.value, type: 'interval', reps: 3, onDuration: 600, onPower: 0.91, onCadence: null, offDuration: 300, offPower: 0.5, offCadence: null }
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

function clearWorkout() {
  blocks.value = []
  selectedId.value = null
}

// ── Download (.zwo export) ───────────────────────────────────────────────

function escapeXml(s: string) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function download() {
  let xml = `<workout_file>\n  <author>Sprocket</author>\n  <name>${escapeXml(title.value)}</name>\n  <description></description>\n  <sportType>bike</sportType>\n  <workout>\n`
  for (const b of blocks.value) {
    if (b.type === 'warmup') {
      xml += `    <Warmup Duration="${b.duration}" PowerLow="${b.powerStart}" PowerHigh="${b.powerEnd}"${b.cadence ? ` Cadence="${b.cadence}"` : ''}/>\n`
    }
    else if (b.type === 'cooldown') {
      xml += `    <Cooldown Duration="${b.duration}" PowerLow="${b.powerStart}" PowerHigh="${b.powerEnd}"${b.cadence ? ` Cadence="${b.cadence}"` : ''}/>\n`
    }
    else if (b.type === 'steady') {
      xml += `    <SteadyState Duration="${b.duration}" Power="${b.power}"${b.cadence ? ` Cadence="${b.cadence}"` : ''}/>\n`
    }
    else if (b.type === 'interval') {
      xml += `    <IntervalsT Repeat="${b.reps}" OnDuration="${b.onDuration}" OffDuration="${b.offDuration}" OnPower="${b.onPower}" OffPower="${b.offPower}"${b.onCadence ? ` Cadence="${b.onCadence}"` : ''}${b.offCadence ? ` CadenceResting="${b.offCadence}"` : ''}/>\n`
    }
  }
  xml += '  </workout>\n</workout_file>'

  const blob = new Blob([xml], { type: 'application/xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${(title.value || 'workout').replace(/[^a-z0-9]+/gi, '_')}.zwo`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
</script>

<template>
  <div class="space-y-6" style="font-family: 'Hanken Grotesk', sans-serif;">
    <!-- ── Row 1: name, stat cards ──────────────────────────────────────── -->
    <!-- Narrower than the timeline card below — stays put while the timeline widens. -->
    <div class="max-w-3xl mx-auto flex items-end gap-4 flex-wrap">
      <!-- Workout name -->
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
            class="tabular text-center outline-none"
            style="width: 54px; font: 700 18px 'Hanken Grotesk'; color: #1c1917; border: none; background: transparent;"
          >
        </div>
      </div>
    </div>

    <!-- ── Timeline card ────────────────────────────────────────────────── -->
    <div class="bg-white relative" style="border: 1px solid #f0eeec; border-radius: 14px; padding: 24px 8px 16px 24px;">
      <div class="flex">
        <!-- Y-axis -->
        <div class="relative flex-none" style="width: 34px;" :style="{ height: `${chartHeight}px` }">
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
          <!-- Bars -->
          <div
            class="relative"
            style="border-bottom: 2px solid #e7e5e4;"
            :style="{ width: `${chartWidth}px`, height: `${chartHeight}px` }"
            @click="clearSelection"
          >
            <div
              v-for="bar in bars"
              :key="bar.key"
              class="absolute cursor-pointer"
              style="top: 0; border-radius: 2px 2px 0 0;"
              :style="{
                left: `${bar.left}px`,
                width: `${bar.width}px`,
                height: `${chartHeight}px`,
                background: bar.color,
                clipPath: bar.clipPath,
                opacity: bar.opacity,
              }"
              @click.stop="onBarClick(bar.blockId)"
            />
          </div>

          <!-- Time ruler -->
          <div class="relative" style="height: 22px; margin-top: 6px;" :style="{ width: `${chartWidth}px` }">
            <div
              v-for="tick in ticks"
              :key="tick.key"
              class="tabular absolute"
              style="top: 0; font: 400 12px 'Hanken Grotesk'; color: #a8a29e; transform: translateX(-50%);"
              :style="{ left: `${tick.left}px` }"
            >
              {{ tick.label }}
            </div>
          </div>

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
                class="cursor-pointer text-white"
                style="width: 30px; height: 30px; border-radius: 50%; background: #44403c; border: none; font-size: 14px;"
                @click="moveBlock(selectedBlock.id, -1)"
              >
                ←
              </button>
              <button
                title="Move after next"
                class="cursor-pointer text-white"
                style="width: 30px; height: 30px; border-radius: 50%; background: #44403c; border: none; font-size: 14px;"
                @click="moveBlock(selectedBlock.id, 1)"
              >
                →
              </button>
              <button
                title="Duplicate"
                class="cursor-pointer text-white"
                style="width: 30px; height: 30px; border-radius: 50%; background: #44403c; border: none; font-size: 14px;"
                @click="duplicateBlock(selectedBlock.id)"
              >
                ⧉
              </button>
              <button
                title="Delete"
                class="cursor-pointer text-white"
                style="width: 30px; height: 30px; border-radius: 50%; background: #7f1d1d; border: none; font-size: 14px;"
                @click="deleteBlock(selectedBlock.id)"
              >
                🗑
              </button>
            </div>

            <!-- Steady fields -->
            <template v-if="selectedBlock.type === 'steady'">
              <div class="flex items-center justify-between mb-2.5">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Duration</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpDuration(selectedBlock.id, 'duration', -15)">–</button>
                  <input
                    type="number" step="1" min="5" class="tabular stepper-input"
                    :value="selectedBlock.duration"
                    @input="onDurationInput($event, selectedBlock.id, 'duration')"
                    @change="onDurationCommit($event, selectedBlock.id, 'duration')"
                  >
                  <span class="tabular stepper-suffix">{{ fmtClock(selectedBlock.duration) }}</span>
                  <button class="stepper-btn" @click="bumpDuration(selectedBlock.id, 'duration', 15)">+</button>
                </div>
              </div>
              <div class="flex items-center justify-between mb-2.5">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Power</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'power', -0.01)">–</button>
                  <input
                    type="number" step="1" min="0" class="tabular stepper-input"
                    :value="powerInputValue(selectedBlock.power, selectedBlock.id, 'power')"
                    @input="onPowerWattsInput($event, selectedBlock.id, 'power')"
                    @blur="onPowerWattsCommit($event, selectedBlock.id, 'power')"
                  >
                  <span class="tabular stepper-suffix">W · {{ powerPercentDisplay(selectedBlock.power, selectedBlock.id, 'power') }}</span>
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
                  <input
                    type="number" step="1" min="5" class="tabular stepper-input"
                    :value="selectedBlock.duration"
                    @input="onDurationInput($event, selectedBlock.id, 'duration')"
                    @change="onDurationCommit($event, selectedBlock.id, 'duration')"
                  >
                  <span class="tabular stepper-suffix">{{ fmtClock(selectedBlock.duration) }}</span>
                  <button class="stepper-btn" @click="bumpDuration(selectedBlock.id, 'duration', 15)">+</button>
                </div>
              </div>
              <div class="flex items-center justify-between mb-2.5">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Start power</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'powerStart', -0.01)">–</button>
                  <input
                    type="number" step="1" min="0" class="tabular stepper-input"
                    :value="powerInputValue(selectedBlock.powerStart, selectedBlock.id, 'powerStart')"
                    @input="onPowerWattsInput($event, selectedBlock.id, 'powerStart')"
                    @blur="onPowerWattsCommit($event, selectedBlock.id, 'powerStart')"
                  >
                  <span class="tabular stepper-suffix">W · {{ powerPercentDisplay(selectedBlock.powerStart, selectedBlock.id, 'powerStart') }}</span>
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'powerStart', 0.01)">+</button>
                </div>
              </div>
              <div class="flex items-center justify-between mb-2.5">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">End power</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'powerEnd', -0.01)">–</button>
                  <input
                    type="number" step="1" min="0" class="tabular stepper-input"
                    :value="powerInputValue(selectedBlock.powerEnd, selectedBlock.id, 'powerEnd')"
                    @input="onPowerWattsInput($event, selectedBlock.id, 'powerEnd')"
                    @blur="onPowerWattsCommit($event, selectedBlock.id, 'powerEnd')"
                  >
                  <span class="tabular stepper-suffix">W · {{ powerPercentDisplay(selectedBlock.powerEnd, selectedBlock.id, 'powerEnd') }}</span>
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
                  <input
                    type="number" step="1" min="5" class="tabular stepper-input"
                    :value="selectedBlock.onDuration"
                    @input="onDurationInput($event, selectedBlock.id, 'onDuration')"
                    @change="onDurationCommit($event, selectedBlock.id, 'onDuration')"
                  >
                  <span class="tabular stepper-suffix">{{ fmtClock(selectedBlock.onDuration) }}</span>
                  <button class="stepper-btn" @click="bumpDuration(selectedBlock.id, 'onDuration', 15)">+</button>
                </div>
              </div>
              <div class="flex items-center justify-between mb-2">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Power</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'onPower', -0.01)">–</button>
                  <input
                    type="number" step="1" min="0" class="tabular stepper-input"
                    :value="powerInputValue(selectedBlock.onPower, selectedBlock.id, 'onPower')"
                    @input="onPowerWattsInput($event, selectedBlock.id, 'onPower')"
                    @blur="onPowerWattsCommit($event, selectedBlock.id, 'onPower')"
                  >
                  <span class="tabular stepper-suffix">W · {{ powerPercentDisplay(selectedBlock.onPower, selectedBlock.id, 'onPower') }}</span>
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
                  <input
                    type="number" step="1" min="5" class="tabular stepper-input"
                    :value="selectedBlock.offDuration"
                    @input="onDurationInput($event, selectedBlock.id, 'offDuration')"
                    @change="onDurationCommit($event, selectedBlock.id, 'offDuration')"
                  >
                  <span class="tabular stepper-suffix">{{ fmtClock(selectedBlock.offDuration) }}</span>
                  <button class="stepper-btn" @click="bumpDuration(selectedBlock.id, 'offDuration', 15)">+</button>
                </div>
              </div>
              <div class="flex items-center justify-between mb-2">
                <span style="font: 500 13px 'Hanken Grotesk'; color: #d6d3d1;">Power</span>
                <div class="flex items-center gap-2">
                  <button class="stepper-btn" @click="bumpPower(selectedBlock.id, 'offPower', -0.01)">–</button>
                  <input
                    type="number" step="1" min="0" class="tabular stepper-input"
                    :value="powerInputValue(selectedBlock.offPower, selectedBlock.id, 'offPower')"
                    @input="onPowerWattsInput($event, selectedBlock.id, 'offPower')"
                    @blur="onPowerWattsCommit($event, selectedBlock.id, 'offPower')"
                  >
                  <span class="tabular stepper-suffix">W · {{ powerPercentDisplay(selectedBlock.offPower, selectedBlock.id, 'offPower') }}</span>
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
    </div>

    <!-- ── Toolbar + download — same narrow width as row 1, same row ──── -->
    <!-- Download is icon-only so the row fits without wrapping or scrolling;
         its right edge lines up with the FTP stat card above. -->
    <div class="max-w-3xl mx-auto flex items-center gap-3" style="padding-bottom: 44px;">
      <div class="flex flex-wrap items-center gap-2 min-w-0">
        <button
          title="Warm up"
          class="inline-flex items-center justify-center cursor-pointer shrink-0"
          style="width: 38px; height: 34px; background: #fff; border: 1px solid #e7e5e4; border-radius: 20px;"
          @click="addBlock('warmup')"
        >
          <svg viewBox="0 0 20 14" width="18" height="13" fill="none" stroke="#34D399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12 L19 2" /></svg>
        </button>
        <button
          title="Cool down"
          class="inline-flex items-center justify-center cursor-pointer shrink-0"
          style="width: 38px; height: 34px; background: #fff; border: 1px solid #e7e5e4; border-radius: 20px;"
          @click="addBlock('cooldown')"
        >
          <svg viewBox="0 0 20 14" width="18" height="13" fill="none" stroke="#9AA5B1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 2 L19 12" /></svg>
        </button>
        <button
          title="Interval"
          class="inline-flex items-center justify-center cursor-pointer shrink-0"
          style="width: 38px; height: 34px; background: #fff; border: 1px solid #e7e5e4; border-radius: 20px;"
          @click="addBlock('interval')"
        >
          <svg viewBox="0 0 24 14" width="20" height="13" fill="none">
            <rect x="0.5" y="1" width="4" height="13" rx="1" fill="#FB923C" />
            <rect x="6.5" y="8" width="4" height="6" rx="1" fill="#9AA5B1" />
            <rect x="13" y="1" width="4" height="13" rx="1" fill="#FB923C" />
            <rect x="19" y="8" width="4" height="6" rx="1" fill="#9AA5B1" />
          </svg>
        </button>

        <div style="width: 1px; height: 22px; background: #e7e5e4; margin: 0 4px;" />

        <template v-for="z in ZONES" :key="z.label">
          <div class="relative inline-flex shrink-0">
            <button
              :title="`${z.label} · ${z.name} · ${z.range}`"
              class="inline-flex items-center cursor-pointer shrink-0"
              style="gap: 7px; font: 600 13px 'Hanken Grotesk'; color: #57534e; background: #fff; border: 1px solid #e7e5e4; border-radius: 20px; padding: 8px 14px 8px 10px;"
              @click="addSteady(z.midpoint)"
            >
              <span class="inline-block rounded-full" style="width: 11px; height: 11px;" :style="{ background: z.color }" />
              {{ z.label }}
            </button>

            <button
              v-if="z.label === 'Z4'"
              title="Sweet spot · 88–94% FTP"
              class="absolute inline-flex items-center cursor-pointer whitespace-nowrap"
              style="top: 100%; left: 0; margin-top: 6px; gap: 7px; font: 600 13px 'Hanken Grotesk'; color: #57534e; background: #fff; border: 1px solid #e7e5e4; border-radius: 20px; padding: 8px 14px 8px 10px;"
              @click="addSweetSpot"
            >
              <span class="inline-block rounded-full" style="width: 11px; height: 11px; background: #FBBF24;" />
              SS
            </button>
          </div>
        </template>

        <div style="width: 1px; height: 22px; background: #e7e5e4; margin: 0 4px;" />

        <button
          title="Clear workout"
          class="inline-flex items-center justify-center cursor-pointer shrink-0"
          style="width: 38px; height: 34px; background: #fff; border: 1px solid #e7e5e4; border-radius: 20px; color: #a8a29e;"
          @click="clearWorkout"
        >
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 6 h12" />
            <path d="M8 6 V4.5 a1 1 0 0 1 1 -1 h2 a1 1 0 0 1 1 1 V6" />
            <path d="M5.5 6 L6.2 16 a1.2 1.2 0 0 0 1.2 1.1 h5.2 a1.2 1.2 0 0 0 1.2 -1.1 L14.5 6" />
          </svg>
        </button>
      </div>

      <!-- Download — icon-only, bigger than the toolbar buttons for prominence -->
      <button
        title="Download .zwo"
        aria-label="Download .zwo"
        :disabled="blocks.length === 0"
        class="inline-flex items-center justify-center shrink-0 ml-auto"
        :class="blocks.length === 0 ? 'cursor-not-allowed' : 'cursor-pointer'"
        :style="{
          width: '46px',
          height: '46px',
          background: '#EA580C',
          border: 'none',
          borderRadius: '50%',
          boxShadow: blocks.length === 0 ? 'none' : '0 3px 10px rgba(234,88,12,.28)',
          opacity: blocks.length === 0 ? 0.4 : 1,
        }"
        @click="download"
      >
        <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 3 V13" />
          <path d="M6 9 L10 13 L14 9" />
          <path d="M4 16.5 H16" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
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
.stepper-input {
  width: 46px;
  font: 700 15px 'Hanken Grotesk';
  color: #fff;
  text-align: center;
  background: #1c1917;
  border: 1px solid #44403c;
  border-radius: 6px;
  padding: 2px 0;
  outline: none;
}
.stepper-input:focus {
  border-color: #78716c;
}
/* Hide native spinner arrows — the –/+ buttons already cover stepping. */
.stepper-input::-webkit-outer-spin-button,
.stepper-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.stepper-input[type='number'] {
  -moz-appearance: textfield;
}
.stepper-suffix {
  font: 500 12px 'Hanken Grotesk';
  color: #a8a29e;
  white-space: nowrap;
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
