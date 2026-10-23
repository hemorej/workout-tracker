/**
 * Auth + limits for POST /api/zwift/activity — the endpoint the local
 * Zwift-activities daemon (scripts/zwift-activities.ts) uploads finished
 * rides to. PUBLIC (no session), authenticated only by
 * `NUXT_ZWIFT_ACTIVITY_TOKEN` as a Bearer header — a DIFFERENT secret from
 * the workout-library sync token, because this one can create workouts.
 */

import { secretMatches } from './wahooWebhook'

const log = getLogger('zwift')

export const ZWIFT_ACTIVITY_LIMITS = {
  /** A 4 h ride is ~1.2 MB; leave generous headroom. nginx must allow it too (infra/nginx.conf). */
  maxBodyBytes: 8_000_000,
} as const

/** First thing the handler does — before any body read, DB or parse work. Unset token ⇒ always 401. */
export function requireZwiftActivityToken(event: Parameters<typeof getHeader>[0]) {
  const expected = useRuntimeConfig().zwiftActivityToken as string | undefined
  const provided = getHeader(event, 'authorization')?.replace(/^Bearer\s+/i, '')
  if (!secretMatches(provided, expected)) {
    log.warn('zwift.activity_unauthorized', { requestId: event.context.requestId })
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized.' })
  }
}
