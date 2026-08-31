<script setup lang="ts">
/**
 * Photo overlay page
 *
 * Generates a downloadable PNG: a user-uploaded photo with a Strava ride's
 * route line (or elevation profile) and a stat "ledger" composited on top —
 * a full-bleed photo, a bottom-weighted scrim for legibility, place/date +
 * title top-left, distance as an oversized headline bottom-left, and a
 * four-cell stat ledger bottom-right.
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
}

const OVERLAY_FONT_FAMILY = '"Hanken Grotesk", system-ui, sans-serif'
const DEFAULT_LINE_COLOR = '#ea580c'
/** Swatch palette for the route/elevation line. */
const LINE_PALETTE = ['#ea580c', '#eeb902', '#ffffff', '#1c1917', '#2d7dd2']
/**
 * The design reference width. Every poster type size and offset below is
 * quoted at this width; multiply by `canvasWidth / POSTER_REF_WIDTH` when
 * drawing so the composition scales to any export resolution.
 */
const POSTER_REF_WIDTH = 420

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
const overlayGraphic = ref<'route' | 'elevation'>('route')
const lineColor = ref(DEFAULT_LINE_COLOR)
const lineWeight = ref(3.4) // px at POSTER_REF_WIDTH, range 1.5–6.0
const title = ref('') // seeded from the activity name
const place = ref('')
// Distance is permanent (it's the headline); the rest are opt-in.
const shownMetrics = ref<Set<string>>(new Set(['distance', 'time', 'avgPower', 'elevation']))

const canvasRef = ref<HTMLCanvasElement | null>(null)
const exportW = ref(0)
const exportH = ref(0)

// ── Draggable overlay positions ──────────────────────────────────────────
//
// The graphic (route/elevation) and the top-left text block can each be
// dragged. Offsets are in canvas pixel space, relative to each element's
// default layout position.
const textOffsetX = ref(0)
const textOffsetY = ref(0)
const routeOffsetX = ref(0)
const routeOffsetY = ref(0)
const dragging = ref<'text' | 'route' | null>(null)

interface Box { x: number, y: number, w: number, h: number }
// Updated on every renderOverlay() call, read by the pointerdown hit test.
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

onBeforeUnmount(() => {
  if (photoObjectURL.value) URL.revokeObjectURL(photoObjectURL.value)
})

// Seed the title from the Strava activity name, once.
watch(activityData, (d) => {
  if (d && !title.value) title.value = capitalizeFirst(d.name)
}, { immediate: true })

const hasElevationProfile = computed(() => (activityData.value?.altitudeStream?.length ?? 0) > 2)

// If elevation isn't available, don't leave the switch stuck on it.
watch(hasElevationProfile, (ok) => {
  if (!ok && overlayGraphic.value === 'elevation') overlayGraphic.value = 'route'
})

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
    { key: 'time', label: 'Time', ledgerLabel: 'MOVING', available: true },
    { key: 'avgPower', label: 'Avg power', ledgerLabel: 'AVG POWER', available: d?.avgWatts != null },
    { key: 'elevation', label: 'Elevation', ledgerLabel: 'CLIMBED', available: true },
    { key: 'avgSpeed', label: 'Avg speed', ledgerLabel: 'AVG SPEED', available: d?.avgSpeedMetersPerSecond != null },
    { key: 'date', label: 'Date', ledgerLabel: 'DATE', available: true },
    // Normalised power is FIT-derived, not on the Strava activity payload.
    { key: 'np', label: 'Norm. power', ledgerLabel: 'NP', available: false },
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
    case 'avgSpeed': return d.avgSpeedMetersPerSecond != null ? `${(d.avgSpeedMetersPerSecond * 3.6).toFixed(1)} km/h` : ''
    case 'date': return fmtDate(d.startDateLocal)
    default: return ''
  }
}

// Ledger cells = selected metrics minus distance (the headline) and date
// (which rides in the top-left line with the place), in panel order, capped
// at the 2×2 grid.
const LEDGER_ORDER = ['time', 'avgPower', 'elevation', 'avgSpeed', 'np']
const ledgerCells = computed(() =>
  LEDGER_ORDER
    .map((k) => metricDefs.value.find((m) => m.key === k)!)
    .filter((m) => m.available && shownMetrics.value.has(m.key))
    .slice(0, 4)
    .map((m) => ({ label: m.ledgerLabel, value: metricValue(m.key) })),
)

const weightPct = computed(() => ((lineWeight.value - 1.5) / (6 - 1.5)) * 100)

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
    // A new photo can have very different dimensions — start overlays back at
    // their default layout position rather than carrying over a stale offset.
    textOffsetX.value = 0
    textOffsetY.value = 0
    routeOffsetX.value = 0
    routeOffsetY.value = 0
  }
  img.src = url
}

function resetPositions() {
  textOffsetX.value = 0
  textOffsetY.value = 0
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

  const scale = Math.min(1, MAX_CANVAS_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.round(img.naturalWidth * scale)
  const h = Math.round(img.naturalHeight * scale)
  exportW.value = w
  exportH.value = h

  if (!bgCanvas) bgCanvas = document.createElement('canvas')
  bgCanvas.width = w
  bgCanvas.height = h

  const bctx = bgCanvas.getContext('2d')
  if (!bctx) return

  bctx.clearRect(0, 0, w, h)
  // Draw slightly overscaled so a blurred edge can't reveal a soft border
  // (the design insets the photo layer by -14px at a 420px poster).
  const o = Math.round(w * (14 / POSTER_REF_WIDTH))
  bctx.drawImage(img, -o, -o, w + o * 2, h + o * 2)

  if (treated.value) {
    // Blur, then the high-contrast B&W + grain pass so the grain reads crisp
    // on top. Blur radius, contrast and grain size are unchanged.
    const imageData = bctx.getImageData(0, 0, w, h)
    boxBlurImageData(imageData, Math.max(2, Math.round(w * 0.006)))
    applyBwNoiseFilter(imageData)
    bctx.putImageData(imageData, 0, 0)
  }
  else {
    const imageData = bctx.getImageData(0, 0, w, h)
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
  await document.fonts.load(`700 16px ${OVERLAY_FONT_FAMILY}`)
  await document.fonts.load(`800 16px ${OVERLAY_FONT_FAMILY}`)

  const w = bgCanvas.width
  const h = bgCanvas.height
  canvas.width = w
  canvas.height = h

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const k = w / POSTER_REF_WIDTH

  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(bgCanvas, 0, 0)

  // ── Scrim: what makes the type legible over an untreated photo. ──
  const scrim = ctx.createLinearGradient(0, 0, 0, h)
  scrim.addColorStop(0, 'rgba(0,0,0,0.5)')
  scrim.addColorStop(0.34, 'rgba(0,0,0,0.12)')
  scrim.addColorStop(0.62, 'rgba(0,0,0,0.34)')
  scrim.addColorStop(1, 'rgba(0,0,0,0.82)')
  ctx.fillStyle = scrim
  ctx.fillRect(0, 0, w, h)

  const accent = lineColor.value

  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (overlayGraphic.value === 'elevation' && hasElevationProfile.value) {
    drawElevation(ctx, w, h, k, accent)
  }
  else {
    drawRoute(ctx, w, h, k, accent)
  }
  ctx.restore()

  drawType(ctx, w, h, k, accent)
}

function drawRoute(ctx: CanvasRenderingContext2D, w: number, h: number, k: number, accent: string) {
  const points = activityData.value?.points ?? []
  if (points.length <= 1) {
    routeBounds = null
    return
  }

  // Larger padding = smaller route; the route is then nudged up by 40px
  // (at the reference width) so it sits above the bottom-heavy type.
  const padding = Math.round(Math.min(w, h) * 0.2)
  const dx = routeOffsetX.value
  const dy = routeOffsetY.value - 40 * k
  const projected = projectPoints(points, w, h, padding)
    .map(([x, y]) => [x + dx, y + dy] as [number, number])

  const lw = lineWeight.value * k

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

function drawElevation(ctx: CanvasRenderingContext2D, w: number, h: number, k: number, accent: string) {
  const alt = activityData.value?.altitudeStream ?? []
  if (alt.length < 2) {
    routeBounds = null
    return
  }
  const dist = activityData.value?.distanceStream ?? []
  const useDist = dist.length === alt.length
    && (dist[dist.length - 1]! - dist[0]!) > 0

  const bandTop = h * 0.56 + routeOffsetY.value
  const bandH = 86 * k
  const min = Math.min(...alt)
  const max = Math.max(...alt)
  const span = max - min || 1
  const x0 = routeOffsetX.value

  const xAt = (i: number) => x0 + (useDist
    ? ((dist[i]! - dist[0]!) / (dist[dist.length - 1]! - dist[0]!)) * w
    : (i / (alt.length - 1)) * w)
  const yAt = (v: number) => bandTop + bandH - ((v - min) / span) * bandH

  ctx.beginPath()
  alt.forEach((v, i) => {
    const x = xAt(i)
    const y = yAt(v)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.strokeStyle = accent
  // 0.82× so it reads as the same optical weight as the route line.
  ctx.lineWidth = lineWeight.value * 0.82 * k
  ctx.stroke()

  routeBounds = { x: x0, y: bandTop, w, h: bandH }
}

function drawType(ctx: CanvasRenderingContext2D, w: number, h: number, k: number, accent: string) {
  const d = activityData.value
  if (!d) {
    textBounds = null
    return
  }

  const setFont = (weight: number, size: number, letterSpacingEm = 0) => {
    ctx.font = `${weight} ${size}px ${OVERLAY_FONT_FAMILY}`
    if ('letterSpacing' in ctx) {
      ;(ctx as unknown as { letterSpacing: string }).letterSpacing = `${(letterSpacingEm * size).toFixed(2)}px`
    }
  }
  const resetLetterSpacing = () => {
    if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px'
  }

  ctx.save()

  const padL = 32 * k
  const padR = 32 * k

  // ── Top-left cluster: place · date, then title (draggable as one) ──
  const tx = padL + textOffsetX.value
  const clusterTop = 32 * k + textOffsetY.value
  let ty = clusterTop
  let clusterMaxW = 0
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'

  const parts: string[] = []
  if (place.value.trim()) parts.push(place.value.trim())
  if (shownMetrics.value.has('date')) parts.push(fmtDate(d.startDateLocal))
  // The line is drawn uppercase with wide tracking (matches the design).
  const topLine = parts.join(' · ').toUpperCase()

  if (topLine) {
    setFont(600, 10 * k, 0.24)
    ctx.fillStyle = 'rgba(255,255,255,0.78)'
    ctx.fillText(topLine, tx, ty)
    clusterMaxW = Math.max(clusterMaxW, ctx.measureText(topLine).width)
    ty += 10 * k
  }

  ty += 9 * k
  setFont(800, 30 * k, -0.015)
  ctx.fillStyle = '#fff'
  const titleLines = wrapText(ctx, title.value || capitalizeFirst(d.name), 0.78 * w)
  const titleLineHeight = 30 * k * 1.02
  for (const ln of titleLines) {
    ctx.fillText(ln, tx, ty)
    clusterMaxW = Math.max(clusterMaxW, ctx.measureText(ln).width)
    ty += titleLineHeight
  }
  resetLetterSpacing()

  const bp = 6 * k
  textBounds = {
    x: tx - bp,
    y: clusterTop - bp,
    w: clusterMaxW + bp * 2,
    h: (ty - clusterTop) + bp * 2,
  }

  // ── Bottom row (pinned): distance headline left, ledger right ──
  const rowBottom = h - 30 * k

  const unitH = 10 * k
  const unitTop = rowBottom - unitH
  const distBaseline = unitTop - 9 * k

  setFont(800, 62 * k, -0.03)
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillStyle = '#fff'
  ctx.fillText(fmtDistanceKm(d.distanceMeters), padL, distBaseline)

  setFont(600, 10 * k, 0.22)
  ctx.textBaseline = 'top'
  ctx.fillStyle = accent
  ctx.fillText('KILOMETRES', padL, unitTop)
  resetLetterSpacing()

  const cells = ledgerCells.value
  if (cells.length) {
    const valueSize = 17 * k
    const labelSize = 9 * k
    const gapVL = 3 * k
    const rowGap = 12 * k
    const colGap = 26 * k
    const cellH = valueSize + gapVL + labelSize
    const rows = Math.ceil(cells.length / 2)
    const gridTop = rowBottom - rows * cellH - (rows - 1) * rowGap

    const colW = [0, 0]
    cells.forEach((c, i) => {
      const col = i % 2
      setFont(700, valueSize)
      const vw = ctx.measureText(c.value).width
      setFont(500, labelSize, 0.18)
      const lw = ctx.measureText(c.label).width
      colW[col] = Math.max(colW[col]!, vw, lw)
    })
    resetLetterSpacing()

    const twoCol = cells.length > 1
    const col1Right = w - padR
    const col0Right = twoCol ? col1Right - colW[1]! - colGap : col1Right

    ctx.textAlign = 'right'
    cells.forEach((c, i) => {
      const col = i % 2
      const row = Math.floor(i / 2)
      const rightX = col === 0 ? col0Right : col1Right
      const cellTop = gridTop + row * (cellH + rowGap)

      setFont(700, valueSize)
      ctx.textBaseline = 'top'
      ctx.fillStyle = '#fff'
      ctx.fillText(c.value, rightX, cellTop)

      setFont(500, labelSize, 0.18)
      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      ctx.fillText(c.label, rightX, cellTop + valueSize + gapVL)
    })
    resetLetterSpacing()
  }

  ctx.restore()
}

watch([photoImage, treated], async () => {
  await buildBackground()
  nextTick(() => renderOverlay())
})

watch(
  [
    overlayGraphic, lineColor, lineWeight, title, place, shownMetrics, activityData,
    textOffsetX, textOffsetY, routeOffsetX, routeOffsetY,
  ],
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
  // Graphic sits in the centre, type hugs the edges — test the graphic first.
  if (pointInBox(p, routeBounds)) {
    dragging.value = 'route'
    dragStartOffset = { x: routeOffsetX.value, y: routeOffsetY.value }
  }
  else if (pointInBox(p, textBounds)) {
    dragging.value = 'text'
    dragStartOffset = { x: textOffsetX.value, y: textOffsetY.value }
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
  <div class="min-h-screen bg-[#f7f6f4] px-4 py-8 sm:px-6 sm:py-10">
    <div v-if="isLoading" class="flex justify-center py-20">
      <BikeSpinner :size="28" />
    </div>

    <UAlert
      v-else-if="loadError"
      class="mx-auto mt-6 max-w-md"
      color="error"
      variant="soft"
      :title="loadError"
    />

    <div
      v-else
      class="mx-auto max-w-[1120px] overflow-hidden rounded-[18px] border border-[#e7e5e4] bg-white shadow-[0_18px_44px_rgba(28,25,23,0.09)]"
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
      <div class="grid grid-cols-1 lg:grid-cols-[1fr_372px]">
        <!-- Preview stage -->
        <div class="flex flex-col items-center gap-4 bg-[#eceae7] p-[34px]">
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
              class="flex aspect-[4/5] items-center justify-center bg-[#161412] text-[13px] text-white/50"
            >
              Upload a photo to preview the overlay.
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-center gap-x-[14px] gap-y-1 text-[12px] text-[#8a827a]">
            <span>Drag the route or the text block to reposition</span>
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
        <div class="flex flex-col border-t border-[#f0efed] lg:border-l lg:border-t-0">
          <div class="grid gap-y-[22px] px-6 pb-2 pt-[22px]">
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

            <!-- Overlay -->
            <div>
              <p class="mb-[9px] text-[10px] font-semibold uppercase tracking-[0.11em] text-[#a8a29e]">
                Overlay
              </p>
              <div class="flex w-full rounded-[9px] bg-[#f5f5f4] p-[3px]">
                <button
                  type="button"
                  class="flex-1 rounded-[6px] py-[6px] text-center text-[12px]"
                  :class="overlayGraphic === 'route'
                    ? 'bg-white font-semibold text-[#1c1917] shadow-[0_1px_2px_rgba(28,25,23,0.08)]'
                    : 'font-medium text-[#78716c]'"
                  @click="overlayGraphic = 'route'"
                >
                  Route
                </button>
                <button
                  type="button"
                  :disabled="!hasElevationProfile"
                  class="flex-1 rounded-[6px] py-[6px] text-center text-[12px] disabled:cursor-not-allowed disabled:text-[#d6d3d1]"
                  :class="overlayGraphic === 'elevation'
                    ? 'bg-white font-semibold text-[#1c1917] shadow-[0_1px_2px_rgba(28,25,23,0.08)]'
                    : (hasElevationProfile ? 'font-medium text-[#78716c]' : '')"
                  @click="overlayGraphic = 'elevation'"
                >
                  Elevation
                </button>
              </div>
              <p v-if="!hasElevationProfile" class="mt-2 text-[11px] text-[#c7c2bd]">
                No elevation data for this ride.
              </p>

              <div class="mt-[14px] flex gap-2">
                <button
                  v-for="c in LINE_PALETTE"
                  :key="c"
                  type="button"
                  class="size-[26px] rounded-full"
                  :style="{
                    background: c,
                    border: c.toLowerCase() === '#ffffff' ? '1px solid #e7e5e4' : 'none',
                    boxShadow: lineColor === c ? `0 0 0 2px #fff, 0 0 0 4px ${c}` : 'none',
                  }"
                  @click="lineColor = c"
                />
              </div>

              <div class="mb-[9px] mt-4 flex items-baseline justify-between">
                <span class="whitespace-nowrap text-[11.5px] font-medium text-[#57534f]">Line weight</span>
                <span class="text-[11px] font-medium text-[#a8a29e] tabular-nums">{{ lineWeight.toFixed(1) }} px</span>
              </div>
              <input
                v-model.number="lineWeight"
                type="range"
                min="1.5"
                max="6"
                step="0.1"
                class="range-line w-full"
                :style="{
                  background: `linear-gradient(to right, #1c1917 0%, #1c1917 ${weightPct}%, #e7e5e4 ${weightPct}%, #e7e5e4 100%)`,
                }"
              >
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

          <div class="flex-1" />
          <div class="border-t border-[#f0efed] bg-white px-6 pb-[22px] pt-4">
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

<style scoped>
.range-line {
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}
.range-line::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  border: 1px solid #d6d3d1;
  box-shadow: 0 1px 3px rgba(28, 25, 23, 0.18);
  cursor: pointer;
}
.range-line::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  border: 1px solid #d6d3d1;
  box-shadow: 0 1px 3px rgba(28, 25, 23, 0.18);
  cursor: pointer;
}
</style>
