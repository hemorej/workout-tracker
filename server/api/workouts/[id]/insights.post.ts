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
 *                       + power-curve bests + RPE/notes/workout name, since
 *                       no raw per-second stream is persisted.
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

const RideInsightsSchema = z.object({
  recovery: z.string().describe(
    'Two short paragraphs separated by a blank line: (1) rest-of-today recovery actions, '
    + '(2) tomorrow\'s training recommendation (e.g. "just a light spin", "skip tomorrow", '
    + '"you have room to add a hard workout"). No markdown headers or bullets, blank lines only.',
  ),
  rideAnalysis: z.string().describe(
    'One short paragraph (2-4 sentences) per theme, each separated by a blank line: interval/block '
    + 'execution, HR trend, perceived difficulty vs RPE, and a closing progression verdict (repeat this '
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
  }

  try {
    const client = getAnthropicClient()
    const response = await client.messages.parse({
      model: 'claude-sonnet-5',
      max_tokens: 5000,
      system: [
        {
          type: 'text',
          text: 'You are a cycling coach analyzing a rider\'s just-completed ride. You are given aggregate '
            + 'stats from a parsed FIT file (avg/max/normalized power, intensity factor, avg/max HR, avg/max '
            + 'cadence), power-curve bests per duration, TSS, RPE, any free-text notes, the ride/workout name, '
            + 'and the rider\'s current CTL (fitness)/ATL (fatigue)/TSB (form) as of this ride\'s date. There is '
            + 'no raw per-second power/HR stream available — for indoor structured workouts, infer likely '
            + 'interval structure qualitatively from the workout name (e.g. "3x8min VO2") combined with RPE and '
            + 'notes, rather than claiming precise per-interval numbers you don\'t have. '
            + 'Produce exactly two things: '
            + '1) recovery — grounded in the rider\'s CTL/ATL/TSB as well as this ride, not just this ride alone. '
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
