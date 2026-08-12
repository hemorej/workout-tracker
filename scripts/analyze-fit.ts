/**
 * Post-ride analysis straight from a .fit file — no Strava, no DB, no app
 * involved. Strava compresses/smooths power data before exposing it via its
 * API, which the user doesn't fully trust; this reads the raw per-second
 * record stream out of the file the head unit/trainer actually wrote.
 *
 * Computes avg/normalized power, IF, TSS (standard Coggan formulas), HR,
 * cadence, elevation gain, a power-curve "bests" table (sliding-window max
 * average, same duration buckets as server/db/schema.ts POWER_BEST_DURATIONS
 * and the same prefix-sum technique as scripts/sync-power-bests.ts), and
 * time-in-zone breakdown (Coggan 7-zone model, relative to FTP).
 *
 * Prints a human-readable report by default. Pass --json to get a
 * machine-readable object instead (e.g. to paste into a chat for discussion).
 *
 * Usage:
 *   node --experimental-strip-types scripts/analyze-fit.ts <file.fit> [--ftp=230] [--json]
 *
 * FTP defaults to 230w (matches the fixed value used for plan generation —
 * see CLAUDE.md/memory) but can be overridden per-run since actual FTP may
 * have moved since a ride was recorded.
 */

import { readFile } from 'node:fs/promises'
import FitParser from 'fit-file-parser'

const DEFAULT_FTP = 230

// duration label -> seconds; matches POWER_BEST_DURATIONS in server/db/schema.ts
const DURATIONS: Record<string, number> = {
  '5sec': 5,
  '15sec': 15,
  '30sec': 30,
  '1min': 60,
  '2min': 120,
  '3min': 180,
  '5min': 300,
  '8min': 480,
  '10min': 600,
  '15min': 900,
  '20min': 1200,
  '30min': 1800,
  '45min': 2700,
  '1h': 3600,
}

// Coggan 7-zone model, as fraction of FTP. Upper bound of each zone.
const ZONES: { name: string; upperFrac: number }[] = [
  { name: 'Z1 Active Recovery', upperFrac: 0.55 },
  { name: 'Z2 Endurance', upperFrac: 0.75 },
  { name: 'Z3 Tempo', upperFrac: 0.90 },
  { name: 'Z4 Threshold', upperFrac: 1.05 },
  { name: 'Z5 VO2max', upperFrac: 1.20 },
  { name: 'Z6 Anaerobic', upperFrac: 1.50 },
  { name: 'Z7 Sprint', upperFrac: Infinity },
]

interface FitRecord {
  timestamp?: Date
  power?: number
  heart_rate?: number
  cadence?: number
  altitude?: number
  distance?: number
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const filePath = args.find(a => !a.startsWith('--'))
const jsonOutput = args.includes('--json')
const ftpArg = args.find(a => a.startsWith('--ftp='))
const ftp = ftpArg ? Number(ftpArg.slice('--ftp='.length)) : DEFAULT_FTP

if (!filePath) {
  console.error('Usage: node --experimental-strip-types scripts/analyze-fit.ts <file.fit> [--ftp=230] [--json]')
  process.exit(1)
}

if (!Number.isFinite(ftp) || ftp <= 0) {
  console.error(`Invalid --ftp value: ${ftpArg}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const content = await readFile(filePath)
const parser = new FitParser({
  mode: 'list',
  lengthUnit: 'm',
  speedUnit: 'km/h',
  elapsedRecordField: true,
})

const data = await parser.parseAsync(content) as { records?: FitRecord[] }
const records: FitRecord[] = data.records ?? []

if (records.length === 0) {
  console.error(`No record data found in ${filePath}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Build per-second power array
// ---------------------------------------------------------------------------

// Records are typically ~1Hz but can have gaps (auto-pause, signal loss).
// Bucket by elapsed second-from-start so sliding-window math below operates
// on a consistent 1Hz timeline rather than assuming every record is 1s apart.
const start = records[0]!.timestamp?.getTime() ?? 0
const end = records[records.length - 1]!.timestamp?.getTime() ?? start
const totalSeconds = Math.max(1, Math.round((end - start) / 1000))

const watts = new Array<number>(totalSeconds + 1).fill(0)
const hrSamples: number[] = []
const cadenceSamples: number[] = []
let elevationGainM = 0
let prevAltitude: number | undefined
let distanceM = 0

for (const r of records) {
  if (r.timestamp && r.power !== undefined) {
    const sec = Math.round((r.timestamp.getTime() - start) / 1000)
    if (sec >= 0 && sec < watts.length) watts[sec] = r.power
  }
  if (r.heart_rate !== undefined) hrSamples.push(r.heart_rate)
  if (r.cadence !== undefined && r.cadence > 0) cadenceSamples.push(r.cadence)
  if (r.altitude !== undefined) {
    if (prevAltitude !== undefined && r.altitude > prevAltitude) {
      elevationGainM += r.altitude - prevAltitude
    }
    prevAltitude = r.altitude
  }
  if (r.distance !== undefined) distanceM = Math.max(distanceM, r.distance)
}

const hasPower = watts.some(w => w > 0)
if (!hasPower) {
  console.error(`No power data found in ${filePath} — is this a power-meter/trainer ride?`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Core power metrics
// ---------------------------------------------------------------------------

function mean(arr: number[] | Float64Array): number {
  if (arr.length === 0) return 0
  let sum = 0
  for (const v of arr) sum += v
  return sum / arr.length
}

const avgPower = mean(watts)
const maxPower = Math.max(...watts)

// Normalized Power: 30s rolling average, raised to the 4th power, averaged, 4th root.
function normalizedPower(w: number[]): number {
  const window = 30
  if (w.length < window) return mean(w)
  const rolling: number[] = []
  const prefix = new Float64Array(w.length + 1)
  for (let i = 0; i < w.length; i++) prefix[i + 1] = prefix[i] + w[i]
  for (let i = 0; i + window <= w.length; i++) {
    rolling.push((prefix[i + window]! - prefix[i]!) / window)
  }
  const fourthPowerAvg = mean(rolling.map(v => v ** 4))
  return fourthPowerAvg ** 0.25
}

const np = normalizedPower(watts)
const intensityFactor = np / ftp
// TSS = (duration_sec * NP * IF) / (FTP * 3600) * 100
const tss = (totalSeconds * np * intensityFactor) / (ftp * 3600) * 100
const variabilityIndex = np / avgPower

// ---------------------------------------------------------------------------
// Power-curve bests (sliding-window max average via prefix sums)
// ---------------------------------------------------------------------------

function computeBests(w: number[]): Record<string, number> {
  const prefix = new Float64Array(w.length + 1)
  for (let i = 0; i < w.length; i++) prefix[i + 1] = prefix[i] + w[i]

  const bests: Record<string, number> = {}
  for (const [label, seconds] of Object.entries(DURATIONS)) {
    if (seconds > w.length) continue
    let best = 0
    for (let s = 0; s + seconds <= w.length; s++) {
      const avg = (prefix[s + seconds]! - prefix[s]!) / seconds
      if (avg > best) best = avg
    }
    if (best > 0) bests[label] = Math.round(best)
  }
  return bests
}

const bests = computeBests(watts)

// ---------------------------------------------------------------------------
// Time in zone
// ---------------------------------------------------------------------------

function timeInZone(w: number[]): { name: string; seconds: number; pct: number }[] {
  const counts = new Array(ZONES.length).fill(0)
  for (const p of w) {
    const frac = p / ftp
    const idx = ZONES.findIndex(z => frac <= z.upperFrac)
    counts[idx === -1 ? ZONES.length - 1 : idx]++
  }
  const total = w.length
  return ZONES.map((z, i) => ({ name: z.name, seconds: counts[i], pct: total ? (counts[i] / total) * 100 : 0 }))
}

const zoneBreakdown = timeInZone(watts)

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const avgHr = hrSamples.length ? Math.round(mean(hrSamples)) : null
const maxHr = hrSamples.length ? Math.max(...hrSamples) : null
const avgCadence = cadenceSamples.length ? Math.round(mean(cadenceSamples)) : null

const result = {
  file: filePath,
  ftp,
  durationSeconds: totalSeconds,
  distanceKm: round1(distanceM / 1000),
  elevationGainM: Math.round(elevationGainM),
  avgPower: Math.round(avgPower),
  maxPower: Math.round(maxPower),
  normalizedPower: Math.round(np),
  intensityFactor: round2(intensityFactor),
  variabilityIndex: round2(variabilityIndex),
  tss: round1(tss),
  avgHr,
  maxHr,
  avgCadence,
  bests,
  zoneBreakdown: zoneBreakdown.map(z => ({ ...z, pct: round1(z.pct) })),
}

if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2))
} else {
  printReport(result)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function fmtDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s` : `${m}m ${String(s).padStart(2, '0')}s`
}

function printReport(r: typeof result) {
  console.log(`\n${r.file}`)
  console.log('─'.repeat(50))
  console.log(`Duration        ${fmtDuration(r.durationSeconds)}`)
  console.log(`Distance        ${r.distanceKm} km`)
  console.log(`Elevation gain  ${r.elevationGainM} m`)
  console.log()
  console.log(`FTP (assumed)   ${r.ftp} W`)
  console.log(`Avg power       ${r.avgPower} W`)
  console.log(`Max power       ${r.maxPower} W`)
  console.log(`Normalized pwr  ${r.normalizedPower} W`)
  console.log(`Intensity (IF)  ${r.intensityFactor}`)
  console.log(`Variability(VI) ${r.variabilityIndex}`)
  console.log(`TSS             ${r.tss}`)
  if (r.avgHr !== null) console.log(`\nAvg HR          ${r.avgHr} bpm`)
  if (r.maxHr !== null) console.log(`Max HR          ${r.maxHr} bpm`)
  if (r.avgCadence !== null) console.log(`Avg cadence     ${r.avgCadence} rpm`)

  console.log('\nPower curve (best avg power for each duration):')
  const labelWidth = Math.max(...Object.keys(r.bests).map(l => l.length))
  for (const [label, seconds] of Object.entries(DURATIONS)) {
    if (r.bests[label] === undefined) continue
    console.log(`  ${label.padEnd(labelWidth)}  ${String(r.bests[label]).padStart(4)} W`)
  }

  console.log('\nTime in zone (Coggan, relative to FTP):')
  const nameWidth = Math.max(...r.zoneBreakdown.map(z => z.name.length))
  for (const z of r.zoneBreakdown) {
    if (z.seconds === 0) continue
    console.log(`  ${z.name.padEnd(nameWidth)}  ${fmtDuration(z.seconds).padEnd(14)} ${z.pct}%`)
  }
  console.log()
}
