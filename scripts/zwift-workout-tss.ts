/**
 * Scans a folder of Zwift .zwo workout files, estimates each workout's
 * duration and TSS, and prints a table sorted by TSS ascending.
 *
 * TSS estimate mirrors the formula used in WorkoutBuilderTab.vue: for each
 * segment, mean(power²) over a linear ramp is (a²+ab+b²)/3 (equal to power²
 * for flat segments), and TSS = Σ (duration_hr * meanSquare * 100). Power
 * values in .zwo files are already fractions of FTP, so no FTP lookup is
 * needed. FreeRide segments have no target power and contribute 0 TSS but
 * still count toward duration.
 *
 * Results are cached in .zwift-tss-cache.json (in the workouts folder) keyed
 * by a content hash of each file, so unchanged workouts are only parsed
 * once — re-run this script often, it's cheap.
 *
 * Usage:
 *   node --experimental-strip-types scripts/zwift-workout-tss.ts [folder]
 *
 * Defaults to ~/Documents/Zwift/Workouts if no folder is given.
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

const ROOT = process.argv[2] ?? join(homedir(), 'Documents/Zwift/Workouts')
const CACHE_PATH = join(ROOT, '.zwift-tss-cache.json')

interface CacheEntry {
  hash: string
  name: string
  durationSec: number
  tss: number
}

type Cache = Record<string, CacheEntry>

async function loadCache(): Promise<Cache> {
  try {
    return JSON.parse(await readFile(CACHE_PATH, 'utf-8'))
  }
  catch {
    return {}
  }
}

async function saveCache(cache: Cache): Promise<void> {
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2))
}

async function findZwoFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await findZwoFiles(full))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zwo')) files.push(full)
  }
  return files
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function extractName(xml: string): string | null {
  const match = xml.match(/<name>([\s\S]*?)<\/name>/)
  return match ? match[1]!.trim() : null
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
}

function attr(tagXml: string, name: string): number | null {
  const match = tagXml.match(new RegExp(`${name}="([^"]*)"`))
  return match ? Number(match[1]) : null
}

interface Segment { duration: number, powerStart: number, powerEnd: number }

function parseSegments(xml: string): Segment[] {
  const segments: Segment[] = []
  const workoutMatch = xml.match(/<workout>([\s\S]*?)<\/workout>/)
  if (!workoutMatch) return segments
  const body = workoutMatch[1]!

  const tagRegex = /<(Warmup|Cooldown|SteadyState|Ramp|IntervalsT|FreeRide)\b([^>]*)\/?>/g
  let match: RegExpExecArray | null
  while ((match = tagRegex.exec(body)) !== null) {
    const [, tagName, rawAttrs] = match
    const tagXml = `<${tagName}${rawAttrs}>`
    const duration = attr(tagXml, 'Duration') ?? 0

    if (tagName === 'Warmup' || tagName === 'Cooldown' || tagName === 'Ramp') {
      const low = attr(tagXml, 'PowerLow') ?? 0
      const high = attr(tagXml, 'PowerHigh') ?? 0
      segments.push({ duration, powerStart: low, powerEnd: high })
    }
    else if (tagName === 'SteadyState') {
      const power = attr(tagXml, 'Power') ?? 0
      segments.push({ duration, powerStart: power, powerEnd: power })
    }
    else if (tagName === 'FreeRide') {
      segments.push({ duration, powerStart: 0, powerEnd: 0 })
    }
    else if (tagName === 'IntervalsT') {
      const reps = attr(tagXml, 'Repeat') ?? 0
      const onDuration = attr(tagXml, 'OnDuration') ?? 0
      const offDuration = attr(tagXml, 'OffDuration') ?? 0
      const onPower = attr(tagXml, 'OnPower') ?? 0
      const offPower = attr(tagXml, 'OffPower') ?? 0
      for (let i = 0; i < reps; i++) {
        segments.push({ duration: onDuration, powerStart: onPower, powerEnd: onPower })
        segments.push({ duration: offDuration, powerStart: offPower, powerEnd: offPower })
      }
    }
  }
  return segments
}

// Builds a 1Hz power trace (as a fraction of FTP) from the segment list,
// linearly interpolating ramps second by second.
function buildPowerTrace(segments: Segment[]): number[] {
  const trace: number[] = []
  for (const seg of segments) {
    const wholeSecs = Math.round(seg.duration)
    for (let i = 0; i < wholeSecs; i++) {
      const frac = wholeSecs <= 1 ? 0 : i / (wholeSecs - 1)
      trace.push(seg.powerStart + (seg.powerEnd - seg.powerStart) * frac)
    }
  }
  return trace
}

// Normalized-power-based TSS, matching Zwift/Coggan's algorithm: a 30s
// rolling average of the power trace, raised to the 4th power, averaged,
// then 4th-rooted. This weights spiky intervals far more than a simple
// mean-square, unlike the live-preview approximation in WorkoutBuilderTab.vue.
function computeTss(segments: Segment[]): number {
  const trace = buildPowerTrace(segments)
  if (trace.length === 0) return 0

  const window = 30
  let windowSum = 0
  let fourthPowerSum = 0
  for (let i = 0; i < trace.length; i++) {
    windowSum += trace[i]!
    if (i >= window) windowSum -= trace[i - window]!
    const n = Math.min(i + 1, window)
    const rollingAvg = windowSum / n
    fourthPowerSum += rollingAvg ** 4
  }

  const np = (fourthPowerSum / trace.length) ** 0.25
  const durationHr = trace.length / 3600
  return Math.round(durationHr * np ** 2 * 100)
}

function parseWorkoutName(xml: string, fallback: string): string {
  const name = extractName(xml)
  return name ? unescapeXml(name) : fallback
}

// ── Terminal colour (raw ANSI, no dependency) ────────────────────────────

const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR

function ansi(code: string, s: string): string {
  return colorEnabled ? `\x1b[${code}m${s}\x1b[0m` : s
}

const headerColor = (s: string) => ansi('1;36', s) // bold cyan
const rowColorA = (s: string) => ansi('37', s) // white
const rowColorB = (s: string) => ansi('90', s) // grey

function fmtDuration(totalSec: number): string {
  const s = Math.round(totalSec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m`
}

async function main() {
  const files = await findZwoFiles(ROOT)
  if (files.length === 0) {
    console.error(`No .zwo files found under ${ROOT}`)
    process.exit(1)
  }

  const cache = await loadCache()
  const nextCache: Cache = {}
  let cacheHits = 0

  const results: { path: string, name: string, durationSec: number, tss: number }[] = []

  for (const path of files) {
    const content = await readFile(path, 'utf-8')
    const hash = hashContent(content)
    const key = relative(ROOT, path)

    const cached = cache[key]
    if (cached && cached.hash === hash) {
      nextCache[key] = cached
      cacheHits += 1
      results.push({ path: key, name: cached.name, durationSec: cached.durationSec, tss: cached.tss })
      continue
    }

    const segments = parseSegments(content)
    const durationSec = segments.reduce((s, x) => s + x.duration, 0)
    const tss = computeTss(segments)
    const name = parseWorkoutName(content, key)

    const entry: CacheEntry = { hash, name, durationSec, tss }
    nextCache[key] = entry
    results.push({ path: key, name, durationSec, tss })
  }

  await saveCache(nextCache)

  results.sort((a, b) => a.tss - b.tss)

  const nameWidth = Math.max(4, ...results.map(r => r.name.length))
  const durWidth = Math.max(8, ...results.map(r => fmtDuration(r.durationSec).length))

  console.log(headerColor(`${'Workout'.padEnd(nameWidth)}  ${'Duration'.padEnd(durWidth)}  TSS`))
  console.log(headerColor(`${'-'.repeat(nameWidth)}  ${'-'.repeat(durWidth)}  ---`))
  results.forEach((r, i) => {
    const color = i % 2 === 0 ? rowColorA : rowColorB
    console.log(color(`${r.name.padEnd(nameWidth)}  ${fmtDuration(r.durationSec).padEnd(durWidth)}  ${r.tss}`))
  })

  console.log(`\n${results.length} workout(s) — ${cacheHits} from cache, ${results.length - cacheHits} (re)computed.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
