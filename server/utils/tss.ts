/**
 * Training load metrics calculator.
 *
 * Implements the standard TrainingPeaks model for estimating fitness,
 * fatigue, and form from a history of Training Stress Scores (TSS).
 *
 * ─── Terminology ────────────────────────────────────────────────────────────
 *
 *  TSS   Training Stress Score — a single number representing the load
 *         of one workout. A 1-hour ride at threshold ≈ 100 TSS.
 *
 *  CTL   Chronic Training Load (also called "Fitness").
 *         An exponentially-weighted moving average of daily TSS over ~42 days.
 *         A high CTL means you have been training consistently for weeks.
 *
 *  ATL   Acute Training Load (also called "Fatigue").
 *         Same idea but over ~7 days — it responds much faster to recent load.
 *         A spike in ATL means you've been working hard lately.
 *
 *  TSB   Training Stress Balance (also called "Form").
 *         TSB = CTL(today) − ATL(today)
 *         Positive TSB → rested / fresh.
 *         Negative TSB → fatigued.
 *         Ideal race form is typically TSB in the range −10 to +25.
 *
 * ─── Formulas ───────────────────────────────────────────────────────────────
 *
 *  CTL(today) = CTL(yesterday) + ( TSS(today) − CTL(yesterday) ) / 42
 *  ATL(today) = ATL(yesterday) + ( TSS(today) − ATL(yesterday) ) / 7
 *  TSB(today) = CTL(today) − ATL(today)
 *
 *  These are first-order IIR (infinite impulse response) low-pass filters.
 *  The "/ 42" and "/ 7" terms set the time constants.
 *  CTL and ATL both start at 0 (assuming no prior training history).
 *
 * ─── Note on TSB timing ─────────────────────────────────────────────────────
 *
 *  TSB is calculated AFTER folding in today's training stress, so it
 *  reflects form at the END of the day, once today's session is absorbed.
 *  This matches how Strava's Fitness/Freshness and Stride report same-day
 *  numbers, rather than the "start of day, before today's TSS" convention
 *  some PMC implementations use.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A raw workout row from the database (only the fields we need here) */
export interface WorkoutRecord {
  date: string // ISO 8601 date string, e.g. "2026-05-25"
  tss: number
  durationMinutes: number
  distanceKm?: number | null
}

/** Computed metrics for a single calendar day */
export interface DayMetrics {
  date: string
  /** TSS for this day (0 for rest days) */
  tss: number
  /** Total training minutes (0 for rest days) */
  durationMinutes: number
  /** Distance covered in kilometres (0 for rest days) */
  distanceKm: number
  /** Chronic Training Load — fitness accumulated over ~42 days */
  ctl: number
  /** Acute Training Load — fatigue accumulated over ~7 days */
  atl: number
  /**
   * Training Stress Balance — form.
   * Calculated from *today's* post-workout CTL and ATL, so it represents
   * how fresh you are at the end of the day, once today's TSS is absorbed.
   */
  tsb: number
  /** True when no workout was logged for this day */
  isRestDay: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CTL time constant in days ("fitness window") */
const CTL_DAYS = 42

/** ATL time constant in days ("fatigue window") */
const ATL_DAYS = 7

// ---------------------------------------------------------------------------
// Core calculation
// ---------------------------------------------------------------------------

/** Options for computeMetricsSeries */
export interface MetricsSeriesOptions {
  /**
   * The last date to include in the series (defaults to today).
   */
  endDate?: Date
  /**
   * CTL value on the day BEFORE the first workout.
   *
   * If you have been training before your earliest logged workout, set this
   * to your known CTL at that point so the series starts from a realistic
   * baseline rather than zero.
   *
   * Example: if your CTL was 44 the day before you started logging,
   * pass `initialCTL: 44`.
   *
   * Defaults to 0 (no prior training history).
   */
  initialCTL?: number
  /**
   * ATL value on the day BEFORE the first workout.
   *
   * If omitted, defaults to `initialCTL` — this assumes you were in a
   * steady training state (TSB ≈ 0) before your first logged session.
   * You can override with a specific value if you know your fatigue level.
   */
  initialATL?: number
}

/**
 * Given a list of workouts, fills in every calendar day from the earliest
 * workout date to `endDate` (inclusive), computes CTL, ATL and TSB for each
 * day, and returns the full day-by-day series sorted by date ascending.
 *
 * Rest days are inserted automatically for any date that has no workout.
 *
 * @param workouts - All workout rows for a single user, in any order
 * @param options  - Optional configuration (endDate, initialCTL, initialATL)
 * @returns Array of DayMetrics, one entry per calendar day
 */
export function computeMetricsSeries(
  workouts: WorkoutRecord[],
  options: MetricsSeriesOptions | Date = {},
): DayMetrics[] {
  // Back-compat: allow passing a plain Date as the second argument
  const opts: MetricsSeriesOptions = options instanceof Date
    ? { endDate: options }
    : options

  const endDate = opts.endDate ?? new Date()
  const initialCTL = opts.initialCTL ?? 0
  // Default ATL to initialCTL — assumes steady-state training (TSB ≈ 0)
  const initialATL = opts.initialATL ?? initialCTL

  if (workouts.length === 0) return []

  // Build a fast lookup: date string → workout data
  const workoutByDate = new Map<string, WorkoutRecord>()
  for (const w of workouts) {
    workoutByDate.set(w.date, w)
  }

  // Find the earliest workout date as the series start
  const sortedDates = [...workoutByDate.keys()].sort()
  const startDate = new Date(sortedDates[0]!)

  // Normalise endDate to midnight UTC to avoid DST issues
  const end = new Date(
    Date.UTC(endDate.getFullYear(), endDate.getMonth(), endDate.getDate()),
  )

  const results: DayMetrics[] = []

  // Seed from the user's known starting values rather than always from zero
  let ctl = initialCTL
  let atl = initialATL

  // Iterate day by day from the first workout to today
  const cursor = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()),
  )

  while (cursor <= end) {
    const dateStr = cursor.toISOString().slice(0, 10) // "YYYY-MM-DD"
    const workout = workoutByDate.get(dateStr)
    const tss = workout?.tss ?? 0
    const durationMinutes = workout?.durationMinutes ?? 0
    const distanceKm = workout?.distanceKm ?? 0
    const isRestDay = !workout

    const ctlDecay = 1 / CTL_DAYS
    const atlDecay = 1 / ATL_DAYS

    // Update CTL and ATL with today's TSS
    // ctl = ctl + (tss - ctl) / CTL_DAYS
    // atl = atl + (tss - atl) / ATL_DAYS
    ctl = tss*ctlDecay + ctl * (1 - ctlDecay)
    atl = tss*atlDecay + atl * (1 - atlDecay)

    /**
     * TSB is computed from today's post-workout CTL/ATL, matching how
     * Strava's Fitness/Freshness and Stride report same-day form (i.e.
     * form after today's training is absorbed, not before).
     */
    const tsb = ctl - atl

    results.push({
      date: dateStr,
      tss,
      durationMinutes,
      distanceKm,
      ctl: round(ctl),
      atl: round(atl),
      tsb: round(tsb),
      isRestDay,
    })

    // Advance by one day
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return results
}

/**
 * Computes weekly summary stats for a given ISO week containing `referenceDate`.
 * The week runs Monday–Sunday.
 *
 * @param series        - Full metrics series from computeMetricsSeries()
 * @param referenceDate - Any date in the target week (defaults to today)
 */
export function computeWeeklyStats(
  series: DayMetrics[],
  referenceDate: Date = new Date(),
): { tssTotal: number; hoursTotal: number; kmTotal: number } {
  // Find Monday of the reference week
  const ref = new Date(
    Date.UTC(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate()),
  )
  const dayOfWeek = ref.getUTCDay() // 0 = Sunday
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const monday = new Date(ref)
  monday.setUTCDate(ref.getUTCDate() - daysFromMonday)

  const mondayStr = monday.toISOString().slice(0, 10)
  const sundayStr = new Date(monday.getTime() + 6 * 86400000).toISOString().slice(0, 10)

  let tssTotal = 0
  let minutesTotal = 0
  let kmTotal = 0

  for (const day of series) {
    if (day.date >= mondayStr && day.date <= sundayStr) {
      tssTotal += day.tss
      minutesTotal += day.durationMinutes
      kmTotal += day.distanceKm
    }
  }

  return {
    tssTotal: Math.round(tssTotal),
    hoursTotal: round(minutesTotal / 60),
    kmTotal: Math.round(kmTotal),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rounds a number to one decimal place for display */
function round(n: number): number {
  return Math.round(n * 10) / 10
}
