/**
 * Training-tab helpers: workout-type (zone) config, day state, week grouping
 * and totals, CTL/TSB heat colours, and display formatting. Auto-imported.
 */
import type { DayState, TrainingDay } from '#shared/types/training'

// ── Workout types (zones) ────────────────────────────────────────────────────

export const PLAN_ZONES = [
  { value: 'zone2', label: 'Zone 2' },
  { value: 'zone4', label: 'Zone 4' },
  { value: 'zone5', label: 'Zone 5' },
  { value: 'zone6', label: 'Zone 6' },
  { value: 'rest', label: 'Rest' },
  { value: 'outdoor', label: 'Outdoor' },
] as const

const ZONE_CLASSES: Record<string, string> = {
  zone2: 'bg-sky-100 text-sky-700 border-sky-200',
  zone4: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  zone5: 'bg-orange-100 text-orange-700 border-orange-200',
  zone6: 'bg-red-100 text-red-700 border-red-200',
  rest: 'bg-pink-100 text-pink-600 border-pink-200',
  outdoor: 'bg-[#ddeaff] text-[#495cc9] border-[#c4d6f5]',
  '': 'bg-stone-100 text-stone-500 border-stone-200',
}

export function zoneLabel(type: string | null | undefined) {
  return PLAN_ZONES.find(z => z.value === type)?.label ?? 'No type'
}

export function zoneClass(type: string | null | undefined) {
  return ZONE_CLASSES[type ?? ''] ?? ZONE_CLASSES['']!
}

// ── Day state ────────────────────────────────────────────────────────────────

export function dayState(day: TrainingDay): DayState {
  if (day.ride) return 'ridden'
  if (!day.plan || day.plan.type === 'rest') return 'rest'
  return day.isPast ? 'missed' : 'planned'
}

/** A ride exists or the day is over: the metrics are history, not a projection. */
export function isActualDay(day: TrainingDay) {
  return !!day.ride || day.isPast
}

/** The workout type shown on a day's badge: its plan's, else outdoor for an unplanned outdoor ride. */
export function dayZone(day: TrainingDay) {
  return day.plan?.type ?? (day.ride?.rideType === 'outdoor' ? 'outdoor' : null)
}

/** Ride names drop the "Zwift — " prefix; the badge/ride type already say it. */
export function rideLabel(name: string) {
  return name.replace(/^Zwift\s*[—–-]\s*/i, '')
}

// ── Weeks ────────────────────────────────────────────────────────────────────

export interface TrainingWeek {
  monday: string
  days: TrainingDay[]
}

/** Splits an ascending, whole-week day list into Monday-first weeks. */
export function groupWeeks(days: TrainingDay[]): TrainingWeek[] {
  const weeks: TrainingWeek[] = []
  for (let i = 0; i < days.length; i += 7) weeks.push({ monday: days[i]!.date, days: days.slice(i, i + 7) })
  return weeks
}

export interface WeekTotals {
  doneTss: number
  plannedTss: number
  doneMinutes: number
  plannedMinutes: number
  km: number
}

/** Done = logged rides. Planned = the plan where there is one (so a missed day still counts), else the ride. */
export function weekTotals(days: TrainingDay[]): WeekTotals {
  const t: WeekTotals = { doneTss: 0, plannedTss: 0, doneMinutes: 0, plannedMinutes: 0, km: 0 }
  for (const d of days) {
    if (d.ride) {
      t.doneTss += d.ride.tss
      t.doneMinutes += d.ride.durationMinutes
      t.km += d.ride.distanceKm ?? 0
    }
    const plan = d.plan?.type === 'rest' ? null : d.plan
    t.plannedTss += plan?.tss ?? d.ride?.tss ?? 0
    t.plannedMinutes += plan?.durationMinutes ?? d.ride?.durationMinutes ?? 0
  }
  return t
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatMinutes(minutes: number) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export function formatHours(minutes: number) {
  return (minutes / 60).toFixed(1)
}

const utcFormat = (d: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' })

/** "16 – 22 Nov", or "30 Nov – 6 Dec" across a month boundary. */
export function formatWeekRange(monday: string) {
  const sunday = addDaysIso(monday, 6)
  const a = utcFormat(monday, { day: 'numeric', month: 'short' })
  const b = utcFormat(sunday, { day: 'numeric', month: 'short' })
  const [aDay, aMonth] = a.split(' ')
  const [, bMonth] = b.split(' ')
  return aMonth === bMonth ? `${aDay} – ${b}` : `${a} – ${b}`
}

/** "Thu 19 Nov" */
export function formatDayLong(date: string) {
  return utcFormat(date, { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')
}

export function formatSigned(n: number) {
  return n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1)
}

// ── CTL / TSB heat ───────────────────────────────────────────────────────────
// Only projections are tinted. CTL: red above today's value (building), green
// below (tapering). TSB: red while negative (fatigued), green once positive.

function heat(red: boolean, t: number) {
  const k = Math.min(1, Math.max(0, t))
  if (k === 0) return {}
  const [bg, fg] = red ? ['220, 38, 38', '185, 28, 28'] : ['22, 163, 74', '21, 128, 61']
  return { backgroundColor: `rgba(${bg}, ${0.06 + 0.22 * k})`, color: `rgba(${fg}, ${0.6 + 0.4 * k})` }
}

export function ctlHeat(ctl: number, todayCtl: number) {
  const diff = ctl - todayCtl
  return heat(diff > 0, Math.abs(diff) / 2)
}

export function tsbHeat(tsb: number) {
  return heat(tsb < 0, Math.abs(tsb) / 10)
}

// ── Search text ──────────────────────────────────────────────────────────────

/** Splits `text` into runs, flagging the case-insensitive occurrences of `query`. */
export function splitMatches(text: string, query: string): { text: string, hit: boolean }[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const parts: { text: string, hit: boolean }[] = []
  let from = 0
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), hit: false })
    parts.push({ text: text.slice(at, at + needle.length), hit: true })
    from = at + needle.length
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false })
  return parts
}

/** A one-line excerpt of `notes` around the first match of `query`, or null when it doesn't match. */
export function notesSnippet(notes: string | null | undefined, query: string, radius = 36): string | null {
  const needle = query.trim().toLowerCase()
  const at = needle && notes ? notes.toLowerCase().indexOf(needle) : -1
  if (!notes || at === -1) return null
  const start = Math.max(0, at - radius)
  const end = Math.min(notes.length, at + needle.length + radius)
  return `${start > 0 ? '…' : ''}${notes.slice(start, end).replace(/\s+/g, ' ')}${end < notes.length ? '…' : ''}`
}

// ── Day actions ──────────────────────────────────────────────────────────────

/** Everything the day card (hover card / sheet) can ask the Training tab or page to do. */
export type DayAction =
  | { type: 'open-fit' | 'edit' | 'reupload-fit' | 'refresh-ride' | 'delete-ride', day: TrainingDay }
  | { type: 'mark-completed' | 'add-workout' | 'edit-note' | 'fuelling' | 'build-workout', date: string }
  | { type: 'move', date: string, to: string }

/** The DayActions TrainingTab doesn't handle itself — they need the page's modals and flows. */
export type PageAction = Exclude<DayAction, { type: 'edit-note' | 'fuelling' | 'move' }>
