<script setup lang="ts">
/**
 * MetricsHistoryChart component
 *
 * Hand-rolled inline-SVG line chart showing CTL and TSB over time. Takes a
 * plain series prop so it's decoupled from fetching/range logic — the caller
 * decides how much history to pass in (e.g. last 8 weeks today, with a range
 * selector later just changing what's fetched, not this component).
 */

interface Point {
  date: string
  ctl: number
  tsb: number
}

const props = defineProps<{ series: Point[] }>()

const width = 640
const height = 240
const padding = { top: 16, right: 16, bottom: 24, left: 36 }

const innerW = width - padding.left - padding.right
const innerH = height - padding.top - padding.bottom

const allValues = computed(() => props.series.flatMap(p => [p.ctl, p.tsb]))
const minY = computed(() => Math.min(0, ...allValues.value))
const maxY = computed(() => Math.max(1, ...allValues.value))

function xFor(i: number) {
  const n = props.series.length
  return padding.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW)
}

function yFor(v: number) {
  const range = maxY.value - minY.value || 1
  return padding.top + innerH - ((v - minY.value) / range) * innerH
}

function pathFor(key: 'ctl' | 'tsb') {
  return props.series
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(p[key]).toFixed(1)}`)
    .join(' ')
}

const zeroY = computed(() => yFor(0))

// ── Hover interaction ─────────────────────────────────────────────────────

const hoverIndex = ref<number | null>(null)

function onMove(evt: MouseEvent) {
  const svgEl = evt.currentTarget as SVGSVGElement
  const rect = svgEl.getBoundingClientRect()
  const n = props.series.length
  if (n === 0) return
  const x = (evt.clientX - rect.left) * (width / rect.width)
  const ratio = Math.min(1, Math.max(0, (x - padding.left) / innerW))
  hoverIndex.value = Math.round(ratio * (n - 1))
}

function onLeave() {
  hoverIndex.value = null
}

const hoverPoint = computed(() => (hoverIndex.value != null ? props.series[hoverIndex.value] ?? null : null))

function formatDate(dateStr: string) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function formatTsb(v: number) {
  return v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1)
}
</script>

<template>
  <div class="relative">
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      class="w-full h-auto touch-none"
      @mousemove="onMove"
      @mouseleave="onLeave"
    >
      <!-- Zero line — TSB reference -->
      <line :x1="padding.left" :x2="width - padding.right" :y1="zeroY" :y2="zeroY" stroke="#e7e5e0" stroke-width="1" />

      <path :d="pathFor('ctl')" fill="none" stroke="#059669" stroke-width="2" />
      <path :d="pathFor('tsb')" fill="none" stroke="#d97706" stroke-width="2" />

      <template v-if="hoverIndex !== null && hoverPoint">
        <line
          :x1="xFor(hoverIndex)" :x2="xFor(hoverIndex)"
          :y1="padding.top" :y2="height - padding.bottom"
          stroke="#d6d3d1" stroke-width="1" stroke-dasharray="3,3"
        />
        <circle :cx="xFor(hoverIndex)" :cy="yFor(hoverPoint.ctl)" r="3.5" fill="#059669" />
        <circle :cx="xFor(hoverIndex)" :cy="yFor(hoverPoint.tsb)" r="3.5" fill="#d97706" />
      </template>
    </svg>

    <div
      v-if="hoverPoint"
      class="absolute top-2 left-2 bg-white border border-stone-200 rounded-lg px-3 py-2 text-xs shadow-sm pointer-events-none"
    >
      <p class="font-semibold text-stone-700">{{ formatDate(hoverPoint.date) }}</p>
      <p class="text-emerald-600 tabular">CTL: {{ hoverPoint.ctl.toFixed(1) }}</p>
      <p class="text-amber-600 tabular">TSB: {{ formatTsb(hoverPoint.tsb) }}</p>
    </div>

    <div v-if="!series.length" class="absolute inset-0 flex items-center justify-center text-sm text-stone-400">
      No data yet
    </div>

    <div class="flex items-center gap-4 mt-2 text-xs text-stone-400">
      <span class="flex items-center gap-1.5"><span class="w-3 h-0.5 bg-emerald-600 inline-block" /> CTL (Fitness)</span>
      <span class="flex items-center gap-1.5"><span class="w-3 h-0.5 bg-amber-600 inline-block" /> TSB (Form)</span>
    </div>
  </div>
</template>
