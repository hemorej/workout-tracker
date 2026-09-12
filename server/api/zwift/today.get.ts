/**
 * GET /api/zwift/today?date=YYYY-MM-DD
 *
 * Powers the Planning tab's "Today's events" dialog: today's Climb Portal
 * rotation plus upcoming Time Trial / crit races. See
 * server/utils/zwiftEvents.ts for the (undocumented) upstream sources —
 * each half is fetched independently and degrades to an empty array on
 * failure rather than failing the whole request.
 *
 * `date` must be the caller's own local calendar day (see the timezone note
 * in zwiftEvents.ts) — it only affects which climb is "today's"; races are
 * simply the upcoming window regardless of date.
 *
 * Response: { climbs: ClimbPortalEntry[], races: RaceEventEntry[] }
 */

export default defineEventHandler(async (event) => {
  await requireUserSession(event)

  const query = getQuery(event)
  const dateParam = typeof query.date === 'string' ? query.date : undefined
  const todayStr = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
    ? dateParam
    : new Date().toISOString().slice(0, 10)

  const [climbs, races] = await Promise.all([
    fetchClimbPortalSchedule(todayStr),
    fetchTodaysRaceEvents(),
  ])

  return { climbs, races }
})
