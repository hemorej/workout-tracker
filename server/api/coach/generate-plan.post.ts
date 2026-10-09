/**
 * POST /api/coach/generate-plan
 *
 * Suggests 1–4 weeks of planned workouts (name/type/TSS/duration per day) for
 * the Planning tab's "Suggest plan" action. Nothing is written — the client
 * previews the result as a draft and applies it via PUT /api/planned-workouts/batch.
 *
 * Body:
 *  - startDate     Monday YYYY-MM-DD of the first week
 *  - weeks         1–4
 *  - blockPosition 0-based slot of the start week within the block (the client
 *                  sends the resolved value: detected or user-overridden)
 *  - blockLength   weeks per block, last one being recovery (default 4)
 *  - today         the viewer's local YYYY-MM-DD; days before it are skipped
 *                  (client-supplied because the server may be in another timezone)
 *  - guidance      optional free text passed through to the model
 *
 * Every failure after validation collapses to a 502, like /api/coach/generate.
 */

import { eq, and, gte, lte } from 'drizzle-orm'
import { users, plannedWorkouts, workouts } from '../../db/schema'
import { useDB } from '../../db'
import { generateCoachPlan, type AnthropicSystemBlock } from '../../utils/anthropic'
import { getMetricsSeries } from '../../utils/metricsCache'

const FALLBACK_WEIGHT_KG = 68
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const body = await readBody(event) ?? {}

  const { startDate, today } = body
  const weeks = Number(body.weeks)
  const blockLength = body.blockLength == null ? 4 : Number(body.blockLength)
  const blockPosition = Number(body.blockPosition)
  const guidance = typeof body.guidance === 'string' ? body.guidance.trim().slice(0, 500) : ''

  if (typeof startDate !== 'string' || !DATE_RE.test(startDate) || new Date(`${startDate}T00:00:00Z`).getUTCDay() !== 1) {
    throw createError({ statusCode: 400, statusMessage: 'startDate must be a Monday (YYYY-MM-DD)' })
  }
  if (typeof today !== 'string' || !DATE_RE.test(today)) {
    throw createError({ statusCode: 400, statusMessage: 'today must be YYYY-MM-DD' })
  }
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 4) {
    throw createError({ statusCode: 400, statusMessage: 'weeks must be 1–4' })
  }
  if (!Number.isInteger(blockLength) || blockLength < 2 || blockLength > 8
    || !Number.isInteger(blockPosition) || blockPosition < 0 || blockPosition >= blockLength) {
    throw createError({ statusCode: 400, statusMessage: 'invalid blockPosition/blockLength' })
  }

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

  const endDate = addDays(startDate, weeks * 7 - 1)
  const lookbackStart = addDays(startDate, -14)

  const [existing, recentPlanned, recentLogged, series] = await Promise.all([
    db.select().from(plannedWorkouts).where(and(
      eq(plannedWorkouts.userId, user.id), gte(plannedWorkouts.date, startDate), lte(plannedWorkouts.date, endDate),
    )),
    db.select().from(plannedWorkouts).where(and(
      eq(plannedWorkouts.userId, user.id), gte(plannedWorkouts.date, lookbackStart), lte(plannedWorkouts.date, addDays(startDate, -1)),
    )),
    db.select({ date: workouts.date, name: workouts.name, tss: workouts.tss, durationMinutes: workouts.durationMinutes })
      .from(workouts).where(and(
        eq(workouts.userId, user.id), gte(workouts.date, lookbackStart), lte(workouts.date, addDays(startDate, -1)),
      )),
    getMetricsSeries(user.id),
  ])

  const last = series.at(-1)
  const fmt = (r: { date: string, name: string | null, tss: number | null, durationMinutes: number | null }) =>
    `- ${r.date}: ${r.name ?? '(untitled)'}${r.tss != null ? `, ${r.tss} TSS` : ''}${r.durationMinutes != null ? `, ${r.durationMinutes} min` : ''}`

  const roles = Array.from({ length: weeks }, (_, i) => {
    const pos = (blockPosition + i) % blockLength
    const isRecovery = pos === blockLength - 1
    return `${addDays(startDate, i * 7)}: ${isRecovery ? 'Recovery' : `Build ${pos + 1}`} (${isRecovery ? 'role "recovery"' : 'role "build"'})`
  })

  const taskText = [
    `You are a cycling coach. The rider's current FTP is ${ftpWatts}W and weight is ${weightKg}kg.`
    + (last ? ` Current CTL ${Math.round(last.ctl)}, ATL ${Math.round(last.atl)}.` : ''),
    `Today is ${today}. Plan ${weeks} week(s) starting Monday ${startDate} (through ${endDate}), following the `
    + `training plan above. Blocks are ${blockLength} weeks long; the last week of a block is recovery. Week roles:\n${roles.join('\n')}`,
    'Return one entry per day for every date in range (Monday–Sunday), in order. Use type "rest" with name "Rest" '
    + 'and null tss/duration for rest days. Only include days on or after today; do not produce sessions for earlier '
    + 'dates. Keep weekly TSS consistent with the plan\'s progression for each week\'s role and the rider\'s recent load.',
    recentPlanned.length || recentLogged.length
      ? `Previous two weeks (context only):\nPlanned:\n${recentPlanned.map(fmt).join('\n') || '(none)'}\nLogged:\n${recentLogged.map(fmt).join('\n') || '(none)'}`
      : null,
    existing.length
      ? `Days in range that already have a planned workout (keep the notable ones only if the guidance asks):\n${existing.map(fmt).join('\n')}`
      : null,
    guidance ? `Rider guidance (follow it): ${guidance}` : null,
  ].filter(Boolean).join('\n\n')

  const systemBlocks: AnthropicSystemBlock[] = [
    { type: 'text', text: row.trainingPlan, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskText },
  ]

  try {
    const result = await generateCoachPlan(systemBlocks, 'Generate the plan.')

    // Drop anything out of range or in the past, whatever the model returned.
    const out = result.weeks
      .map(w => ({
        ...w,
        days: w.days.filter(d => DATE_RE.test(d.date) && d.date >= startDate && d.date <= endDate && d.date >= today),
      }))
      .filter(w => w.monday >= startDate && w.monday <= endDate)

    getLogger('coach').info('coach.plan_suggested', { requestId: event.context.requestId, startDate, weeks })
    return { weeks: out }
  }
  catch (err: unknown) {
    getLogger('coach').error('coach.plan_generation_failed', {
      requestId: event.context.requestId,
      message: (err as Error)?.message,
    })
    throw createError({ statusCode: 502, statusMessage: 'Failed to generate plan' })
  }
})
