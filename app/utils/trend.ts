/**
 * CTL trend-arrow helper.
 *
 * Compares today's CTL with the value 7 days ago (a rolling week-over-week
 * "ramp rate"). Direction only: green for up, amber for down. Bands, by
 * absolute change in CTL points over the week:
 *   < 2   : flat — no arrow
 *   2 – 5 : steady build / drop — one arrow
 *   ≥ 5   : hard ramp (the usual "aggressive" threshold) — two stacked arrows
 * Omitted when there's no value 7 days ago to compare to.
 */
export interface Trend {
  symbol: '▲' | '▼'
  count: 1 | 2
  colorClass: string
}

export const TREND_SINGLE_THRESHOLD = 2
export const TREND_DOUBLE_THRESHOLD = 5

export function trendArrow(current: number, previous: number | null | undefined): Trend | null {
  if (previous == null) return null
  const delta = current - previous
  const size = Math.abs(delta)
  if (size < TREND_SINGLE_THRESHOLD) return null
  const count = size >= TREND_DOUBLE_THRESHOLD ? 2 : 1
  return delta > 0
    ? { symbol: '▲', count, colorClass: 'text-emerald-600' }
    : { symbol: '▼', count, colorClass: 'text-amber-600' }
}
