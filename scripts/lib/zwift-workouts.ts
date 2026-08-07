/**
 * Shared .zwo scanning/parsing/TSS-estimation logic, used by both
 * scripts/zwift-workout-tss.ts (standalone CLI table) and the local-library
 * provider in scripts/workout-search.ts.
 *
 * TSS estimate matches Zwift/Coggan's normalized-power algorithm: a 30s
 * rolling average of the 1Hz power trace, raised to the 4th power, averaged,
 * then 4th-rooted. Power values in .zwo files are already fractions of FTP,
 * so no FTP lookup is needed. FreeRide segments have no target power and
 * contribute 0 TSS but still count toward duration.
 *
 * Results are cached in .zwift-tss-cache.json (in the scanned folder) keyed
 * by a content hash of each file, so unchanged workouts are only parsed once.
 *
 * Zone tagging: since .zwo files carry no power-zone classification of their
 * own, workouts tagged by hand (see the one-time tagging pass referenced in
 * git history) carry a `<tag name="zone:SweetSpot"/>` entry inside the
 * standard <tags> element — real Zwift-recognized XML, just with a value
 * Zwift itself doesn't assign meaning to. `parseZoneTag` reads it back out
 * for scripts/workout-search.ts's LocalZwift provider to filter on.
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { ZONES, type ZoneName } from './zones.ts'

interface CacheEntry {
  hash: string
  name: string
  durationSec: number
  tss: number
}

type Cache = Record<string, CacheEntry>

async function loadCache(cachePath: string): Promise<Cache> {
  try {
    return JSON.parse(await readFile(cachePath, 'utf-8'))
  }
  catch {
    return {}
  }
}

async function saveCache(cachePath: string, cache: Cache): Promise<void> {
  await writeFile(cachePath, JSON.stringify(cache, null, 2))
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

export function parseZoneTag(xml: string): ZoneName | null {
  const match = xml.match(/<tag name="zone:([^"]*)"\/>/)
  const value = match?.[1]
  return value && (ZONES as readonly string[]).includes(value) ? value as ZoneName : null
}

export interface ZwiftWorkoutResult {
  path: string
  name: string
  durationSec: number
  tss: number
  zone: ZoneName | null
}

export interface ScanZwiftWorkoutsResult {
  results: ZwiftWorkoutResult[]
  cacheHits: number
}

export async function scanZwiftWorkouts(root: string): Promise<ScanZwiftWorkoutsResult> {
  const cachePath = join(root, '.zwift-tss-cache.json')
  const files = await findZwoFiles(root)

  const cache = await loadCache(cachePath)
  const nextCache: Cache = {}
  let cacheHits = 0

  const results: ZwiftWorkoutResult[] = []

  for (const path of files) {
    const content = await readFile(path, 'utf-8')
    const hash = hashContent(content)
    const key = relative(root, path)

    // Zone tag is cheap to re-read every time, so it's kept out of the TSS
    // cache entry rather than duplicated there.
    const zone = parseZoneTag(content)

    const cached = cache[key]
    if (cached && cached.hash === hash) {
      nextCache[key] = cached
      cacheHits += 1
      results.push({ path: key, name: cached.name, durationSec: cached.durationSec, tss: cached.tss, zone })
      continue
    }

    const segments = parseSegments(content)
    const durationSec = segments.reduce((s, x) => s + x.duration, 0)
    const tss = computeTss(segments)
    const name = parseWorkoutName(content, key)

    const entry: CacheEntry = { hash, name, durationSec, tss }
    nextCache[key] = entry
    results.push({ path: key, name, durationSec, tss, zone })
  }

  await saveCache(cachePath, nextCache)

  return { results, cacheHits }
}
