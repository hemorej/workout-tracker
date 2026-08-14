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
  /** Cumulative distance in meters (lengthUnit: 'm' below) */
  distance?: number
  heart_rate?: number
  cadence?: number
}

interface FitEvent {
  event?: string
  event_type?: string
  timestamp?: Date
}

/**
 * Pause windows derived from raw 'timer' events. fit-file-parser's own
 * `timer_time` field (elapsedRecordField option) only subtracts pauses whose
 * event_type is 'stop_all' (auto-pause) — it ignores 'stop', which is what
 * Wahoo's ELEMNT firmware tags *every* pause with, auto or manual, so
 * timer_time never actually got reduced. We compute pause windows ourselves
 * from all stop/stop_all → start pairs. Note the device already omits
 * records entirely during a pause (confirmed against a real ELEMNT ROAM
 * file — record count exactly matches the file's own total_timer_time in
 * seconds), so these windows aren't for filtering records; they're for
 * reconstructing moving-time-elapsed per record (see pausedSecondsBefore),
 * since consecutive kept records straddle the paused gap and a naive
 * timestamp-delta sum would silently re-add it.
 */
function computePausedIntervals(events: FitEvent[]): { start: number, end: number }[] {
  const pauses: { start: number, end: number }[] = []
  let openStart: number | null = null
  for (const e of events) {
    if (e.event !== 'timer' || !e.timestamp) continue
    if ((e.event_type === 'stop' || e.event_type === 'stop_all') && openStart === null) {
      openStart = e.timestamp.getTime()
    }
    else if (e.event_type === 'start' && openStart !== null) {
      pauses.push({ start: openStart, end: e.timestamp.getTime() })
      openStart = null
    }
  }
  return pauses
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
  /** Total distance recorded, if the device provided it (0 for trainer rides with no distance data). */
  distanceMeters: number
  /** Null if the file has no heart-rate readings (not every ride uses a HR strap). */
  avgHr: number | null
  maxHr: number | null
  /** Null if the file has no cadence readings (not every sensor reports it). */
  avgCadence: number | null
  maxCadence: number | null
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
  })

  const data = await parser.parseAsync(content as unknown as ArrayBuffer) as { records?: FitRecord[], events?: FitEvent[] }
  const records: FitRecord[] = data.records ?? []

  if (records.length === 0) {
    throw new Error('No record data found in FIT file.')
  }

  const pauses = computePausedIntervals(data.events ?? [])
  /** Total paused seconds fully elapsed before `ts` — pauses straddling `ts` don't occur since the device emits no records mid-pause. */
  function pausedSecondsBefore(ts: number): number {
    let sum = 0
    for (const p of pauses) if (p.end <= ts) sum += (p.end - p.start) / 1000
    return sum
  }

  const startTs = records[0]!.timestamp?.getTime() ?? 0
  let totalSeconds = 0
  const watts: number[] = []
  for (const r of records) {
    if (!r.timestamp) continue
    const ts = r.timestamp.getTime()
    const movingTime = Math.round((ts - startTs) / 1000 - pausedSecondsBefore(ts))
    if (movingTime < 0) continue
    if (movingTime > totalSeconds) totalSeconds = movingTime
    while (watts.length <= movingTime) watts.push(0)
    if (r.power !== undefined) watts[movingTime] = r.power
  }
  totalSeconds = Math.max(1, totalSeconds)

  if (!watts.some((w) => w > 0)) {
    throw new Error('No power data found in FIT file — not a power-meter/trainer ride?')
  }

  // distance is cumulative — the last record with a value holds the ride total.
  let distanceMeters = 0
  for (const r of records) {
    if (r.distance !== undefined) distanceMeters = r.distance
  }

  const heartRates = records.map((r) => r.heart_rate).filter((v): v is number => v !== undefined)
  const cadences = records.map((r) => r.cadence).filter((v): v is number => v !== undefined)

  // Average power display convention (matches Wahoo/Garmin head units):
  // exclude zero-power (freewheeling/coasting) seconds. NP and TSS keep the
  // full watts array including zeros — that's the whole point of the 4th-power
  // rolling average, and it already tracks the device's own NP closely.
  const nonZeroWatts = watts.filter((w) => w > 0)
  const avgPower = mean(nonZeroWatts.length > 0 ? nonZeroWatts : watts)
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
    distanceMeters: Math.round(distanceMeters),
    avgHr: heartRates.length > 0 ? Math.round(mean(heartRates)) : null,
    maxHr: heartRates.length > 0 ? Math.round(Math.max(...heartRates)) : null,
    avgCadence: cadences.length > 0 ? Math.round(mean(cadences)) : null,
    maxCadence: cadences.length > 0 ? Math.round(Math.max(...cadences)) : null,
  }
}
