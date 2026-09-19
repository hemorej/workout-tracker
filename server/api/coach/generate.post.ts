/**
 * POST /api/coach/generate
 *
 * Calls the Anthropic Messages API with the user's stored training plan,
 * current FTP, and current weight, and returns a structured workout
 * (matching WorkoutBuilderTab.vue's Block union) plus a fuelling guide.
 *
 * Streamed request, collected server-side into a single structured response
 * (see server/utils/anthropic.ts). The stream is only used so the timeout
 * bounds time-to-first-token instead of the whole generation (a slow
 * structured response was tripping the 45s timeout and getting logged
 * upstream as a 499 "client disconnected"). Every failure path (missing
 * plan, upstream timeout, exhausted retries, refusal, schema mismatch)
 * collapses to a single error response; nothing partial is ever returned.
 *
 * Query params (both optional):
 *  - `date` (YYYY-MM-DD) — the planned day to build for. Defaults to today.
 *    Used by both the Training Log's "Auto" button (today only) and the
 *    Planning tab's per-row build actions (any planned day).
 *  - `mode` — `'full'` (default) returns a complete workout (blocks + fuelling
 *    guide). `'fuelling'` skips the block structure and returns only the
 *    fuelling guide, for the Planning tab's fuelling-only row action.
 */

import { eq, and } from 'drizzle-orm'
import { users, plannedWorkouts } from '../../db/schema'
import { useDB } from '../../db'
import { generateCoachWorkout, generateCoachFuellingGuide, type AnthropicSystemBlock } from '../../utils/anthropic'

const FALLBACK_WEIGHT_KG = 68

function isValidDateParam(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const query = getQuery(event)
  const targetDate = isValidDateParam(query.date) ? query.date : new Date().toISOString().slice(0, 10)
  const fuellingOnly = query.mode === 'fuelling'

  const db = useDB()
  const [row] = await db
    .select({ trainingPlan: users.trainingPlan, weightKg: users.weightKg })
    .from(users)
    .where(eq(users.id, user.id))

  if (!row?.trainingPlan) {
    throw createError({ statusCode: 422, statusMessage: 'No training plan set for this account' })
  }

  const ftpWatts = await getCurrentFtpWatts(user.id)
  const weightKg = row.weightKg ?? FALLBACK_WEIGHT_KG

  // The target date's specific planned entry (name/type/tss/duration/notes),
  // if the planning grid has one — this is what actually names the session
  // (e.g. "Sweet spot 3x12min"). Without it the model only ever saw the
  // long-form plan document and had to *guess* which session type the day
  // was, which repeatedly produced the wrong workout type (e.g. VO2max
  // instead of sweet spot).
  const [plannedRow] = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, user.id), eq(plannedWorkouts.date, targetDate)))
    .limit(1)

  const dayLabel = targetDate === new Date().toISOString().slice(0, 10) ? 'Today\'s' : 'This day\'s'
  const plannedSessionText = plannedRow
    ? [
        `${dayLabel} planned session (from the planning grid — this is the specific workout to build, not a `
        + 'general day from the plan document):',
        `- Name: ${plannedRow.name ?? '(untitled)'}`,
        plannedRow.type ? `- Zone/type: ${plannedRow.type}` : null,
        plannedRow.tss ? `- Target TSS: ${plannedRow.tss}` : null,
        plannedRow.durationMinutes ? `- Target duration: ${plannedRow.durationMinutes} minutes` : null,
        plannedRow.notes ? `- Notes: ${plannedRow.notes}` : null,
      ].filter(Boolean).join('\n')
    : null

  const taskText = fuellingOnly
    ? (plannedSessionText
        ? `${plannedSessionText}\n\nProduce only a fuelling guide for this specific session (use the rider's weight `
          + 'for nutrition/hydration calculations) — do not build the workout structure.'
        : 'Using the training plan above, produce only a fuelling guide for the day\'s session (use the rider\'s '
          + 'weight for nutrition/hydration calculations) — do not build the workout structure.')
      + ' Format the fuelling guide as three short paragraphs — pre-ride, during-ride, post-ride — each on its own '
      + 'line, separated by blank lines.'
    : (plannedSessionText
        ? `${plannedSessionText}\n\nBuild this exact session as structured blocks — the name and zone/type above `
          + 'take precedence over the general plan document if they ever seem to disagree. Match the interval '
          + 'structure implied by the name (e.g. "3x12min" means three 12-minute work intervals) and the target '
          + 'TSS/duration as closely as possible. '
        : 'Using the training plan above, propose the day\'s workout as structured blocks. ')
      + 'Also produce a fuelling guide (use the rider\'s weight for nutrition/hydration calculations). '
      + 'Format the fuelling guide as three short paragraphs — pre-ride, during-ride, post-ride — each on its '
      + 'own line, separated by blank lines.'

  const systemBlocks: AnthropicSystemBlock[] = [
    { type: 'text', text: row.trainingPlan, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `You are a cycling coach. The rider's current FTP is ${ftpWatts}W and weight is ${weightKg}kg. ${taskText}` },
  ]

  try {
    // generateCoachWorkout/generateCoachFuellingGuide stream the request (so
    // the timeout only bounds time-to-first-token), retry transient
    // failures, and Zod-parse the result — so the contract here is a fully-
    // validated response or a thrown error, nothing partial.
    if (fuellingOnly) {
      const guide = await generateCoachFuellingGuide(systemBlocks, 'Generate the fuelling guide.')

      getLogger('coach').info('coach.fuelling_guide_generated', {
        requestId: event.context.requestId,
        date: targetDate,
      })

      return guide
    }

    const workout = await generateCoachWorkout(systemBlocks, 'Generate the workout.')

    getLogger('coach').info('coach.plan_generated', {
      requestId: event.context.requestId,
      date: targetDate,
      blockCount: workout.blocks.length,
    })

    return workout
  }
  catch (err: unknown) {
    // Re-throw the "response didn't match schema" createError from above
    // as-is — don't let it fall through to the generic wrapping below.
    if (err && typeof err === 'object' && 'statusCode' in err) throw err

    // Covers a time-to-first-token timeout, a mid-stream disconnect,
    // retries-exhausted 5xx/429, and a safety refusal — every path lands
    // here as a clean 502. The frontend never sees a half-built workout: it
    // either gets the full object or an error, and nothing is written to the
    // DB either way.
    getLogger('coach').error('coach.generation_failed', {
      requestId: event.context.requestId,
      message: (err as Error)?.message,
    })
    throw createError({ statusCode: 502, statusMessage: 'Failed to generate workout' })
  }
})
