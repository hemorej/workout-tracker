/**
 * Option lists and formatters for the Training search filters, shared by the
 * desktop chips (TrainingToolbar) and the mobile filter sheet.
 */
import type { SearchIo } from '~/stores/trainingSearch'

export interface FilterRange { min: number | null, max: number | null }

export const EMPTY_RANGE: FilterRange = { min: null, max: null }
export const noRange = (r: FilterRange) => r.min == null && r.max == null

export function rangeText(r: FilterRange, fmt: (n: number) => string) {
  if (noRange(r)) return 'Any'
  if (r.min != null && r.max != null) return `${fmt(r.min)} – ${fmt(r.max)}`
  return r.min != null ? `${fmt(r.min)}+` : `≤ ${fmt(r.max!)}`
}

export const IO_OPTIONS: { value: SearchIo, label: string }[] = [
  { value: 'all', label: 'Indoor & outdoor' }, { value: 'indoor', label: 'Indoor' }, { value: 'outdoor', label: 'Outdoor' },
]

export const TSS_PRESETS = [{ label: 'Easy < 40', min: null, max: 40 }, { label: '40 – 80', min: 40, max: 80 }, { label: 'Hard 80+', min: 80, max: null }]
export const DURATION_PRESETS = [{ label: 'Under 45m', min: null, max: 45 }, { label: '45m – 1h30', min: 45, max: 90 }, { label: '1h30+', min: 90, max: null }]
export const DISTANCE_PRESETS = [{ label: 'Under 30 km', min: null, max: 30 }, { label: '30 – 60 km', min: 30, max: 60 }, { label: '60 km+', min: 60, max: null }]

export const formatKm = (n: number) => `${n} km`

/** Relative date ranges, resolved to concrete dates when applied (so the URL stays shareable). */
export function datePresets() {
  const today = localDateIso()
  const monday = mondayOf(today)
  return [
    { label: 'Any time', from: '', to: '' },
    { label: 'This week', from: monday, to: addDaysIso(monday, 6) },
    { label: 'Last 2 weeks', from: addDaysIso(today, -13), to: today },
    { label: 'Next 2 weeks', from: today, to: addDaysIso(today, 13) },
  ]
}

export function dateRangeText(d: { from: string, to: string }) {
  return datePresets().find(p => p.from === d.from && p.to === d.to)?.label
    ?? (d.from && d.to ? `${d.from} – ${d.to}` : d.from ? `From ${d.from}` : `Until ${d.to}`)
}

export const typeFilterOptions = PLAN_ZONES.filter(z => z.value !== 'rest')
export const toggleType = (list: string[], value: string) => (list.includes(value) ? list.filter(v => v !== value) : [...list, value])
