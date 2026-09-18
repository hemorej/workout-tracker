<script setup lang="ts">
/**
 * Photo overlay page
 *
 * Generates a downloadable PNG: a poster built from a user-uploaded photo and
 * a Strava ride's route line, laid out as a fixed 2:3 sheet — the photo is a
 * bounded plate across the top, and every character (title, date, distance
 * headline, stat grid) sits on a solid ink panel below it. Contrast is fixed
 * by construction: no scrim, shadow, halo or blend mode.
 *
 * Everything is rendered client-side via <canvas> — the server only supplies
 * the decoded route, stats and altitude stream (GET /api/strava/activity/:id).
 * The photo never leaves the browser.
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
  altitudeStream: number[]
  distanceStream: number[]
  /** NP from the matching logged workout's FIT file; null when unavailable. */
  normalizedPowerWatts: number | null
}

const SERIF_FONT_FAMILY = '"Instrument Serif", Georgia, serif'
const SANS_FONT_FAMILY = '"Archivo", system-ui, sans-serif'
const DEFAULT_LINE_COLOR = '#ea580c'
const DEFAULT_TEXT_COLOR = '#ffffff'
/** Swatch palette shared by the line colour and text colour controls. */
const LINE_PALETTE = ['#ea580c', '#eeb902', '#ffffff', '#1c1917', '#5398BE']
/** Fixed ink panel behind the type — the poster is always the "ink" sheet. */
const PANEL_COLOR = '#14110f'
const MUTED_TEXT_COLOR = '#a39a8e'
/** Route line weight, at POSTER_REF_WIDTH — was user-adjustable, now fixed. */
const LINE_WEIGHT = 3.4
/**
 * The design reference width. Every poster type size and offset below is
 * quoted at this width; multiply by `canvasWidth / POSTER_REF_WIDTH` when
 * drawing so the composition scales to any export resolution. The sheet
 * itself is a fixed 432:647 (2:3) ratio; the photo plate is 432×428.
 */
const POSTER_REF_WIDTH = 432

const route = useRoute()
const activityId = route.params.activityId as string

const isLoading = ref(true)
const loadError = ref<string | null>(null)
const activityData = ref<ActivityOverlayData | null>(null)

// ── Photo ────────────────────────────────────────────────────────────────
const photoImage = ref<HTMLImageElement | null>(null)
const photoObjectURL = ref<string | null>(null)
const photoMeta = ref<{ name: string, w: number, h: number } | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

// ── Controls ─────────────────────────────────────────────────────────────
const treated = ref(true) // false = "as shot"
const lineColor = ref(DEFAULT_LINE_COLOR)
const textColor = ref(DEFAULT_TEXT_COLOR)
const title = ref('') // seeded from the activity name
const place = ref('')
// Distance is permanent (it's the headline); the rest are opt-in.
const shownMetrics = ref<Set<string>>(new Set(['distance', 'time', 'avgPower', 'elevation']))

const canvasRef = ref<HTMLCanvasElement | null>(null)
const exportW = ref(0)
const exportH = ref(0)

// ── Draggable route position ─────────────────────────────────────────────
//
// The route line is the only element drawn over the photo, and the only one
// that can be dragged. Offset is in canvas pixel space, relative to its
// default layout position, clamped so it can't be dragged out of the plate.
const routeOffsetX = ref(0)
const routeOffsetY = ref(0)
const dragging = ref<'route' | null>(null)

interface Box { x: number, y: number, w: number, h: number }
// Updated on every renderOverlay() call, read by the pointerdown hit test.
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

onBeforeUnmount(() => {
  if (photoObjectURL.value) URL.revokeObjectURL(photoObjectURL.value)
})

// Seed the title from the Strava activity name, once.
watch(activityData, (d) => {
  if (d && !title.value) title.value = capitalizeFirst(d.name)
}, { immediate: true })

// ── Metrics model ────────────────────────────────────────────────────────

interface MetricDef {
  key: string
  label: string
  /** Uppercase label used for the poster ledger cell (blank = never shown there). */
  ledgerLabel: string
  available: boolean
}

const metricDefs = computed<MetricDef[]>(() => {
  const d = activityData.value
  return [
    { key: 'distance', label: 'Distance', ledgerLabel: '', available: true },
    { key: 'time', label: 'Time', ledgerLabel: 'DURATION', available: true },
    { key: 'avgPower', label: 'Avg power', ledgerLabel: 'AVG POWER', available: d?.avgWatts != null },
    { key: 'elevation', label: 'Elevation', ledgerLabel: 'ELEVATION', available: true },
    { key: 'avgSpeed', label: 'Avg speed', ledgerLabel: 'KM/H AVG', available: d?.avgSpeedMetersPerSecond != null },
    { key: 'date', label: 'Date', ledgerLabel: 'DATE', available: true },
    // NP is FIT-derived — present only when a matching logged workout has FIT data.
    { key: 'np', label: 'Norm. power', ledgerLabel: 'NRM POWER', available: d?.normalizedPowerWatts != null },
  ]
})

const selectedCount = computed(
  () => metricDefs.value.filter((m) => m.available && shownMetrics.value.has(m.key)).length,
)

function toggleMetric(m: MetricDef) {
  if (m.key === 'distance' || !m.available) return
  const next = new Set(shownMetrics.value)
  if (next.has(m.key)) {
    if (next.size > 1) next.delete(m.key)
  }
  else {
    next.add(m.key)
  }
  shownMetrics.value = next
}

function chipClass(m: MetricDef): string {
  if (!m.available) return 'border-[#e7e5e4] bg-white text-[#d6d3d1] cursor-not-allowed'
  if (shownMetrics.value.has(m.key)) return 'border-[#fed7aa] bg-[#fff5ed] text-[#9a3412]'
  return 'border-[#e7e5e4] bg-white text-[#57534f]'
}

// ── Formatting ───────────────────────────────────────────────────────────

function capitalizeFirst(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text
}

function fmtDistanceKm(meters: number): string {
  return (meters / 1000).toFixed(1)
}

/** "2h 08m" or "38m" */
function fmtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** "2h 8m" or "38m" — the looser form used in the page header meta line. */
function fmtTimeLoose(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** "Aug 31, 2026" */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "Aug 29" */
function fmtMonthDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const headerMeta = computed(() => {
  const d = activityData.value
  if (!d) return ''
  return `${d.name} · ${fmtDistanceKm(d.distanceMeters)} km · ${fmtTimeLoose(d.movingTimeSeconds)} · ${fmtMonthDay(d.startDateLocal)}`
})

/** Value string for a ledger metric, "" when it has no data. */
function metricValue(key: string): string {
  const d = activityData.value
  if (!d) return ''
  switch (key) {
    case 'time': return fmtTime(d.movingTimeSeconds)
    case 'avgPower': return d.avgWatts != null ? `${Math.round(d.avgWatts)} W` : ''
    case 'elevation': return `${Math.round(d.elevationGainMeters)} m`
    case 'avgSpeed': return d.avgSpeedMetersPerSecond != null ? (d.avgSpeedMetersPerSecond * 3.6).toFixed(1) : ''
    case 'date': return fmtDate(d.startDateLocal)
    case 'np': return d.normalizedPowerWatts != null ? `${d.normalizedPowerWatts} W` : ''
    default: return ''
  }
}

// Ledger cells = selected metrics minus distance (the headline) and date
// (which rides in the top-right of row 1 with the place), in panel order,
// capped at the four-up stat grid, left-packed.
const LEDGER_ORDER = ['time', 'avgPower', 'elevation', 'avgSpeed', 'np']
const ledgerCells = computed(() =>
  LEDGER_ORDER
    .map((k) => metricDefs.value.find((m) => m.key === k)!)
    .filter((m) => m.available && shownMetrics.value.has(m.key))
    .slice(0, 4)
    .map((m) => ({ label: m.ledgerLabel, value: metricValue(m.key) })),
)

// ── Photo upload ─────────────────────────────────────────────────────────

// Downsizes only if the source photo exceeds this on its longest edge —
// keeps huge phone photos (4000px+) from producing a slow-to-render, huge
// canvas. The download itself is PNG (lossless), so this cap is the only
// resolution loss in the pipeline.
const MAX_CANVAS_EDGE = 1600

function pickFile() {
  fileInput.value?.click()
}

function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return

  if (photoObjectURL.value) URL.revokeObjectURL(photoObjectURL.value)
  const url = URL.createObjectURL(file)
  photoObjectURL.value = url

  const img = new Image()
  img.onload = () => {
    photoImage.value = img
    photoMeta.value = { name: file.name, w: img.naturalWidth, h: img.naturalHeight }
    // A new photo can have very different dimensions — start the route back
    // at its default layout position rather than carrying over a stale offset.
    routeOffsetX.value = 0
    routeOffsetY.value = 0
  }
  img.src = url
}

function resetPositions() {
  routeOffsetX.value = 0
  routeOffsetY.value = 0
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
// unreliable on iOS Safari — so blur is implemented as pixel manipulation,
// same as the B&W filter, instead of relying on the canvas filter property.
// Three passes of a separable box blur approximates a Gaussian at
// O(width * height) per pass regardless of radius.

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
  const a = new Uint8ClampedArray(data)
  const b = new Uint8ClampedArray(data.length)
  const perPassRadius = Math.max(1, Math.round(radius / passes))

  for (let p = 0; p < passes; p++) {
    boxBlurPass(a, b, width, height, perPassRadius, true)
    boxBlurPass(b, a, width, height, perPassRadius, false)
  }
  data.set(a)
  return imageData
}

// ── Photo filters ────────────────────────────────────────────────────────

/** High-contrast noisy black & white. Contrast / grain / brightness values are unchanged. */
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

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)

/** "As shot": a light saturate(1.03) contrast(1.05), matching the design. */
function applyAsShotFilter(imageData: ImageData, contrast = 1.05, saturation = 1.03) {
  const d = imageData.data
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!
    const g = d[i + 1]!
    const b = d[i + 2]!
    const gray = 0.299 * r + 0.587 * g + 0.114 * b
    d[i] = clamp255((gray + (r - gray) * saturation - 128) * contrast + 128)
    d[i + 1] = clamp255((gray + (g - gray) * saturation - 128) * contrast + 128)
    d[i + 2] = clamp255((gray + (b - gray) * saturation - 128) * contrast + 128)
  }
  return imageData
}

// ── Render pipeline ──────────────────────────────────────────────────────
//
// Split in two so dragging stays smooth: buildBackground() does the
// expensive part (draw the photo, apply pixel-level filters) onto an
// offscreen canvas whenever the photo or the Photo effect changes.
// renderOverlay() copies that cached background onto the visible canvas and
// draws the scrim + graphic + type on top — cheap enough to run on every
// pointermove.

let bgCanvas: HTMLCanvasElement | null = null

async function buildBackground() {
  const img = photoImage.value
  if (!img) return

  // Canvas width follows the photo's longest edge (capped), same as before;
  // the sheet's height is then fixed by the 432:647 poster ratio rather than
  // the photo's own aspect ratio — the photo plate is cover-cropped into it.
  const scale = Math.min(1, MAX_CANVAS_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.round(img.naturalWidth * scale)
  const plateW = w
  const plateH = Math.round(w * (428 / POSTER_REF_WIDTH))
  exportW.value = w
  exportH.value = Math.round(w * (647 / POSTER_REF_WIDTH))

  if (!bgCanvas) bgCanvas = document.createElement('canvas')
  bgCanvas.width = plateW
  bgCanvas.height = plateH

  const bctx = bgCanvas.getContext('2d')
  if (!bctx) return

  bctx.clearRect(0, 0, plateW, plateH)

  // Cover-fit the photo into the plate, then draw slightly overscaled so a
  // blurred edge can't reveal a soft border (the design's -14px trick at a
  // 432px reference poster width).
  const o = Math.round(plateW * (14 / POSTER_REF_WIDTH))
  const coverScale = Math.max(plateW / img.naturalWidth, plateH / img.naturalHeight)
  const drawW = img.naturalWidth * coverScale
  const drawH = img.naturalHeight * coverScale
  const dx = (plateW - drawW) / 2 - o
  const dy = (plateH - drawH) / 2 - o
  bctx.drawImage(img, dx, dy, drawW + o * 2, drawH + o * 2)

  if (treated.value) {
    // Blur, then the high-contrast B&W + grain pass so the grain reads crisp
    // on top. Blur radius, contrast and grain size are unchanged.
    const imageData = bctx.getImageData(0, 0, plateW, plateH)
    boxBlurImageData(imageData, Math.max(2, Math.round(plateW * 0.006)))
    applyBwNoiseFilter(imageData)
    bctx.putImageData(imageData, 0, 0)
  }
  else {
    const imageData = bctx.getImageData(0, 0, plateW, plateH)
    applyAsShotFilter(imageData)
    bctx.putImageData(imageData, 0, 0)
  }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const word of words) {
    const test = cur ? `${cur} ${word}` : word
    if (cur && ctx.measureText(test).width > maxWidth) {
      lines.push(cur)
      cur = word
    }
    else {
      cur = test
    }
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : ['']
}

async function renderOverlay() {
  const canvas = canvasRef.value
  if (!canvas || !bgCanvas) return

  // Canvas text uses whatever font is loaded at draw time — wait for the
  // weights the poster needs before the first render.
  await Promise.all([
    document.fonts.load(`400 16px ${SERIF_FONT_FAMILY}`),
    document.fonts.load(`600 16px ${SANS_FONT_FAMILY}`),
    document.fonts.load(`700 16px ${SANS_FONT_FAMILY}`),
    document.fonts.load(`800 16px ${SANS_FONT_FAMILY}`),
  ])

  const w = exportW.value
  const h = exportH.value
  if (!w || !h) return
  canvas.width = w
  canvas.height = h

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const k = w / POSTER_REF_WIDTH
  const plateH = bgCanvas.height

  // 1. Fill the sheet with the panel colour, 2. composite the photo plate.
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = PANEL_COLOR
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bgCanvas, 0, 0)

  const accent = lineColor.value

  // 3. Route, clipped to the plate — the only thing drawn over the photo.
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, w, plateH)
  ctx.clip()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  drawRoute(ctx, w, plateH, k, accent)
  ctx.restore()

  // 4. Accent rule, flush on the bottom edge of the plate.
  ctx.fillStyle = accent
  ctx.fillRect(0, plateH - 5 * k, w, 5 * k)

  // 5. Type, panel only.
  drawType(ctx, w, k)
}

function drawRoute(ctx: CanvasRenderingContext2D, plateW: number, plateH: number, k: number, accent: string) {
  const points = activityData.value?.points ?? []
  if (points.length <= 1) {
    routeBounds = null
    return
  }

  const padding = Math.round(Math.min(plateW, plateH) * 0.2)
  const basePoints = projectPoints(points, plateW, plateH, padding)
  const lw = LINE_WEIGHT * k

  const xs0 = basePoints.map((p) => p[0])
  const ys0 = basePoints.map((p) => p[1])
  const minX0 = Math.min(...xs0) - lw
  const maxX0 = Math.max(...xs0) + lw
  const minY0 = Math.min(...ys0) - lw
  const maxY0 = Math.max(...ys0) + lw

  // Clamp the drag offset so the projected route can't leave the plate.
  const clamp = (value: number, lo: number, hi: number) => (lo <= hi ? Math.min(Math.max(value, lo), hi) : 0)
  const dx = clamp(routeOffsetX.value, -minX0, plateW - maxX0)
  const dy = clamp(routeOffsetY.value, -minY0, plateH - maxY0)
  if (dx !== routeOffsetX.value) routeOffsetX.value = dx
  if (dy !== routeOffsetY.value) routeOffsetY.value = dy

  const projected = basePoints.map(([x, y]) => [x + dx, y + dy] as [number, number])

  ctx.beginPath()
  projected.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.strokeStyle = accent
  ctx.lineWidth = lw
  ctx.stroke()

  // Filled start dot.
  ctx.beginPath()
  ctx.arc(projected[0]![0], projected[0]![1], 5 * k, 0, Math.PI * 2)
  ctx.fillStyle = accent
  ctx.fill()

  const xs = projected.map((p) => p[0])
  const ys = projected.map((p) => p[1])
  routeBounds = {
    x: Math.min(...xs) - lw,
    y: Math.min(...ys) - lw,
    w: Math.max(...xs) - Math.min(...xs) + lw * 2,
    h: Math.max(...ys) - Math.min(...ys) + lw * 2,
  }
}

function drawType(ctx: CanvasRenderingContext2D, w: number, k: number) {
  const d = activityData.value
  if (!d) return

  const setFont = (family: string, weight: number, size: number, letterSpacingEm = 0) => {
    ctx.font = `${weight} ${size}px ${family}`
    if ('letterSpacing' in ctx) {
      ;(ctx as unknown as { letterSpacing: string }).letterSpacing = `${(letterSpacingEm * size).toFixed(2)}px`
    }
  }
  const resetLetterSpacing = () => {
    if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px'
  }

  ctx.save()

  const innerLeft = 28 * k
  const innerRight = w - 28 * k
  const innerWidth = w - 56 * k

  // ── Row 1: title (serif) + place/date, baseline-aligned ──
  setFont(SERIF_FONT_FAMILY, 400, 42 * k)
  const titleLines = wrapText(ctx, title.value || capitalizeFirst(d.name), innerWidth * 0.7).slice(0, 2)
  const titleLineHeight = 40 * k
  const baseTitleBaseline = 484 * k
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = textColor.value
  titleLines.forEach((ln, i) => {
    ctx.fillText(ln, innerLeft, baseTitleBaseline + i * titleLineHeight)
  })
  resetLetterSpacing()
  // If the title wraps, every row below shifts down by the extra line(s).
  const extra = (titleLines.length - 1) * titleLineHeight
  const lastTitleBaseline = baseTitleBaseline + extra

  const parts: string[] = []
  if (place.value.trim()) parts.push(place.value.trim())
  if (shownMetrics.value.has('date')) parts.push(fmtDate(d.startDateLocal))
  const topLine = parts.join(' · ').toUpperCase()
  if (topLine) {
    setFont(SANS_FONT_FAMILY, 700, 10 * k, 0.16)
    ctx.textAlign = 'right'
    ctx.fillStyle = MUTED_TEXT_COLOR
    ctx.fillText(topLine, innerRight, lastTitleBaseline)
    resetLetterSpacing()
  }

  // ── Hairline ──
  const hairlineY = 504 * k + extra
  ctx.strokeStyle = 'rgba(242,237,227,0.24)'
  ctx.lineWidth = Math.max(1, k)
  ctx.beginPath()
  ctx.moveTo(innerLeft, hairlineY)
  ctx.lineTo(innerRight, hairlineY)
  ctx.stroke()

  // ── Row 2: distance headline ──
  const distBaseline = 559 * k + extra
  const unitBaseline = 555 * k + extra
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  setFont(SANS_FONT_FAMILY, 800, 52 * k, -0.04)
  ctx.fillStyle = textColor.value
  const distText = fmtDistanceKm(d.distanceMeters)
  ctx.fillText(distText, innerLeft, distBaseline)
  const distWidth = ctx.measureText(distText).width
  resetLetterSpacing()

  setFont(SANS_FONT_FAMILY, 700, 10 * k, 0.14)
  ctx.fillStyle = lineColor.value
  ctx.fillText('KM', innerLeft + distWidth + 9 * k, unitBaseline)
  resetLetterSpacing()

  // ── Row 3: four-up stat grid, left-packed ──
  const cells = ledgerCells.value
  if (cells.length) {
    const colGap = 10 * k
    const colW = (innerWidth - 3 * colGap) / 4
    const valueTop = 573 * k + extra
    const labelTop = 595 * k + extra
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    cells.forEach((c, i) => {
      const x = innerLeft + i * (colW + colGap)

      setFont(SANS_FONT_FAMILY, 600, 19 * k)
      ctx.fillStyle = textColor.value
      ctx.fillText(c.value, x, valueTop)

      setFont(SANS_FONT_FAMILY, 700, 9 * k, 0.12)
      ctx.fillStyle = MUTED_TEXT_COLOR
      ctx.fillText(c.label, x, labelTop)
      resetLetterSpacing()
    })
  }

  ctx.restore()
}

watch([photoImage, treated], async () => {
  await buildBackground()
  nextTick(() => renderOverlay())
})

watch(
  [lineColor, textColor, title, place, shownMetrics, activityData, routeOffsetX, routeOffsetY],
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
  if (!pointInBox(p, routeBounds)) return
  dragging.value = 'route'
  dragStartOffset = { x: routeOffsetX.value, y: routeOffsetY.value }
  dragStartPoint = p
  canvasRef.value?.setPointerCapture(e.pointerId)
}

function onOverlayPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const p = getCanvasPoint(e)
  const dx = p.x - dragStartPoint.x
  const dy = p.y - dragStartPoint.y
  routeOffsetX.value = dragStartOffset.x + dx
  routeOffsetY.value = dragStartOffset.y + dy
}

function onOverlayPointerUp() {
  dragging.value = null
}

// ── Download ─────────────────────────────────────────────────────────────

function downloadOverlay() {
  const canvas = canvasRef.value
  if (!canvas) return
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const slug = (title.value || 'ride').trim().replace(/\s+/g, '-').toLowerCase().replace(/[^a-z0-9-]/g, '')
    a.download = `overlay-${slug || 'ride'}.png`
    a.click()
    URL.revokeObjectURL(url)
  }, 'image/png')
}
</script>

<template>
  <div class="flex h-screen flex-col bg-[#f7f6f4]">
    <div v-if="isLoading" class="flex flex-1 items-center justify-center">
      <BikeSpinner :size="28" />
    </div>

    <UAlert
      v-else-if="loadError"
      class="m-6 max-w-md"
      color="error"
      variant="soft"
      :title="loadError"
    />

    <div
      v-else
      class="flex min-h-0 flex-1 flex-col overflow-hidden bg-white"
    >
      <!-- Header bar -->
      <div class="flex flex-wrap items-center gap-x-[14px] gap-y-2 border-b border-[#f0efed] px-[26px] py-[18px]">
        <NuxtLink
          to="/"
          class="flex items-center gap-[7px] text-[13px] font-medium text-[#a8a29e] transition-colors hover:text-[#57534f]"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M8.5 2.5 4 7l4.5 4.5" />
          </svg>
          Back
        </NuxtLink>
        <div class="h-4 w-px bg-[#e7e5e4]" />
        <h1 class="text-[15px] font-semibold text-[#1c1917]">
          Photo overlay
        </h1>
        <span class="text-[13px] text-[#a8a29e] tabular-nums">{{ headerMeta }}</span>
        <div class="flex-1" />
        <div class="flex items-center gap-2 text-[12px] font-medium text-[#a8a29e]">
          <span class="size-[6px] rounded-full bg-[#84cc16]" />
          Strava route loaded
        </div>
      </div>

      <!-- Body -->
      <div class="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[1fr_400px] lg:overflow-hidden">
        <!-- Preview stage -->
        <div class="flex flex-col items-center gap-4 bg-[#eceae7] p-[34px] lg:min-h-0 lg:justify-center lg:overflow-y-auto">
          <div class="w-full max-w-[420px] overflow-hidden shadow-[0_16px_36px_rgba(28,25,23,0.2)]">
            <canvas
              v-show="photoImage"
              ref="canvasRef"
              class="block h-auto w-full"
              :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
              style="touch-action: none;"
              @pointerdown="onOverlayPointerDown"
              @pointermove="onOverlayPointerMove"
              @pointerup="onOverlayPointerUp"
              @pointercancel="onOverlayPointerUp"
            />
            <div
              v-if="!photoImage"
              class="flex aspect-[432/647] items-center justify-center bg-[#161412] text-[13px] text-white/50"
            >
              Upload a photo to preview the overlay.
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-center gap-x-[14px] gap-y-1 text-[12px] text-[#8a827a]">
            <span>Drag the route to reposition</span>
            <span class="text-[#c7c2bd]">·</span>
            <button
              type="button"
              class="underline underline-offset-2 hover:text-[#57534f]"
              @click="resetPositions"
            >
              Reset positions
            </button>
            <template v-if="photoImage">
              <span class="text-[#c7c2bd]">·</span>
              <span class="tabular-nums">{{ exportW }} × {{ exportH }} px</span>
            </template>
          </div>
        </div>

        <!-- Control panel -->
        <div class="flex flex-col border-t border-[#f0efed] lg:min-h-0 lg:border-l lg:border-t-0">
          <div class="grid gap-y-[22px] px-6 pb-2 pt-[22px] lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            <!-- Photo -->
            <div>
              <p class="mb-[9px] text-[10px] font-semibold uppercase tracking-[0.11em] text-[#a8a29e]">
                Photo
              </p>
              <input
                ref="fileInput"
                type="file"
                accept="image/*"
                class="hidden"
                @change="onFileChange"
              >
              <button
                v-if="!photoImage"
                type="button"
                class="flex w-full items-center justify-center rounded-[11px] border border-dashed border-[#d6d3d1] px-[11px] py-[14px] text-[12.5px] font-medium text-[#78716c] hover:border-[#a8a29e]"
                @click="pickFile"
              >
                Choose a photo
              </button>
              <div
                v-else
                class="flex items-center gap-[11px] rounded-[11px] border border-[#e7e5e4] px-[11px] py-[9px] hover:border-[#d6d3d1]"
              >
                <img
                  :src="photoObjectURL!"
                  alt=""
                  class="size-10 flex-none rounded-[7px] object-cover"
                >
                <div class="min-w-0 flex-1">
                  <div class="truncate text-[12.5px] font-medium text-[#1c1917]">
                    {{ photoMeta?.name }}
                  </div>
                  <div class="mt-0.5 text-[11px] text-[#a8a29e] tabular-nums">
                    {{ photoMeta?.w }} × {{ photoMeta?.h }} · stays in your browser
                  </div>
                </div>
                <button
                  type="button"
                  class="flex-none rounded-[7px] bg-[#fff5ed] px-[10px] py-[5px] text-[11.5px] font-semibold text-[#ea580c] hover:bg-[#ffe9d8]"
                  @click="pickFile"
                >
                  Replace
                </button>
              </div>
            </div>

            <!-- Photo effect -->
            <div>
              <p class="mb-[9px] text-[10px] font-semibold uppercase tracking-[0.11em] text-[#a8a29e]">
                Photo effect
              </p>
              <div class="flex w-full rounded-[9px] bg-[#f5f5f4] p-[3px]">
                <button
                  type="button"
                  class="flex-1 rounded-[6px] py-[6px] text-center text-[12px]"
                  :class="!treated
                    ? 'bg-white font-semibold text-[#1c1917] shadow-[0_1px_2px_rgba(28,25,23,0.08)]'
                    : 'font-medium text-[#78716c]'"
                  @click="treated = false"
                >
                  As shot
                </button>
                <button
                  type="button"
                  class="flex-1 rounded-[6px] py-[6px] text-center text-[12px]"
                  :class="treated
                    ? 'bg-white font-semibold text-[#1c1917] shadow-[0_1px_2px_rgba(28,25,23,0.08)]'
                    : 'font-medium text-[#78716c]'"
                  @click="treated = true"
                >
                  B&amp;W grain
                </button>
              </div>
              <p class="mt-2 text-[11px] text-[#c7c2bd]">
                Black and white, grain and a soft blur, applied together.
              </p>
            </div>

            <!-- Colours -->
            <div>
              <p class="mb-[9px] text-[10px] font-semibold uppercase tracking-[0.11em] text-[#a8a29e]">
                Colours
              </p>
              <div class="flex flex-wrap gap-x-6 gap-y-3">
                <div>
                  <div class="mb-[7px] text-[11.5px] font-medium text-[#57534f]">
                    Line colour
                  </div>
                  <div class="flex gap-1.5">
                    <button
                      v-for="c in LINE_PALETTE"
                      :key="`line-${c}`"
                      type="button"
                      class="size-[24px] rounded-full"
                      :style="{
                        background: c,
                        border: c.toLowerCase() === '#ffffff' ? '1px solid #e7e5e4' : 'none',
                        boxShadow: lineColor === c ? `0 0 0 2px #fff, 0 0 0 4px ${c}` : 'none',
                      }"
                      @click="lineColor = c"
                    />
                  </div>
                </div>
                <div>
                  <div class="mb-[7px] text-[11.5px] font-medium text-[#57534f]">
                    Text colour
                  </div>
                  <div class="flex gap-1.5">
                    <button
                      v-for="c in LINE_PALETTE"
                      :key="`text-${c}`"
                      type="button"
                      class="size-[24px] rounded-full"
                      :style="{
                        background: c,
                        border: c.toLowerCase() === '#ffffff' ? '1px solid #e7e5e4' : 'none',
                        boxShadow: textColor === c ? `0 0 0 2px #fff, 0 0 0 4px ${c}` : 'none',
                      }"
                      @click="textColor = c"
                    />
                  </div>
                </div>
              </div>
            </div>

            <!-- Text -->
            <div>
              <p class="mb-[9px] text-[10px] font-semibold uppercase tracking-[0.11em] text-[#a8a29e]">
                Text
              </p>
              <div class="grid gap-y-2">
                <div class="rounded-[10px] border border-[#e7e5e4] px-[11px] py-2 focus-within:border-[#d6d3d1]">
                  <div class="text-[9.5px] uppercase tracking-[0.1em] text-[#c7c2bd]">
                    Title
                  </div>
                  <input
                    v-model="title"
                    type="text"
                    class="mt-px w-full bg-transparent text-[13px] font-semibold text-[#1c1917] outline-none"
                  >
                </div>
                <div class="rounded-[10px] border border-[#e7e5e4] px-[11px] py-2 focus-within:border-[#d6d3d1]">
                  <div class="text-[9.5px] uppercase tracking-[0.1em] text-[#c7c2bd]">
                    Place
                  </div>
                  <input
                    v-model="place"
                    type="text"
                    placeholder="—"
                    class="mt-px w-full bg-transparent text-[13px] font-semibold text-[#1c1917] outline-none placeholder:text-[#d6d3d1]"
                  >
                </div>
              </div>
            </div>

            <!-- Metrics -->
            <div>
              <div class="mb-[9px] flex items-baseline justify-between">
                <span class="text-[10px] font-semibold uppercase tracking-[0.11em] text-[#a8a29e]">Metrics</span>
                <span class="text-[11px] text-[#c7c2bd]">{{ selectedCount }} of {{ metricDefs.length }}</span>
              </div>
              <div class="flex flex-wrap gap-[7px]">
                <button
                  v-for="m in metricDefs"
                  :key="m.key"
                  type="button"
                  :disabled="!m.available || m.key === 'distance'"
                  class="rounded-full border px-[11px] py-[5px] text-[12px] font-medium"
                  :class="chipClass(m)"
                  @click="toggleMetric(m)"
                >
                  {{ m.label }}
                </button>
              </div>
            </div>
          </div>

          <div class="sticky bottom-0 border-t border-[#f0efed] bg-white px-6 pb-[22px] pt-4 lg:static">
            <button
              type="button"
              :disabled="!photoImage"
              class="w-full rounded-[11px] bg-[#1c1917] py-3 text-center text-[14px] font-semibold text-white transition-colors hover:bg-[#292524] disabled:opacity-40"
              @click="downloadOverlay"
            >
              Download PNG
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

