/**
 * FIT file parsing — normalized power, TSS, and power-curve bests straight
 * from the raw per-second record stream a head unit/trainer wrote, rather
 * than a third party's smoothed/compressed numbers.
 *
 * Used by server/utils/wahoo.ts against files downloaded from Wahoo's Cloud
 * API. Formerly a standalone CLI (scripts/analyze-fit.ts) — folded in here
 * once the app started doing this parsing itself on every logged ride.
 */

import FitParser from 'fit-file-parser'
import { POWER_BEST_DURATIONS, type PowerBestDuration } from '../db/schema'

// duration label -> seconds, matches POWER_BEST_DURATIONS in server/db/schema.ts
const DURATION_SECONDS: Record<PowerBestDuration, number> = {
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

interface FitRecord {
  timestamp?: Date
  power?: number
}

export interface ParsedFitMetrics {
  durationSeconds: number
  avgPower: number
  maxPower: number
  normalizedPower: number
  intensityFactor: number
  tss: number
  /** Best rolling-average power per duration bucket the ride was long enough to fill. */
  bests: Partial<Record<PowerBestDuration, number>>
}

function mean(arr: number[] | Float64Array): number {
  if (arr.length === 0) return 0
  let sum = 0
  for (const v of arr) sum += v
  return sum / arr.length
}

/** Normalized Power: 30s rolling average, raised to the 4th power, averaged, 4th root. */
function normalizedPower(w: number[]): number {
  const window = 30
  if (w.length < window) return mean(w)
  const rolling: number[] = []
  const prefix = new Float64Array(w.length + 1)
  for (let i = 0; i < w.length; i++) prefix[i + 1] = prefix[i]! + w[i]!
  for (let i = 0; i + window <= w.length; i++) {
    rolling.push((prefix[i + window]! - prefix[i]!) / window)
  }
  const fourthPowerAvg = mean(rolling.map((v) => v ** 4))
  return fourthPowerAvg ** 0.25
}

/** Sliding-window max average per duration bucket, via prefix sums. */
function computeBests(w: number[]): Partial<Record<PowerBestDuration, number>> {
  const prefix = new Float64Array(w.length + 1)
  for (let i = 0; i < w.length; i++) prefix[i + 1] = prefix[i]! + w[i]!

  const bests: Partial<Record<PowerBestDuration, number>> = {}
  for (const label of POWER_BEST_DURATIONS) {
    const seconds = DURATION_SECONDS[label]
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

/**
 * Parses a raw FIT file buffer and computes power metrics against the given
 * FTP. Throws if the file has no record data or no power data at all (e.g. a
 * run, or a ride with no power meter/trainer).
 */
export async function parseFitFile(content: Buffer, ftp: number): Promise<ParsedFitMetrics> {
  const parser = new FitParser({
    mode: 'list',
    lengthUnit: 'm',
    speedUnit: 'km/h',
    elapsedRecordField: true,
  })

  const data = await parser.parseAsync(content as unknown as ArrayBuffer) as { records?: FitRecord[] }
  const records: FitRecord[] = data.records ?? []

  if (records.length === 0) {
    throw new Error('No record data found in FIT file.')
  }

  // Records are typically ~1Hz but can have gaps (auto-pause, signal loss).
  // Bucket by elapsed second-from-start so sliding-window math operates on a
  // consistent 1Hz timeline rather than assuming every record is 1s apart.
  const start = records[0]!.timestamp?.getTime() ?? 0
  const end = records[records.length - 1]!.timestamp?.getTime() ?? start
  const totalSeconds = Math.max(1, Math.round((end - start) / 1000))

  const watts = new Array<number>(totalSeconds + 1).fill(0)
  for (const r of records) {
    if (r.timestamp && r.power !== undefined) {
      const sec = Math.round((r.timestamp.getTime() - start) / 1000)
      if (sec >= 0 && sec < watts.length) watts[sec] = r.power
    }
  }

  if (!watts.some((w) => w > 0)) {
    throw new Error('No power data found in FIT file — not a power-meter/trainer ride?')
  }

  const avgPower = mean(watts)
  const maxPower = Math.max(...watts)
  const np = normalizedPower(watts)
  const intensityFactor = np / ftp
  // TSS = (duration_sec * NP * IF) / (FTP * 3600) * 100
  const tss = (totalSeconds * np * intensityFactor) / (ftp * 3600) * 100

  return {
    durationSeconds: totalSeconds,
    avgPower: Math.round(avgPower),
    maxPower: Math.round(maxPower),
    normalizedPower: Math.round(np),
    intensityFactor: Math.round(intensityFactor * 100) / 100,
    tss: Math.round(tss),
    bests: computeBests(watts),
  }
}
