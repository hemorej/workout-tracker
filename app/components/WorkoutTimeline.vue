<script setup lang="ts">
/**
 * Zone-coloured workout timeline, shared by the builder chart (interactive,
 * axis + ticks + event labels), the library panel preview (`compact`: no axis
 * or event labels) and the library row thumbnails (`mini`: bars only).
 *
 * Purely presentational: callers hand it drawable segments (power as a
 * fraction of FTP) and it scales them to `total` seconds across `width` px.
 */

export interface TimelineSeg {
  /** Seconds. */
  d: number
  /** Power at the start / end of the segment, fraction of FTP. */
  a: number
  b: number
  /** 'f' = FreeRide (hatched, no target power). */
  t?: 'f' | 's'
  /** Builder block this segment belongs to; enables selection when `interactive`. */
  blockId?: number
}

export interface TimelineEvent {
  at: number
  text: string
}

const props = withDefaults(defineProps<{
  segs: TimelineSeg[]
  events?: TimelineEvent[]
  total: number
  width: number
  height: number
  ftp?: number
  compact?: boolean
  mini?: boolean
  /** Draw the Z1–Z6 axis. Defaults to on unless `compact`/`mini`; the builder draws its own so it stays put while the chart scrolls. */
  axis?: boolean
  /** Power (fraction of FTP) at the top of the chart. */
  scaleMax?: number
  interactive?: boolean
  selectedId?: number | null
}>(), {
  events: () => [],
  ftp: 240,
  compact: false,
  mini: false,
  axis: undefined,
  scaleMax: 1.5,
  interactive: false,
  selectedId: null,
})

const emit = defineEmits<{ select: [blockId: number | null] }>()

// Same thresholds as ZONES in WorkoutBuilderTab.vue.
const ZONE_COLORS = [
  { max: 0.55, color: '#9AA5B1', label: 'Z1' },
  { max: 0.75, color: '#38BDF8', label: 'Z2' },
  { max: 0.90, color: '#34D399', label: 'Z3' },
  { max: 1.05, color: '#FBBF24', label: 'Z4' },
  { max: 1.20, color: '#FB923C', label: 'Z5' },
  { max: Infinity, color: '#F87171', label: 'Z6' },
]
const HATCH = 'repeating-linear-gradient(135deg,#d6d3d1 0 3px,#f5f5f4 3px 7px)'
const FREERIDE_HEIGHT_FTP = 0.5

const isCompact = computed(() => props.compact || props.mini)
const showAxis = computed(() => props.axis ?? !isCompact.value)
const axisW = computed(() => (showAxis.value ? 34 : 0))
const total = computed(() => Math.max(1, props.total))

function zoneColor(power: number) {
  return (ZONE_COLORS.find(z => power <= z.max) ?? ZONE_COLORS[ZONE_COLORS.length - 1]!).color
}

const bars = computed(() => {
  let x = 0
  return props.segs.map((s, i) => {
    const left = (x / total.value) * props.width
    const width = Math.max(1, (s.d / total.value) * props.width - (props.mini ? 0.5 : 1))
    x += s.d
    const selected = props.selectedId != null && s.blockId === props.selectedId
    const opacity = props.selectedId != null && !selected ? 0.3 : 1
    if (s.t === 'f') {
      return {
        key: i, blockId: s.blockId, left, width, opacity, background: HATCH,
        clip: `inset(${(1 - FREERIDE_HEIGHT_FTP / props.scaleMax) * 100}% 0 0 0)`,
        title: `FreeRide · ${Math.round(s.d / 60)} min`,
      }
    }
    const ya = (1 - Math.min(s.a, props.scaleMax) / props.scaleMax) * 100
    const yb = (1 - Math.min(s.b, props.scaleMax) / props.scaleMax) * 100
    const pct = Math.round(((s.a + s.b) / 2) * 100)
    return {
      key: i, blockId: s.blockId, left, width, opacity,
      background: zoneColor((s.a + s.b) / 2),
      clip: s.a === s.b ? `inset(${ya}% 0 0 0)` : `polygon(0 100%, 0 ${ya}%, 100% ${yb}%, 100% 100%)`,
      title: `${Math.round(s.d / 6) / 10} min · ${pct}% · ${Math.round((pct / 100) * props.ftp)} W`,
    }
  })
})

function fmtTick(t: number) {
  if (t === 0) return '0'
  if (t >= 3600) return `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}`
  return `${Math.round(t / 60)}m`
}

const ticks = computed(() => {
  if (props.mini) return []
  const step = total.value > 5400 ? 1200 : 600
  const out: { left: number, label: string }[] = []
  for (let t = 0; t <= total.value; t += step) {
    const left = (t / total.value) * props.width
    if (left <= props.width - 24) out.push({ left, label: fmtTick(t) })
  }
  return out
})

const axisLabels = computed(() =>
  ZONE_COLORS.map(z => ({
    label: z.label,
    top: props.height - (Math.min(z.max, props.scaleMax) / props.scaleMax) * props.height,
  })).filter(z => z.top >= 0 && z.top <= props.height),
)

const pins = computed(() => props.events.map(e => ({ left: (e.at / total.value) * props.width, text: e.text })))
const eventLabels = computed(() =>
  pins.value.map((p, i) => ({
    ...p,
    max: Math.max(40, (i < pins.value.length - 1 ? pins.value[i + 1]!.left : props.width) - p.left - 10),
  })),
)
</script>

<template>
  <div class="flex flex-col" :style="{ width: `${width + axisW}px`, fontFamily: `'Hanken Grotesk', sans-serif` }">
    <!-- Event labels -->
    <div
      v-if="!isCompact && eventLabels.length"
      class="relative"
      :style="{ height: '22px', marginLeft: `${axisW}px`, width: `${width}px` }"
    >
      <div
        v-for="(e, i) in eventLabels"
        :key="i"
        :title="e.text"
        class="absolute flex items-center whitespace-nowrap"
        :style="{ top: 0, left: `${e.left}px`, gap: '4px', maxWidth: `${e.max}px`, font: `600 11px 'Hanken Grotesk'`, color: '#57534e' }"
      >
        <UIcon name="i-heroicons-chat-bubble-left" class="shrink-0" style="width: 13px; height: 13px; color: #a8a29e;" />
        <span class="overflow-hidden text-ellipsis">{{ e.text }}</span>
      </div>
    </div>

    <div class="flex">
      <!-- Y axis -->
      <div v-if="showAxis" class="relative flex-none" :style="{ width: `${axisW}px`, height: `${height}px` }">
        <div
          v-for="a in axisLabels"
          :key="a.label"
          class="absolute"
          :style="{ left: 0, top: `${a.top}px`, transform: 'translateY(-50%)', font: `600 11px 'Hanken Grotesk'`, color: '#cbc8c4' }"
        >
          {{ a.label }}
        </div>
      </div>

      <div>
        <div
          class="relative"
          :style="{ width: `${width}px`, height: `${height}px`, borderBottom: mini ? '1.5px solid #e7e5e4' : '2px solid #e7e5e4' }"
          @click="interactive && emit('select', null)"
        >
          <div
            v-for="bar in bars"
            :key="bar.key"
            :title="bar.title"
            class="absolute"
            :class="interactive && bar.blockId != null ? 'cursor-pointer' : ''"
            :style="{
              top: 0,
              left: `${bar.left}px`,
              width: `${bar.width}px`,
              height: `${height}px`,
              background: bar.background,
              clipPath: bar.clip,
              borderRadius: '2px 2px 0 0',
              opacity: bar.opacity,
            }"
            @click.stop="interactive && bar.blockId != null && emit('select', selectedId === bar.blockId ? null : bar.blockId)"
          />
          <template v-if="!mini">
            <div
              v-for="(p, i) in pins"
              :key="`pin${i}`"
              class="absolute pointer-events-none"
              :style="{ top: 0, bottom: 0, left: `${p.left}px`, width: 0, borderLeft: '1px dashed #a8a29e' }"
            />
          </template>
        </div>

        <div v-if="!mini" class="relative" :style="{ height: '22px', marginTop: '6px', width: `${width}px` }">
          <div
            v-for="t in ticks"
            :key="t.label"
            class="absolute tabular"
            :style="{ top: 0, left: `${t.left}px`, transform: 'translateX(-50%)', font: `400 12px 'Hanken Grotesk'`, color: '#a8a29e' }"
          >
            {{ t.label }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
