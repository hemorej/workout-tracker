<script setup lang="ts">
/**
 * Photo overlay page
 *
 * Generates a downloadable PNG: a user-uploaded photo with the Strava
 * route line + stat row (title, distance, time) composited on top, styled
 * like a route-tracing photo overlay. Optionally applies a high-contrast
 * noisy black-and-white filter to the photo first.
 *
 * Everything is rendered client-side via <canvas> — the server only
 * supplies the decoded route + stats (GET /api/strava/activity/:id). The
 * photo never leaves the browser.
 *
 * Route param `activityId` is the Strava activity id (not the internal
 * workout id) — see server/api/strava/activity/[id].get.ts.
 */

definePageMeta({ middleware: 'auth' })

useHead({ title: 'Photo Overlay' })

interface ActivityOverlayData {
  name: string
  distanceMeters: number
  movingTimeSeconds: number
  points: [number, number][]
  avgWatts: number | null
  elevationGainMeters: number
  avgSpeedMetersPerSecond: number | null
  startDateLocal: string
}

/** Matches the app's theme accent — Tailwind's orange-600 (see CLAUDE.md palette), used for the route line. */
const THEME_ORANGE = '#ea580c'
const OVERLAY_FONT_FAMILY = '"Hanken Grotesk", system-ui, sans-serif'

const route = useRoute()
const activityId = route.params.activityId as string

const isLoading = ref(true)
const loadError = ref<string | null>(null)
const activityData = ref<ActivityOverlayData | null>(null)

const photoImage = ref<HTMLImageElement | null>(null)
const bwFilterEnabled = ref(false)
const blurEnabled = ref(false)
const showAvgPower = ref(false)
const showElevation = ref(false)
const showAvgSpeed = ref(false)
const showDate = ref(false)
const canvasRef = ref<HTMLCanvasElement | null>(null)

// ── Draggable overlay positions ──────────────────────────────────────────
//
// The route line and the text block (title/date/stats, moved as one unit)
// can each be dragged to a different spot on the photo. Offsets are in
// canvas pixel space, relative to each element's default layout position.
const textOffsetX = ref(0)
const textOffsetY = ref(0)
const routeOffsetX = ref(0)
const routeOffsetY = ref(0)
const dragging = ref<'text' | 'route' | null>(null)

interface Box { x: number, y: number, w: number, h: number }
// Updated on every renderOverlay() call, read by the pointerdown hit test —
// plain (non-reactive) module state, not worth a ref since nothing renders
// off of it directly.
let textBounds: Box | null = null
let routeBounds: Box | null = null
let dragStartPoint = { x: 0, y: 0 }
let dragStartOffset = { x: 0, y: 0 }

onMounted(async () => {
  try {
    activityData.value = await $fetch<ActivityOverlayData>(`/api/strava/activity/${activityId}`)
  }
  catch (err: unknown) {
    loadError.value = (err as { data?: { statusMessage?: string } })?.data?.statusMessage
      ?? 'Failed to load activity from Strava.'
  }
  finally {
    isLoading.value = false
  }
})

// ── Photo upload ─────────────────────────────────────────────────────────

// Downsizes only if the source photo exceeds this on its longest edge —
// keeps huge phone photos (4000px+) from producing a slow-to-render, huge
// canvas, and comfortably covers Strava's own upload size. The download
// itself is PNG (lossless), so this cap is the only resolution loss in the
// pipeline.
const MAX_CANVAS_EDGE = 1600

function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return

  const url = URL.createObjectURL(file)
  const img = new Image()
  img.onload = () => {
    photoImage.value = img
    // A new photo can have very different dimensions — start overlays back
    // at their default layout position rather than carrying over an offset
    // that may no longer make sense.
    textOffsetX.value = 0
    textOffsetY.value = 0
    routeOffsetX.value = 0
    routeOffsetY.value = 0
    URL.revokeObjectURL(url)
  }
  img.src = url
}

function resetPositions() {
  textOffsetX.value = 0
  textOffsetY.value = 0
  routeOffsetX.value = 0
  routeOffsetY.value = 0
}

// ── Stat formatting ──────────────────────────────────────────────────────
//
// Each stat is a "group" of one or more {value, unit} segments — most stats
// are a single segment (e.g. "32.4" + "km"), duration is two ("1" + "h",
// "12" + "m"). Units are drawn smaller than values. Groups are packed into
// display lines below.

interface StatSegment {
  value: string
  unit: string
}
type StatGroup = StatSegment[]

const distanceGroup = computed((): StatGroup => {
  const meters = activityData.value?.distanceMeters ?? 0
  return [{ value: (meters / 1000).toFixed(1), unit: 'km' }]
})

const durationGroup = computed((): StatGroup => {
  const seconds = activityData.value?.movingTimeSeconds ?? 0
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h > 0
    ? [{ value: `${h}`, unit: 'h' }, { value: `${m}`, unit: 'm' }]
    : [{ value: `${m}`, unit: 'm' }]
})

const hasAvgPower = computed(() => activityData.value?.avgWatts != null)

const avgPowerGroup = computed((): StatGroup | null => {
  const w = activityData.value?.avgWatts
  return w != null ? [{ value: `${Math.round(w)}`, unit: 'w avg' }] : null
})

const elevationGroup = computed((): StatGroup => {
  const m = activityData.value?.elevationGainMeters ?? 0
  return [{ value: `${Math.round(m)}`, unit: 'm elev' }]
})

const hasAvgSpeed = computed(() => activityData.value?.avgSpeedMetersPerSecond != null)

const avgSpeedGroup = computed((): StatGroup | null => {
  const mps = activityData.value?.avgSpeedMetersPerSecond
  return mps != null ? [{ value: (mps * 3.6).toFixed(1), unit: 'km/h avg' }] : null
})

/** "Dec 11, 2025" */
const dateDisplay = computed(() => {
  const iso = activityData.value?.startDateLocal
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
})

/** Plain-text distance/duration summary shown above the upload form, before a canvas exists. */
const summaryText = computed(() => {
  const distance = distanceGroup.value.map((s) => `${s.value} ${s.unit}`).join(' ')
  const duration = durationGroup.value.map((s) => `${s.value}${s.unit}`).join(' ')
  return `${distance} · ${duration}`
})

/**
 * The stat row, split into display lines. Distance/duration are always
 * shown; avg power, elevation, and avg speed are opt-in toggles. Once 4
 * stats are active, they wrap to 2 lines of 2 so the row doesn't run too wide.
 */
const statLines = computed((): StatGroup[][] => {
  const groups: StatGroup[] = [distanceGroup.value, durationGroup.value]
  if (showAvgPower.value && avgPowerGroup.value) groups.push(avgPowerGroup.value)
  if (showElevation.value) groups.push(elevationGroup.value)
  if (showAvgSpeed.value && avgSpeedGroup.value) groups.push(avgSpeedGroup.value)

  if (groups.length >= 4) {
    const splitAt = Math.ceil(groups.length / 2)
    return [groups.slice(0, splitAt), groups.slice(splitAt)]
  }
  return [groups]
})

/** Uppercases only the first character — leaves the rest of the ride name as Strava has it. */
function capitalizeFirst(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text
}

// ── Route projection: lat/lng -> canvas xy (equirectangular, scale-to-fit) ─

function projectPoints(
  points: [number, number][],
  canvasW: number,
  canvasH: number,
  padding: number,
): [number, number][] {
  const lats = points.map((p) => p[0])
  const lngs = points.map((p) => p[1])
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)

  const midLat = (minLat + maxLat) / 2
  const lngScale = Math.cos((midLat * Math.PI) / 180)

  const spanX = (maxLng - minLng) * lngScale
  const spanY = maxLat - minLat

  const availW = canvasW - padding * 2
  const availH = canvasH - padding * 2
  const scale = Math.min(
    spanX > 0 ? availW / spanX : Infinity,
    spanY > 0 ? availH / spanY : Infinity,
  )

  const offsetX = padding + (availW - spanX * scale) / 2
  const offsetY = padding + (availH - spanY * scale) / 2

  return points.map(([lat, lng]) => [
    offsetX + (lng - minLng) * lngScale * scale,
    offsetY + (maxLat - lat) * scale, // flip Y: canvas grows downward, latitude grows "upward"
  ])
}

// ── Blur (manual box-blur, not canvas ctx.filter) ────────────────────────
//
// WebKit's CanvasRenderingContext2D.filter support for drawImage() is
// unreliable on iOS Safari (the B&W pixel-manipulation filter below works
// fine there, but a `filter = 'blur(Npx)'` before drawImage silently has no
// effect) — so blur is implemented as pixel manipulation too, same as the
// B&W filter, instead of relying on the canvas filter property.
//
// Three passes of a separable box blur (horizontal sliding-window sum, then
// vertical) is a standard cheap approximation of a Gaussian blur — cost is
// O(width * height) per pass regardless of radius, rather than growing with
// radius like a naive neighborhood-sample blur would.

function boxBlurPass(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
) {
  const size = horizontal ? width : height
  const lineCount = horizontal ? height : width
  const windowSize = radius * 2 + 1
  const idx = (line: number, pos: number) =>
    (horizontal ? line * width + pos : pos * width + line) * 4

  for (let line = 0; line < lineCount; line++) {
    let rSum = 0
    let gSum = 0
    let bSum = 0
    let aSum = 0
    for (let k = -radius; k <= radius; k++) {
      const i = idx(line, Math.min(size - 1, Math.max(0, k)))
      rSum += src[i]!
      gSum += src[i + 1]!
      bSum += src[i + 2]!
      aSum += src[i + 3]!
    }
    for (let pos = 0; pos < size; pos++) {
      const i = idx(line, pos)
      dst[i] = rSum / windowSize
      dst[i + 1] = gSum / windowSize
      dst[i + 2] = bSum / windowSize
      dst[i + 3] = aSum / windowSize

      const removeI = idx(line, Math.min(size - 1, Math.max(0, pos - radius)))
      const addI = idx(line, Math.min(size - 1, Math.max(0, pos + radius + 1)))
      rSum += src[addI]! - src[removeI]!
      gSum += src[addI + 1]! - src[removeI + 1]!
      bSum += src[addI + 2]! - src[removeI + 2]!
      aSum += src[addI + 3]! - src[removeI + 3]!
    }
  }
}

function boxBlurImageData(imageData: ImageData, radius: number, passes = 3) {
  if (radius < 1) return imageData
  const { width, height, data } = imageData
  let a = new Uint8ClampedArray(data)
  let b = new Uint8ClampedArray(data.length)
  const perPassRadius = Math.max(1, Math.round(radius / passes))

  for (let p = 0; p < passes; p++) {
    boxBlurPass(a, b, width, height, perPassRadius, true)
    boxBlurPass(b, a, width, height, perPassRadius, false)
  }
  data.set(a)
  return imageData
}

// ── Black & white noisy filter ───────────────────────────────────────────

function applyBwNoiseFilter(imageData: ImageData, contrastAmount = 40, noiseAmount = 25, brightnessReduction = 0.08) {
  const d = imageData.data
  const contrastFactor = (259 * (contrastAmount + 255)) / (255 * (259 - contrastAmount))
  const brightnessFactor = 1 - brightnessReduction
  for (let i = 0; i < d.length; i += 4) {
    let gray = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!
    gray = contrastFactor * (gray - 128) + 128
    gray *= brightnessFactor
    gray += (Math.random() - 0.5) * noiseAmount * 2
    gray = Math.min(255, Math.max(0, gray))
    d[i] = d[i + 1] = d[i + 2] = gray
  }
  return imageData
}

// ── Render pipeline ──────────────────────────────────────────────────────
//
// Split in two so dragging stays smooth: buildBackground() does the
// expensive part (draw the photo, apply pixel-level filters) onto an
// offscreen canvas whenever the photo or a Photo-style toggle changes.
// renderOverlay() just copies that cached background onto the visible
// canvas and draws the route line + text block on top at their current
// (possibly dragged) offsets — cheap enough to run on every pointermove.

let bgCanvas: HTMLCanvasElement | null = null

async function buildBackground() {
  const img = photoImage.value
  if (!img) return

  const scale = Math.min(1, MAX_CANVAS_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.round(img.naturalWidth * scale)
  const h = Math.round(img.naturalHeight * scale)

  if (!bgCanvas) bgCanvas = document.createElement('canvas')
  bgCanvas.width = w
  bgCanvas.height = h

  const bctx = bgCanvas.getContext('2d')
  if (!bctx) return

  bctx.clearRect(0, 0, w, h)
  bctx.drawImage(img, 0, 0, w, h)

  if (blurEnabled.value) {
    const imageData = bctx.getImageData(0, 0, w, h)
    boxBlurImageData(imageData, Math.max(2, Math.round(w * 0.006)))
    bctx.putImageData(imageData, 0, 0)
  }

  if (bwFilterEnabled.value) {
    const imageData = bctx.getImageData(0, 0, w, h)
    applyBwNoiseFilter(imageData)
    bctx.putImageData(imageData, 0, 0)
  }
}

async function renderOverlay() {
  const canvas = canvasRef.value
  if (!canvas || !bgCanvas) return

  // Canvas text uses whatever font is already loaded at draw time — without
  // this, the first render can fall back to the system font before the
  // self-hosted variable woff2 finishes loading.
  await document.fonts.load(`700 16px ${OVERLAY_FONT_FAMILY}`)

  const w = bgCanvas.width
  const h = bgCanvas.height
  canvas.width = w
  canvas.height = h

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(bgCanvas, 0, 0)

  // Portrait photos get a smaller, more centered default route.
  const isPortrait = h > w

  const points = activityData.value?.points ?? []
  if (points.length > 1) {
    // Larger padding = smaller route relative to the canvas; projectPoints
    // centers the route within the padded box, which is itself centered
    // in the full canvas since padding is uniform on every side.
    const padding = Math.round(Math.min(w, h) * (isPortrait ? 0.3 : 0.2))
    const projected = projectPoints(points, w, h, padding)
      .map(([x, y]) => [x + routeOffsetX.value, y + routeOffsetY.value] as [number, number])

    const lineWidth = Math.max(3, w * 0.007)
    const xs = projected.map((p) => p[0])
    const ys = projected.map((p) => p[1])
    routeBounds = {
      x: Math.min(...xs) - lineWidth,
      y: Math.min(...ys) - lineWidth,
      w: Math.max(...xs) - Math.min(...xs) + lineWidth * 2,
      h: Math.max(...ys) - Math.min(...ys) + lineWidth * 2,
    }

    ctx.save()
    ctx.beginPath()
    projected.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = THEME_ORANGE
    ctx.lineWidth = lineWidth
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.shadowColor = 'rgba(0,0,0,0.5)'
    ctx.shadowBlur = 4
    ctx.stroke()
    ctx.restore()
  }
  else {
    routeBounds = null
  }

  if (activityData.value) {
    const lineHeight = Math.round(w * 0.039)
    const lines = statLines.value

    const pad = Math.round(w * 0.06) + textOffsetX.value
    const baseY = h - Math.round(w * 0.06) - (lines.length - 1) * lineHeight + textOffsetY.value
    const titleFont = `800 ${Math.round(w * 0.043)}px ${OVERLAY_FONT_FAMILY}`
    const dateFont = `700 ${Math.round(w * 0.022)}px ${OVERLAY_FONT_FAMILY}`
    const valueFont = `700 ${Math.round(w * 0.03)}px ${OVERLAY_FONT_FAMILY}`
    const unitFont = `700 ${Math.round(w * 0.021)}px ${OVERLAY_FONT_FAMILY}`
    const unitGap = Math.round(w * 0.004)
    const titleText = capitalizeFirst(activityData.value.name)
    const dateText = showDate.value ? dateDisplay.value : null

    // Title sits directly above the stats block; if the date is shown it's
    // squeezed in between, on its own smaller line.
    const dateY = dateText ? baseY - Math.round(w * 0.041) : null
    const titleY = (dateY ?? baseY) - Math.round(w * (dateText ? 0.052 : 0.064))

    const textColor = 'white'
    const separatorColor = 'rgba(255,255,255,0.6)'

    function drawText(text: string, x: number, y: number) {
      ctx!.fillStyle = textColor
      ctx!.fillText(text, x, y)
    }

    // Measures a stat line's rendered width without drawing, so the drag
    // bounding box can be sized to match exactly what's on screen.
    function measureLineWidth(line: StatGroup[]): number {
      let x = 0
      line.forEach((group, gi) => {
        if (gi > 0) {
          ctx!.font = valueFont
          x += ctx!.measureText('   ·   ').width
        }
        group.forEach((segment, si) => {
          if (si > 0) x += Math.round(w * 0.006)
          ctx!.font = valueFont
          x += ctx!.measureText(segment.value).width + unitGap
          ctx!.font = unitFont
          x += ctx!.measureText(segment.unit).width
        })
      })
      return x
    }

    ctx.save()
    ctx.textBaseline = 'alphabetic'

    ctx.font = titleFont
    const titleWidth = ctx.measureText(titleText).width
    ctx.font = dateFont
    const dateWidth = dateText ? ctx.measureText(dateText).width : 0
    const lineWidths = lines.map((line) => measureLineWidth(line))
    const maxTextWidth = Math.max(titleWidth, dateWidth, ...lineWidths)

    const titleSize = Math.round(w * 0.043)
    const statSize = Math.round(w * 0.03)
    const boundsPadding = Math.round(w * 0.015)
    textBounds = {
      x: pad - boundsPadding,
      y: titleY - titleSize * 0.85 - boundsPadding,
      w: maxTextWidth + boundsPadding * 2,
      h: (baseY + (lines.length - 1) * lineHeight + statSize * 0.3) - (titleY - titleSize * 0.85) + boundsPadding * 2,
    }

    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur = 6

    ctx.font = titleFont
    drawText(titleText, pad, titleY)

    if (dateText && dateY != null) {
      ctx.font = dateFont
      drawText(dateText, pad, dateY)
    }

    lines.forEach((line, i) => {
      let x = pad
      const y = baseY + i * lineHeight
      line.forEach((group, gi) => {
        if (gi > 0) {
          ctx.font = valueFont
          const sep = '   ·   '
          ctx.fillStyle = separatorColor
          ctx.fillText(sep, x, y)
          x += ctx.measureText(sep).width
        }
        group.forEach((segment, si) => {
          if (si > 0) x += Math.round(w * 0.006)

          ctx.font = valueFont
          drawText(segment.value, x, y)
          x += ctx.measureText(segment.value).width + unitGap

          ctx.font = unitFont
          drawText(segment.unit, x, y)
          x += ctx.measureText(segment.unit).width
        })
      })
    })
    ctx.restore()
  }
  else {
    textBounds = null
  }
}

watch([photoImage, bwFilterEnabled, blurEnabled], async () => {
  await buildBackground()
  nextTick(() => renderOverlay())
})

watch(
  [showAvgPower, showElevation, showAvgSpeed, showDate, activityData, textOffsetX, textOffsetY, routeOffsetX, routeOffsetY],
  () => {
    nextTick(() => renderOverlay())
  },
)

// ── Drag-to-reposition ───────────────────────────────────────────────────

function getCanvasPoint(e: PointerEvent): { x: number, y: number } {
  const canvas = canvasRef.value!
  const rect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / rect.width
  const scaleY = canvas.height / rect.height
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY }
}

function pointInBox(p: { x: number, y: number }, box: Box | null): boolean {
  return !!box && p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h
}

function onOverlayPointerDown(e: PointerEvent) {
  const p = getCanvasPoint(e)
  if (pointInBox(p, textBounds)) {
    dragging.value = 'text'
    dragStartOffset = { x: textOffsetX.value, y: textOffsetY.value }
  }
  else if (pointInBox(p, routeBounds)) {
    dragging.value = 'route'
    dragStartOffset = { x: routeOffsetX.value, y: routeOffsetY.value }
  }
  else {
    return
  }
  dragStartPoint = p
  canvasRef.value?.setPointerCapture(e.pointerId)
}

function onOverlayPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const p = getCanvasPoint(e)
  const dx = p.x - dragStartPoint.x
  const dy = p.y - dragStartPoint.y
  if (dragging.value === 'text') {
    textOffsetX.value = dragStartOffset.x + dx
    textOffsetY.value = dragStartOffset.y + dy
  }
  else {
    routeOffsetX.value = dragStartOffset.x + dx
    routeOffsetY.value = dragStartOffset.y + dy
  }
}

function onOverlayPointerUp() {
  dragging.value = null
}

// ── Download ──────────────────────────────────────────────────────────────

function downloadOverlay() {
  const canvas = canvasRef.value
  if (!canvas) return
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `overlay-${activityData.value?.name?.replace(/\s+/g, '-').toLowerCase() ?? 'ride'}.png`
    a.click()
    URL.revokeObjectURL(url)
  }, 'image/png')
}
</script>

<template>
  <div class="min-h-screen bg-stone-50 px-6 py-10">
    <div class="max-w-2xl mx-auto">
      <NuxtLink to="/" class="text-sm text-stone-400 hover:text-stone-600">
        &larr; Back
      </NuxtLink>

      <h1 class="text-xl font-semibold text-stone-800 mt-3">
        Photo overlay
      </h1>

      <div v-if="isLoading" class="mt-8 flex justify-center">
        <BikeSpinner :size="28" />
      </div>

      <UAlert
        v-else-if="loadError"
        class="mt-6"
        color="error"
        variant="soft"
        :title="loadError"
      />

      <div v-else class="mt-6 space-y-5">
        <p class="text-sm text-stone-500">
          {{ activityData?.name }} &middot; {{ summaryText }}
        </p>

        <label class="block">
          <span class="text-sm font-medium text-stone-600">Photo</span>
          <input
            type="file"
            accept="image/*"
            class="mt-1.5 block w-full text-sm text-stone-500 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-orange-50 file:text-orange-600 hover:file:bg-orange-100"
            @change="onFileChange"
          >
        </label>

        <div class="grid grid-cols-2 gap-x-6 gap-y-4">
          <div>
            <p class="text-xs font-semibold text-stone-400 uppercase tracking-wide mb-2">
              Photo style
            </p>
            <div class="space-y-2">
              <label class="flex items-center gap-2 text-sm text-stone-600 select-none">
                <input v-model="bwFilterEnabled" type="checkbox" class="rounded border-stone-300 text-orange-600 focus:ring-orange-500">
                High-contrast noisy black &amp; white
              </label>

              <label class="flex items-center gap-2 text-sm text-stone-600 select-none">
                <input v-model="blurEnabled" type="checkbox" class="rounded border-stone-300 text-orange-600 focus:ring-orange-500">
                Subtle blur
              </label>
            </div>
          </div>

          <div>
            <p class="text-xs font-semibold text-stone-400 uppercase tracking-wide mb-2">
              Metrics
            </p>
            <div class="space-y-2">
              <label class="flex items-center gap-2 text-sm text-stone-600 select-none" :class="{ 'opacity-40': !hasAvgPower }">
                <input
                  v-model="showAvgPower"
                  type="checkbox"
                  class="rounded border-stone-300 text-orange-600 focus:ring-orange-500"
                  :disabled="!hasAvgPower"
                >
                Average power{{ !hasAvgPower ? ' (no power data for this ride)' : '' }}
              </label>

              <label class="flex items-center gap-2 text-sm text-stone-600 select-none">
                <input v-model="showElevation" type="checkbox" class="rounded border-stone-300 text-orange-600 focus:ring-orange-500">
                Elevation gain
              </label>

              <label class="flex items-center gap-2 text-sm text-stone-600 select-none" :class="{ 'opacity-40': !hasAvgSpeed }">
                <input
                  v-model="showAvgSpeed"
                  type="checkbox"
                  class="rounded border-stone-300 text-orange-600 focus:ring-orange-500"
                  :disabled="!hasAvgSpeed"
                >
                Average speed{{ !hasAvgSpeed ? ' (no speed data for this ride)' : '' }}
              </label>

              <label class="flex items-center gap-2 text-sm text-stone-600 select-none">
                <input v-model="showDate" type="checkbox" class="rounded border-stone-300 text-orange-600 focus:ring-orange-500">
                Date
              </label>
            </div>
          </div>
        </div>

        <div class="rounded-xl overflow-hidden flex items-center justify-center">
          <canvas
            v-show="photoImage"
            ref="canvasRef"
            class="max-w-full max-h-[60vh] h-auto block"
            :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
            style="touch-action: none;"
            @pointerdown="onOverlayPointerDown"
            @pointermove="onOverlayPointerMove"
            @pointerup="onOverlayPointerUp"
            @pointercancel="onOverlayPointerUp"
          />
          <p v-if="!photoImage" class="text-sm text-stone-400 py-16">
            Upload a photo to preview the overlay.
          </p>
        </div>

        <p v-if="photoImage" class="text-xs text-stone-400 -mt-2">
          Drag the route line or the text block to reposition them.
          <button type="button" class="underline hover:text-stone-600" @click="resetPositions">
            Reset positions
          </button>
        </p>

        <UButton
          :disabled="!photoImage"
          block
          color="neutral"
          @click="downloadOverlay"
        >
          Download
        </UButton>
      </div>
    </div>
  </div>
</template>
