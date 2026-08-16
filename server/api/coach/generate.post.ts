/**
 * POST /api/coach/generate
 *
 * Calls the Anthropic Messages API with the user's stored training plan,
 * current FTP, and current weight, and returns a structured workout
 * (matching WorkoutBuilderTab.vue's Block union) plus a fuelling guide.
 *
 * Non-streaming, single structured response — output is small (a handful
 * of blocks + a paragraph of text), well under where streaming becomes
 * necessary. Every failure path (missing plan, upstream timeout, exhausted
 * retries, refusal, schema mismatch) collapses to a single error response;
 * nothing partial is ever returned.
 */

import { eq, and } from 'drizzle-orm'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { users, plannedWorkouts } from '../../db/schema'
import { useDB } from '../../db'
import { CoachWorkoutSchema } from '../../utils/anthropic'

const FALLBACK_WEIGHT_KG = 68

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

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

  // Today's specific planned entry (name/type/tss/duration/notes), if the
  // planning grid has one — this is what actually names the session (e.g.
  // "Sweet spot 3x12min"). Without it the model only ever saw the long-form
  // plan document and had to *guess* which session type today was, which
  // repeatedly produced the wrong workout type (e.g. VO2max instead of
  // sweet spot).
  const todayStr = new Date().toISOString().slice(0, 10)
  const [plannedRow] = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, user.id), eq(plannedWorkouts.date, todayStr)))
    .limit(1)

  const todaysSessionText = plannedRow
    ? [
        'Today\'s planned session (from the planning grid — this is the specific workout to build, not a general '
        + 'day from the plan document):',
        `- Name: ${plannedRow.name ?? '(untitled)'}`,
        plannedRow.type ? `- Zone/type: ${plannedRow.type}` : null,
        plannedRow.tss ? `- Target TSS: ${plannedRow.tss}` : null,
        plannedRow.durationMinutes ? `- Target duration: ${plannedRow.durationMinutes} minutes` : null,
        plannedRow.notes ? `- Notes: ${plannedRow.notes}` : null,
      ].filter(Boolean).join('\n')
    : null

  try {
    const client = getAnthropicClient()
    const response = await client.messages.parse({
      model: 'claude-sonnet-5',
      max_tokens: 7500,
      system: [
        { type: 'text', text: row.trainingPlan, cache_control: { type: 'ephemeral' } },
        {
          type: 'text',
          text: `You are a cycling coach. The rider's current FTP is ${ftpWatts}W and weight is ${weightKg}kg. `
            + (todaysSessionText
              ? `${todaysSessionText}\n\nBuild this exact session as structured blocks — the name and zone/type above `
                + 'take precedence over the general plan document if they ever seem to disagree. Match the interval '
                + 'structure implied by the name (e.g. "3x12min" means three 12-minute work intervals) and the target '
                + 'TSS/duration as closely as possible. '
              : 'Using the training plan above, propose today\'s workout as structured blocks. ')
            + 'Also produce a fuelling guide (use the rider\'s weight for nutrition/hydration calculations). '
            + 'Format the fuelling guide as three short paragraphs — pre-ride, during-ride, post-ride — each on its '
            + 'own line, separated by blank lines.',
        },
      ],
      messages: [{ role: 'user', content: 'Generate today\'s workout.' }],
      output_config: { format: zodOutputFormat(CoachWorkoutSchema) },
    })

    if (!response.parsed_output) {
      throw createError({ statusCode: 502, statusMessage: 'Coach response did not match the expected format' })
    }

    getLogger('coach').info('coach.plan_generated', {
      requestId: event.context.requestId,
      blockCount: response.parsed_output.blocks.length,
    })

    return response.parsed_output
  }
  catch (err: unknown) {
    // Re-throw the "response didn't match schema" createError from above
    // as-is — don't let it fall through to the generic wrapping below.
    if (err && typeof err === 'object' && 'statusCode' in err) throw err

    // Covers the 45s client timeout, retries-exhausted 5xx/429, and a
    // safety refusal — every path lands here as a clean 502. The frontend
    // never sees a half-built workout: it either gets the full object or
    // an error, and nothing is written to the DB either way.
    const e = err as Record<string, any>
    getLogger('coach').error('coach.generation_failed', {
      requestId: event.context.requestId,
      status: e?.status,
      message: e?.message,
    })
    throw createError({ statusCode: 502, statusMessage: 'Failed to generate workout' })
  }
})
