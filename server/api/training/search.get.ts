/**
 * GET /api/training/search?q=erg&scope=ridden&io=indoor&tss=60-&dur=-90&date=2026-10-01..&types=zone4,zone5
 *
 * Searches the whole history (rides and plans). A day matches when all given
 * criteria hold; the day is judged on its ride when one exists, otherwise on
 * its plan (planned TSS / minutes). Rest days never match.
 *
 *  q      case-insensitive substring over name + notes
 *  scope  all | ridden | planned (planned = not ridden, has a non-rest plan)
 *  io     all | indoor | outdoor
 *  tss    "min-max", either side optional      dur  same, minutes      dist  same, km (rides only)
 *  date   "from..to" (YYYY-MM-DD), either side optional
 *  types  comma list of zone2|zone4|zone5|zone6|outdoor; a ride without a plan
 *         counts as `outdoor` when ridden outdoors, otherwise has no type
 *
 * Returns every day of each week holding a match (so the grid can dim the rest),
 * plus the matching dates. Capped at the most recent MAX_MATCH_WEEKS weeks.
 */

import { eq } from 'drizzle-orm'
import { plannedWorkouts, workouts } from '../../db/schema'
import { useDB } from '../../db'
import { buildTrainingDays, selectRides } from '../../utils/trainingDays'
import type { TrainingSearchResponse } from '#shared/types/training'

const MAX_MATCH_WEEKS = 60
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface Range { min: number | null, max: number | null }

/** Parses "60-", "-90" or "60-90"; anything else is "no bound". */
function parseRange(raw: unknown): Range {
  const m = typeof raw === 'string' ? /^(\d*)-(\d*)$/.exec(raw) : null
  return { min: m?.[1] ? Number(m[1]) : null, max: m?.[2] ? Number(m[2]) : null }
}

const inRange = (value: number, r: Range) => (r.min == null || value >= r.min) && (r.max == null || value <= r.max)

export default defineEventHandler(async (event): Promise<TrainingSearchResponse> => {
  const { user } = await requireUserSession(event)
  const query = getQuery(event)

  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''
  const scope = query.scope === 'ridden' || query.scope === 'planned' ? query.scope : 'all'
  const io = query.io === 'indoor' || query.io === 'outdoor' ? query.io : 'all'
  const tss = parseRange(query.tss)
  const dur = parseRange(query.dur)
  const dist = parseRange(query.dist)
  const [dateFrom = '', dateTo = ''] = typeof query.date === 'string' ? query.date.split('..') : []
  const from = ISO_DATE_RE.test(dateFrom) ? dateFrom : ''
  const to = ISO_DATE_RE.test(dateTo) ? dateTo : ''
  const types = typeof query.types === 'string' && query.types ? new Set(query.types.split(',')) : null

  const db = useDB()
  const [rides, plans] = await Promise.all([
    selectRides(eq(workouts.userId, user.id)),
    db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, user.id)),
  ])

  const planByDate = new Map(plans.map(p => [p.date, p]))
  const dates = new Set([...rides.map(r => r.date), ...plans.map(p => p.date)])
  const rideByDate = new Map(rides.map(r => [r.date, r]))

  const matches: string[] = []
  for (const date of dates) {
    if ((from && date < from) || (to && date > to)) continue
    const ride = rideByDate.get(date)
    const plan = planByDate.get(date)
    if (!ride && (!plan || plan.type === 'rest')) continue
    if (scope === 'ridden' && !ride) continue
    if (scope === 'planned' && ride) continue

    const name = ride ? ride.name : (plan?.name ?? '')
    const notes = ride ? ride.notes : plan?.notes
    if (q && !`${name} ${notes ?? ''}`.toLowerCase().includes(q)) continue

    const isOutdoor = ride ? ride.rideType === 'outdoor' : plan?.type === 'outdoor'
    if (io === 'outdoor' && !isOutdoor) continue
    if (io === 'indoor' && isOutdoor) continue

    if (!inRange((ride ? ride.tss : plan?.tss) ?? 0, tss)) continue
    if (!inRange((ride ? ride.durationMinutes : plan?.durationMinutes) ?? 0, dur)) continue

    if (!inRange(ride?.distanceKm ?? 0, dist)) continue

    if (types && !types.has(plan?.type ?? (ride?.rideType === 'outdoor' ? 'outdoor' : ''))) continue

    matches.push(date)
  }
  matches.sort()

  if (matches.length === 0) return { days: [], matches, truncated: false }

  // Keep the newest MAX_MATCH_WEEKS weeks that hold matches.
  const weeks = [...new Set(matches.map(mondayOf))]
  const keptList = weeks.slice(-MAX_MATCH_WEEKS)
  const keptWeeks = new Set(keptList)
  const kept = matches.filter(d => keptWeeks.has(mondayOf(d)))

  const { days } = await buildTrainingDays(user.id, keptList[0]!, addDaysIso(keptList.at(-1)!, 6))
  return {
    days: days.filter(d => keptWeeks.has(mondayOf(d.date))),
    matches: kept,
    truncated: kept.length < matches.length,
  }
})
