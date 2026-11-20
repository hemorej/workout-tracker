/**
 * Types shared by the Training tab (client) and the /api/training/* endpoints
 * (server). One calendar day merges the planned session and the logged ride.
 */

export interface PowerBestEntry {
  duration: string
  watts: number
}

/** Extra stats from a parsed FIT file — mirrors WorkoutFitData in server/db/schema.ts */
export interface WorkoutFitData {
  avgPower: number
  maxPower: number
  normalizedPower: number
  intensityFactor: number
  avgHr: number | null
  maxHr: number | null
  avgCadence: number | null
  maxCadence: number | null
  /** Seconds per power zone (index 0 = Z1 … 5 = Z6); null on FIT files parsed before this existed. */
  zoneBuckets: number[] | null
  /** FTP (watts) the zoneBuckets split was computed against; null on older blobs. */
  zoneFtp: number | null
}

/** One lap/split from a parsed FIT file — mirrors WorkoutLap in server/db/schema.ts */
export interface WorkoutLap {
  lapNumber: number
  durationSeconds: number
  distanceMeters: number
  avgPower: number | null
  maxPower: number | null
  avgHr: number | null
  maxHr: number | null
  avgCadence: number | null
  avgSpeedKph: number | null
}

export interface WorkoutDetail {
  id: number
  name: string
  durationMinutes: number
  distanceKm: number | null
  tss: number
  rpe: number | null
  notes: string | null
  ftpWatts: number | null
  rideType: 'trainer' | 'outdoor' | null
  /** Whether a parsed FIT file's stats exist — day payloads omit the blob itself. */
  hasFitData: boolean
  /** Loaded on demand via GET /api/workouts/:id (day payloads omit it). */
  fitData?: WorkoutFitData | null
  /** Per-lap splits, if the FIT file had 2+ laps. Loaded on demand with fitData. */
  laps?: WorkoutLap[] | null
  /** Strava activity this workout was created from, if any. */
  stravaActivityId: string | null
  powerBests: PowerBestEntry[]
}

/** A planned session (one per day). `type`: zone2 | zone4 | zone5 | zone6 | rest | outdoor | null */
export interface PlanEntry {
  id?: number
  name: string | null
  type: string | null
  tss: number | null
  durationMinutes: number | null
  notes: string | null
}

/** CTL / ATL / TSB at the end of a day — actual for past days, projected for future ones. */
export interface FormMetrics {
  ctl: number
  atl: number
  tsb: number
}

export interface TrainingDay {
  /** YYYY-MM-DD */
  date: string
  plan: PlanEntry | null
  ride: WorkoutDetail | null
  metrics: FormMetrics
  isToday: boolean
  /** date < today */
  isPast: boolean
}

export type DayState = 'ridden' | 'planned' | 'missed' | 'rest'

/** Always-global headline numbers for the metrics strip. */
export interface TrainingSummary {
  today: FormMetrics
  /** 7 days ago, for the CTL trend arrow */
  weekAgo: FormMetrics | null
  /** Trailing-year CTL extremes, for the fitness band label */
  ctlRange: { min: number, max: number } | null
}

export interface TrainingDaysResponse {
  /** Ascending, contiguous, whole Monday–Sunday weeks */
  days: TrainingDay[]
  summary: TrainingSummary
  /** True when there are logged workouts before the first returned day */
  hasOlder: boolean
}

export interface TrainingSearchResponse {
  /** Every day of each week that holds a match, ascending */
  days: TrainingDay[]
  /** Matching dates, ascending */
  matches: string[]
  /** True when older matches were dropped to respect the result cap */
  truncated: boolean
}

export interface NewWorkoutPayload {
  date: string
  name: string
  durationMinutes: number
  distanceKm?: number | null
  tss: number
  rpe?: number | null
  notes?: string | null
  ftpWatts?: number | null
  rideType?: 'trainer' | 'outdoor' | null
  powerBests?: PowerBestEntry[]
  /** Full parsed power curve (all durations) — stored server-side for History; only sent when a FIT file was parsed. */
  powerCurve?: PowerBestEntry[]
  fitData?: WorkoutFitData | null
  laps?: WorkoutLap[] | null
  stravaActivityId?: string | null
}
