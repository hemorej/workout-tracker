/**
 * GET /api/coach/block-progression
 *
 * Returns whether the user has a stored training plan and, if so, the weekly
 * TSS progression of one training block parsed from it (e.g. [380, 430, 480, 250]).
 * The Planning tab's block-position detection falls back to matching a week's
 * TSS total against this when no "w1:"-style marker is found in workout names.
 *
 * Parsing is one small LLM call, cached in-process per user keyed by a hash of
 * the plan text (so editing the plan re-parses). A failed parse is not cached
 * and degrades to `weeklyTss: null` — detection just skips the TSS fallback.
 *
 * Response: { hasPlan: boolean, weeklyTss: number[] | null }
 */

import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import { useDB } from '../../db'
import { extractBlockProgression } from '../../utils/anthropic'

const cache = new Map<number, { hash: string, weeklyTss: number[] | null }>()

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const [row] = await useDB()
    .select({ trainingPlan: users.trainingPlan })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)

  const plan = row?.trainingPlan?.trim()
  if (!plan) return { hasPlan: false, weeklyTss: null }

  const hash = createHash('sha1').update(plan).digest('hex')
  const hit = cache.get(user.id)
  if (hit?.hash === hash) return { hasPlan: true, weeklyTss: hit.weeklyTss }

  try {
    const { weeklyTss } = await extractBlockProgression(
      [
        { type: 'text', text: plan, cache_control: { type: 'ephemeral' } },
        {
          type: 'text',
          text: 'You read cycling training plans. Extract the target total TSS for each week of ONE repeating '
            + 'training block (e.g. three build weeks then a recovery week), in block order. Return null if the '
            + 'plan does not state or clearly imply weekly TSS totals — never invent numbers.',
        },
      ],
      'Extract the weekly TSS progression of one block.',
    )
    const cleaned = weeklyTss && weeklyTss.length >= 2 && weeklyTss.every(n => n > 0) ? weeklyTss.map(Math.round) : null
    cache.set(user.id, { hash, weeklyTss: cleaned })
    return { hasPlan: true, weeklyTss: cleaned }
  }
  catch (err) {
    getLogger('coach').warn('coach.progression_failed', {
      requestId: event.context.requestId,
      message: (err as Error)?.message,
    })
    return { hasPlan: true, weeklyTss: null }
  }
})
