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
/** A lighter shade of the same orange — Tailwind's orange-300 — used for the optional text tint. */
const THEME_ORANGE_LIGHT = '#fdba74'
const OVERLAY_FONT_FAMILY = '"Hanken Grotesk", system-ui, sans-serif'

const route = useRoute()
const activityId = route.params.activityId as string

const isLoading = ref(true)
const loadError = ref<string | null>(null)
const activityData = ref<ActivityOverlayData | null>(null)

const photoImage = ref<HTMLImageElement | null>(null)
const bwFilterEnabled = ref(false)
const duotoneEnabled = ref(false)
const blurEnabled = ref(false)
const showAvgPower = ref(false)
const showElevation = ref(false)
const showAvgSpeed = ref(false)
const showDate = ref(false)
const tintTextOrange = ref(false)
const canvasRef = ref<HTMLCanvasElement | null>(null)

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
    URL.revokeObjectURL(url)
  }
  img.src = url
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

// ── Duotone filter ────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * Maps each pixel's luminance onto a gradient between two colors — a
 * punchy, posterized look (bold shadow color, pale near-white highlight),
 * matching the two-tone print/halftone poster style rather than a smooth
 * gray-to-color gradient. Contrast is boosted before mapping so midtones
 * push toward one end or the other instead of sitting muddy in between.
 * App-themed default: a deep rust shadow (darkened orange-600) to a warm
 * off-white highlight.
 */
function applyDuotoneFilter(imageData: ImageData, shadowHex = '#7c2d12', highlightHex = '#fdf6ec', contrastAmount = 35) {
  const [sr, sg, sb] = hexToRgb(shadowHex)
  const [hr, hg, hb] = hexToRgb(highlightHex)
  const contrastFactor = (259 * (contrastAmount + 255)) / (255 * (259 - contrastAmount))
  const d = imageData.data
  for (let i = 0; i < d.length; i += 4) {
    let gray = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!
    gray = contrastFactor * (gray - 128) + 128
    const lum = Math.min(255, Math.max(0, gray)) / 255
    d[i] = sr + (hr - sr) * lum
    d[i + 1] = sg + (hg - sg) * lum
    d[i + 2] = sb + (hb - sb) * lum
  }
  return imageData
}

// ── Render pipeline ──────────────────────────────────────────────────────

async function renderCanvas() {
  const canvas = canvasRef.value
  const img = photoImage.value
  if (!canvas || !img) return

  // Canvas text uses whatever font is already loaded at draw time — without
  // this, the first render can fall back to the system font before the
  // self-hosted variable woff2 finishes loading.
  await document.fonts.load(`700 16px ${OVERLAY_FONT_FAMILY}`)

  const scale = Math.min(1, MAX_CANVAS_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.round(img.naturalWidth * scale)
  const h = Math.round(img.naturalHeight * scale)
  canvas.width = w
  canvas.height = h

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.clearRect(0, 0, w, h)
  // Blur applies only to this draw call — reset immediately after so the
  // route line, text, and any filters drawn below stay sharp.
  ctx.filter = blurEnabled.value ? `blur(${Math.max(2, Math.round(w * 0.006))}px)` : 'none'
  ctx.drawImage(img, 0, 0, w, h)
  ctx.filter = 'none'

  if (bwFilterEnabled.value) {
    const imageData = ctx.getImageData(0, 0, w, h)
    applyBwNoiseFilter(imageData)
    ctx.putImageData(imageData, 0, 0)
  }

  if (duotoneEnabled.value) {
    const imageData = ctx.getImageData(0, 0, w, h)
    applyDuotoneFilter(imageData)
    ctx.putImageData(imageData, 0, 0)
  }

  const points = activityData.value?.points ?? []
  if (points.length > 1) {
    // Larger padding = smaller route relative to the canvas; projectPoints
    // centers the route within the padded box, which is itself centered
    // in the full canvas since padding is uniform on every side.
    const padding = Math.round(Math.min(w, h) * 0.2)
    const projected = projectPoints(points, w, h, padding)

    ctx.save()
    ctx.beginPath()
    projected.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = THEME_ORANGE
    ctx.lineWidth = Math.max(3, w * 0.007)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.shadowColor = 'rgba(0,0,0,0.5)'
    ctx.shadowBlur = 4
    ctx.stroke()
    ctx.restore()
  }

  if (activityData.value) {
    const pad = Math.round(w * 0.06)
    const lineHeight = Math.round(w * 0.039)
    const lines = statLines.value
    const baseY = h - pad - (lines.length - 1) * lineHeight
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

    // Text is white by default (works over most photos); the tint toggle
    // switches every bit of text — title, date, values, units — to a
    // lighter shade of the app's orange, for photos with light/white
    // backgrounds where white text would disappear.
    const textColor = tintTextOrange.value ? THEME_ORANGE_LIGHT : 'white'
    const separatorColor = tintTextOrange.value ? 'rgba(253,186,116,0.6)' : 'rgba(255,255,255,0.6)'

    function drawText(text: string, x: number, y: number) {
      ctx!.fillStyle = textColor
      ctx!.fillText(text, x, y)
    }

    ctx.save()
    ctx.textBaseline = 'alphabetic'
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
}

watchEffect(() => {
  // Reactive dependencies: photoImage, bwFilterEnabled, duotoneEnabled,
  // blurEnabled, showAvgPower, showElevation, showAvgSpeed, showDate, tintTextOrange, activityData
  void photoImage.value
  void bwFilterEnabled.value
  void duotoneEnabled.value
  void blurEnabled.value
  void showAvgPower.value
  void showElevation.value
  void showAvgSpeed.value
  void showDate.value
  void tintTextOrange.value
  void activityData.value
  nextTick(() => renderCanvas())
})

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
                <input v-model="duotoneEnabled" type="checkbox" class="rounded border-stone-300 text-orange-600 focus:ring-orange-500">
                Duotone
              </label>

              <label class="flex items-center gap-2 text-sm text-stone-600 select-none">
                <input v-model="blurEnabled" type="checkbox" class="rounded border-stone-300 text-orange-600 focus:ring-orange-500">
                Subtle blur
              </label>

              <label class="flex items-center gap-2 text-sm text-stone-600 select-none">
                <input v-model="tintTextOrange" type="checkbox" class="rounded border-stone-300 text-orange-600 focus:ring-orange-500">
                Tint text orange
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

        <div class="rounded-xl overflow-hidden bg-stone-200 flex items-center justify-center">
          <canvas
            v-show="photoImage"
            ref="canvasRef"
            class="max-w-full h-auto block"
          />
          <p v-if="!photoImage" class="text-sm text-stone-400 py-16">
            Upload a photo to preview the overlay.
          </p>
        </div>

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
