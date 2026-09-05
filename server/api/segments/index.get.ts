/**
 * GET /api/segments
 *
 * Powers the History → Segments tab: every tracked (still-starred) segment
 * for the user, each with its five fastest stored efforts.
 *
 * Speed is derived here (`distance / elapsed_time`) rather than stored —
 * Strava's segment-effort payload has no speed field. Elevation gain is a
 * property of the segment, not the effort, so it's returned once at the
 * segment level.
 *
 * Response:
 * {
 *   segments: {
 *     id, name, distanceMeters, averageGrade, climbCategory,
 *     totalElevationGain, city, state, country,
 *     effortCount,               // stored efforts, not Strava's lifetime count
 *     prElapsedTime,
 *     efforts: {
 *       rank,                    // 1..5, by elapsed time
 *       elapsedTime, movingTime, speedKmh,
 *       averageWatts, deviceWatts,
 *       averageHeartrate, maxHeartrate, averageCadence,
 *       prRank,                  // Strava's own 1/2/3 badge, or null
 *       startDate, stravaActivityId,
 *     }[]
 *   }[]
 * }
 */

import { asc, eq, and } from 'drizzle-orm'
import { useDB } from '../../db'
import { trackedSegments, segmentEfforts } from '../../db/schema'

const TOP_N = 5

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const db = useDB()

  const segments = await db
    .select()
    .from(trackedSegments)
    .where(and(eq(trackedSegments.userId, user.id), eq(trackedSegments.starred, true)))
    .orderBy(asc(trackedSegments.name))

  if (segments.length === 0) return { segments: [] }

  const efforts = await db
    .select()
    .from(segmentEfforts)
    .where(eq(segmentEfforts.userId, user.id))
    .orderBy(asc(segmentEfforts.elapsedTime))

  const bySegment = new Map<number, typeof efforts>()
  for (const e of efforts) {
    const list = bySegment.get(e.segmentId)
    if (list) list.push(e)
    else bySegment.set(e.segmentId, [e])
  }

  return {
    segments: segments.map((s) => {
      const all = bySegment.get(s.id) ?? []
      return {
        id: s.id,
        name: s.name,
        distanceMeters: s.distanceMeters,
        averageGrade: s.averageGrade,
        climbCategory: s.climbCategory,
        totalElevationGain: s.totalElevationGain,
        city: s.city,
        state: s.state,
        country: s.country,
        effortCount: all.length,
        prElapsedTime: s.prElapsedTime,
        efforts: all.slice(0, TOP_N).map((e, i) => ({
          rank: i + 1,
          elapsedTime: e.elapsedTime,
          movingTime: e.movingTime,
          speedKmh: e.elapsedTime > 0
            ? ((e.distanceMeters ?? s.distanceMeters) / e.elapsedTime) * 3.6
            : null,
          averageWatts: e.averageWatts,
          deviceWatts: e.deviceWatts,
          averageHeartrate: e.averageHeartrate,
          maxHeartrate: e.maxHeartrate,
          averageCadence: e.averageCadence,
          prRank: e.prRank,
          startDate: e.startDate,
          stravaActivityId: e.stravaActivityId,
        })),
      }
    }),
  }
})
