/**
 * POST /api/workouts/:id/insights
 *
 * Generates a one-shot, permanent AI post-ride analysis for a completed
 * workout that has parsed FIT data — see the "Ride insights" button in
 * WorkoutCard.vue / WorkoutFitOverlay.vue's Insights tab.
 *
 * Two things are asked of the model in a single structured response:
 *   1. recovery      — rest-of-today actions + tomorrow's recommendation,
 *                       grounded in the rider's current CTL/ATL/TSB, not
 *                       just this one ride.
 *   2. rideAnalysis   — a qualitative read on how the ride itself went
 *                       (interval execution, HR trend, difficulty vs RPE,
 *                       progression verdict), reasoned from aggregate stats
 *                       + power-curve bests + RPE/notes/workout name, plus a
 *                       downsampled power/HR stream fetched live from
 *                       Strava's API when the workout has a stravaActivityId
 *                       (see server/utils/strava.ts's fetchActivityStreams —
 *                       nothing about the stream is persisted locally).
 *                       Falls back to qualitative-only reasoning if there's
 *                       no stravaActivityId or the Strava fetch fails.
 *
 * Only the workout's owner can trigger this — same id+userId filter as
 * PATCH/DELETE. Requires fitData to already be present, and refuses to
 * regenerate once insights exist (the button that triggers this hides
 * permanently after a successful call).
 */

import { eq, and, asc } from 'drizzle-orm'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { workouts, powerBests, users, type WorkoutInsights } from '../../../db/schema'
import { useDB } from '../../../db'
import { computeMetricsSeries } from '../../../utils/tss'
import { getCachedMetrics, setCachedMetrics } from '../../../utils/metricsCache'
import { getAnthropicClient } from '../../../utils/anthropic'
import { fetchActivityStreams } from '../../../utils/strava'

const RideInsightsSchema = z.object({
  recovery: z.string().describe(
    'Two short paragraphs separated by a blank line: (1) rest-of-today recovery actions, '
    + '(2) tomorrow\'s training recommendation (e.g. "just a light spin", "skip tomorrow", '
    + '"you have room to add a hard workout"). No markdown headers or bullets, blank lines only.',
  ),
  rideAnalysis: z.string().describe(
    'One short paragraph (2-4 sentences) per theme, each separated by a blank line: interval/block '
    + 'execution, HR trend and a closing progression recommendation (repeat this '
    + 'session, progress to the next iteration, or back off). No markdown headers or bullets, blank lines only.',
  ),
})

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid workout ID.' })
  }

  const db = useDB()

  const [workout] = await db
    .select()
    .from(workouts)
    .where(and(eq(workouts.id, id), eq(workouts.userId, user.id)))
    .limit(1)

  if (!workout) {
    throw createError({ statusCode: 404, statusMessage: 'Workout not found.' })
  }
  if (!workout.fitData) {
    throw createError({ statusCode: 400, statusMessage: 'This workout has no parsed FIT data to analyze.' })
  }
  if (workout.insights) {
    throw createError({ statusCode: 400, statusMessage: 'Insights have already been generated for this workout.' })
  }

  const workoutPowerBests = await db
    .select({ duration: powerBests.duration, watts: powerBests.watts })
    .from(powerBests)
    .where(eq(powerBests.workoutId, id))

  // Current training load as of this ride's date — same cached series used by
  // /api/metrics/series and friends.
  let series = getCachedMetrics(user.id)
  if (!series) {
    const [userRow] = await db
      .select({ initialCtl: users.initialCtl, initialAtl: users.initialAtl })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    const allWorkouts = await db
      .select({ date: workouts.date, tss: workouts.tss, durationMinutes: workouts.durationMinutes })
      .from(workouts)
      .where(eq(workouts.userId, user.id))
      .orderBy(asc(workouts.date))

    series = computeMetricsSeries(allWorkouts, {
      initialCTL: userRow?.initialCtl ?? 0,
      initialATL: userRow?.initialAtl ?? userRow?.initialCtl ?? 0,
    })
    setCachedMetrics(user.id, series)
  }
  const dayMetrics = series.find((d) => d.date === workout.date)

  // Downsampled power/HR stream from Strava, if this workout has a linked
  // activity — best-effort, since a fetch failure shouldn't block insights
  // generation (falls back to the qualitative-only prompt below).
  let powerHrStream: { t: number, watts: number | null, heartrate: number | null }[] | null = null
  if (workout.stravaActivityId) {
    try {
      const stream = await fetchActivityStreams(workout.stravaActivityId)
      if (stream.length > 0) powerHrStream = stream
    }
    catch (err: unknown) {
      const e = err as Record<string, any>
      getLogger('coach').warn('coach.insights_stream_fetch_failed', {
        requestId: event.context.requestId,
        workoutId: id,
        stravaActivityId: workout.stravaActivityId,
        status: e?.status,
        message: e?.message,
      })
    }
  }

  const promptData = {
    name: workout.name,
    date: workout.date,
    rideType: workout.rideType,
    durationMinutes: workout.durationMinutes,
    distanceKm: workout.distanceKm,
    tss: workout.tss,
    rpe: workout.rpe,
    notes: workout.notes,
    ftpWatts: workout.ftpWatts,
    fitData: workout.fitData,
    powerBests: workoutPowerBests,
    trainingLoad: dayMetrics
      ? { ctl: dayMetrics.ctl, atl: dayMetrics.atl, tsb: dayMetrics.tsb }
      : null,
    // Downsampled to ~120 evenly-spaced samples; each point's `t` is elapsed
    // seconds from ride start, `watts`/`heartrate` are the bucket average.
    powerHrStream,
  }

  try {
    const client = getAnthropicClient()
    const response = await client.messages.parse({
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      system: [
        {
          type: 'text',
          text: 'You are a cycling coach analyzing a rider\'s just-completed ride. You are given aggregate '
            + 'stats from a parsed FIT file (avg/max/normalized power, intensity factor, avg/max HR, avg/max '
            + 'cadence), power-curve bests per duration, TSS, RPE, any free-text notes, the ride/workout name. '
            + 'You are also given powerHrStream: an evenly-spaced downsampled series of {t (elapsed seconds), '
            + 'watts, heartrate} points across the whole ride — use it to identify interval blocks '
            + '(surges vs steady/rest sections), pacing/fade within efforts, and HR drift over time, rather '
            + 'than guessing. It\'s downsampled, so treat exact per-second values '
            + 'as approximate, but the overall shape (number of efforts, roughly how long, how hard) is reliable.'
            + 'Produce exactly two things: '
            + '1) recovery — grounded in the athlete\'s ride.'
            + '2) rideAnalysis — a focused read on how the ride went. '
            + 'Be direct and concise, coach-to-athlete tone, no hedging disclaimers about missing data beyond '
            + 'what\'s naturally implied.',
        },
      ],
      messages: [{ role: 'user', content: JSON.stringify(promptData) }],
      output_config: { format: zodOutputFormat(RideInsightsSchema) },
    })

    if (!response.parsed_output) {
      throw createError({ statusCode: 502, statusMessage: 'Insights response did not match the expected format' })
    }

    const insights: WorkoutInsights = {
      recovery: response.parsed_output.recovery,
      rideAnalysis: response.parsed_output.rideAnalysis,
      generatedAt: new Date().toISOString(),
    }

    await db
      .update(workouts)
      .set({ insights })
      .where(and(eq(workouts.id, id), eq(workouts.userId, user.id)))

    getLogger('coach').info('coach.insights_generated', {
      requestId: event.context.requestId,
      workoutId: id,
    })

    return { insights }
  }
  catch (err: unknown) {
    if (err && typeof err === 'object' && 'statusCode' in err) throw err

    const e = err as Record<string, any>
    getLogger('coach').error('coach.insights_generation_failed', {
      requestId: event.context.requestId,
      workoutId: id,
      status: e?.status,
      message: e?.message,
    })
    throw createError({ statusCode: 502, statusMessage: 'Failed to generate ride insights' })
  }
})
