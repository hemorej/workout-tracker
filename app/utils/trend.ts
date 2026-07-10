/**
 * Shared trend-arrow helper for CTL/ATL/TSB values.
 *
 * A pure "direction" indicator: green when the value moved up vs. the
 * prior entry, amber when it moved down, omitted when the change is
 * within the noise threshold or there's no prior value to compare to.
 */
export interface Trend {
  symbol: '▲' | '▼'
  colorClass: string
}

const NOISE_THRESHOLD = 0.5

export function trendArrow(current: number, previous: number | null | undefined): Trend | null {
  if (previous == null) return null
  const delta = current - previous
  if (delta >= NOISE_THRESHOLD) return { symbol: '▲', colorClass: 'text-emerald-600' }
  if (delta <= -NOISE_THRESHOLD) return { symbol: '▼', colorClass: 'text-amber-600' }
  return null
}
