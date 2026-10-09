/**
 * Training-block position detection for the Planning tab's "Suggest plan".
 *
 * Given the weeks *before* the start week (nearest first), work out which slot
 * of the block the start week falls in (0 = Build 1 … blockLength-1 = Recovery):
 *   1. keyword — a "w2:"-style marker in a workout name ("W2: 4x8 threshold");
 *   2. TSS     — the week's total TSS is closest to one of the plan's weekly
 *                targets (e.g. 430 on a [380, 430, 480, 250] progression → week 2);
 *   3. none    — nothing recognisable, so a new block starts at slot 0.
 */

export interface WeekSummary {
  monday: string
  /** Names of the planned/logged workouts that week */
  names: string[]
  /** Logged TSS for past days + planned TSS for future days */
  tss: number
}

export interface BlockDetection {
  /** Slot of the start week within the block */
  position: number
  source: 'keyword' | 'tss' | 'none'
  /** Monday of the earlier week the detection was based on */
  basedOn: string | null
  /** 1-based block week that `basedOn` was recognised as */
  weekNumber: number | null
}

const MARKER = /\bw([1-9])\s*:/i
/** How far a week's TSS may sit from a target and still count as that week. */
const TSS_TOLERANCE = 0.12

export function keywordWeek(names: string[], blockLength: number): number | null {
  let found: number | null = null
  for (const name of names) {
    const n = Number(MARKER.exec(name)?.[1])
    if (n >= 1 && n <= blockLength) found = Math.max(found ?? 0, n)
  }
  return found
}

export function tssWeek(tss: number, progression: number[] | null): number | null {
  if (!progression?.length || tss <= 0) return null
  let best: { week: number, diff: number } | null = null
  progression.forEach((target, i) => {
    const diff = Math.abs(tss - target) / target
    if (diff <= TSS_TOLERANCE && (!best || diff < best.diff)) best = { week: i + 1, diff }
  })
  return (best as { week: number } | null)?.week ?? null
}

/**
 * @param previousWeeks weeks before the start week, nearest first (looks back at most 2)
 * @param blockLength   weeks per block (progression length when known, else 4)
 */
export function detectBlockPosition(
  previousWeeks: WeekSummary[],
  blockLength: number,
  progression: number[] | null,
): BlockDetection {
  for (const source of ['keyword', 'tss'] as const) {
    for (let back = 0; back < Math.min(2, previousWeeks.length); back++) {
      const w = previousWeeks[back]!
      const week = source === 'keyword' ? keywordWeek(w.names, blockLength) : tssWeek(w.tss, progression)
      // Only the nearest week is trusted for the TSS fallback; a keyword may be
      // one week further back (e.g. only the first day of a week is labelled).
      if (week == null || (source === 'tss' && back > 0)) continue
      return { position: (week + back) % blockLength, source, basedOn: w.monday, weekNumber: week }
    }
  }
  return { position: 0, source: 'none', basedOn: null, weekNumber: null }
}
