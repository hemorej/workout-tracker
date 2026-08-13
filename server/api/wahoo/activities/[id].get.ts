/**
 * GET /api/wahoo/activities/:id
 *
 * Downloads and parses a single Wahoo workout's FIT file, computing TSS and
 * power-curve bests against the user's current FTP (most recent workout's
 * ftp_watts, falling back to 230 if none has ever been logged — mirrors the
 * fixed FTP CLAUDE.md documents for plan generation).
 *
 * As a side effect, upserts the computed bests into `wahoo_power_bests` and
 * prunes it back down to the all-time top-3 / trailing-8-week retention
 * window per duration — this happens on every preview (not just on save),
 * so wahoo_power_bests tracks the best power seen in any ride the user has
 * looked at, independent of what they choose to log (see CLAUDE.md).
 *
 * Returns:
 *   200 { ride: WahooRideSummary, tss: number, powerBests: { duration, watts }[] }
 *   400 for an invalid id
 *   422 if the workout has no FIT file yet, or the file has no power data
 *   502 if the Wahoo API call fails
 */

import { desc, isNotNull, eq, and, sql } from 'drizzle-orm'
import { workouts, wahooPowerBests } from '../../../db/schema'
import { useDB } from '../../../db'
import { fetchAndParseActivity } from '../../../utils/wahoo'

const FALLBACK_FTP = 230
const EIGHT_WEEKS_MS = 8 * 7 * 24 * 60 * 60 * 1000

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const idParam = getRouterParam(event, 'id')
  const workoutId = Number(idParam)
  if (!Number.isInteger(workoutId) || workoutId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid activity id.' })
  }

  const db = useDB()

  const [mostRecentFtp] = await db
    .select({ ftpWatts: workouts.ftpWatts })
    .from(workouts)
    .where(and(eq(workouts.userId, user.id), isNotNull(workouts.ftpWatts)))
    .orderBy(desc(workouts.date))
    .limit(1)

  const ftpWatts = mostRecentFtp?.ftpWatts ?? FALLBACK_FTP

  let ride, metrics
  try {
    ({ ride, metrics } = await fetchAndParseActivity(workoutId, ftpWatts))
  }
  catch (err: unknown) {
    if ((err as { statusCode?: number })?.statusCode) throw err // already a createError (e.g. no FIT file)

    const e = err as Record<string, any>
    getLogger('wahoo').error('wahoo.fetch_activity_failed', {
      requestId: event.context.requestId,
      workoutId,
      status: e?.status ?? e?.response?.status,
      err: e?.message,
    })
    if (e?.message?.includes('No power data')) {
      throw createError({ statusCode: 422, statusMessage: 'This ride has no power data.' })
    }
    throw createError({ statusCode: 502, statusMessage: 'Failed to fetch activity from Wahoo.' })
  }

  const powerBests = Object.entries(metrics.bests).map(([duration, watts]) => ({ duration, watts: watts! }))
  const achievedAt = ride.startDateLocal.slice(0, 10)

  if (powerBests.length > 0) {
    await db
      .insert(wahooPowerBests)
      .values(powerBests.map((pb) => ({ activityId: workoutId, duration: pb.duration, watts: pb.watts, achievedAt })))
      .onConflictDoUpdate({
        target: [wahooPowerBests.activityId, wahooPowerBests.duration],
        set: { watts: sql`excluded.watts` },
      })

    const cutoff = new Date(Date.now() - EIGHT_WEEKS_MS).toISOString().slice(0, 10)
    await db.execute(sql`
      DELETE FROM wahoo_power_bests
      WHERE id IN (
        SELECT id FROM (
          SELECT id, achieved_at,
                 RANK() OVER (PARTITION BY duration ORDER BY watts DESC) AS rank
          FROM wahoo_power_bests
        ) ranked
        WHERE rank > 3 AND achieved_at < ${cutoff}
      )
    `)
  }

  getLogger('wahoo').info('wahoo.activity_parsed', {
    requestId: event.context.requestId,
    workoutId,
    tss: metrics.tss,
    ftpWatts,
  })

  return { ride, tss: metrics.tss, powerBests }
})
