/**
 * Anthropic Messages API access for the AI coach + the structured-output
 * schema for AI-generated workouts (server/api/coach/generate.post.ts).
 *
 * This talks to `POST /v1/messages` directly with `fetch` rather than through
 * `@anthropic-ai/sdk`. The route only ever makes one kind of call — a single
 * streamed, structured-output request — so the ~1 MB SDK dependency wasn't
 * earning its place in the server bundle. What the SDK was doing for us and
 * how it's replaced here:
 *   - `client.messages.stream()` + `finalMessage()` → hand-rolled SSE parse
 *     in `streamCoachRequest` (accumulate `text_delta`s, watch `stop_reason`).
 *   - `zodOutputFormat(schema)` → the explicit `COACH_WORKOUT_JSON_SCHEMA`
 *     literal below, sent as `output_config.format`. Kept as a plain literal
 *     (not generated from the Zod schema) because the structured-output
 *     endpoint rejects several JSON Schema keywords that `z.toJSONSchema`
 *     emits (`minimum`/`maximum` on ints, `oneOf`, `$schema`); a literal is
 *     what actually goes on the wire, with no transform to drift.
 *   - automatic retries → `MAX_RETRIES` loop, retrying only transient
 *     failures and only before the first token (never a partial response).
 *   - `timeout` → an `AbortController` that bounds *time-to-first-token*
 *     (`TTFT_TIMEOUT_MS`), then a looser ceiling once tokens are flowing, so
 *     a long-but-healthy generation isn't aborted and logged as a 499.
 *
 * `CoachWorkoutSchema` still does the real validation of the response — the
 * JSON Schema constrains generation, the Zod parse is the gate.
 */

import { z } from 'zod'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MODEL = 'claude-sonnet-5'
const MAX_TOKENS = 9000

/**
 * Bounds time-to-first-token only. A slow *structured* response was tripping
 * the SDK's old 45s whole-request timeout and getting logged upstream as a
 * 499 "client disconnected"; streaming means this timer is cleared as soon
 * as the first token arrives and `OVERALL_TIMEOUT_MS` takes over.
 */
const TTFT_TIMEOUT_MS = 45_000
const OVERALL_TIMEOUT_MS = 120_000

/** Matches the old `new Anthropic({ maxRetries: 2 })` default. */
const MAX_RETRIES = 2
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 529])

/** A single `system` content block, as accepted by the Messages API. */
export interface AnthropicSystemBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

/** Raised for failures worth retrying (network blip, 5xx/429, slow start). */
class AnthropicTransientError extends Error {
  retryAfterMs?: number
  constructor(message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'AnthropicTransientError'
    this.retryAfterMs = retryAfterMs
  }
}

const RampBlockSchema = z.object({
  type: z.enum(['warmup', 'cooldown']),
  duration: z.number().int().describe('seconds'),
  powerStart: z.number().describe('fraction of FTP, e.g. 0.5 = 50% FTP'),
  powerEnd: z.number().describe('fraction of FTP'),
  cadence: z.number().int().nullable().describe('target cadence in rpm, or null if unspecified'),
})

const SteadyBlockSchema = z.object({
  type: z.literal('steady'),
  duration: z.number().int().describe('seconds'),
  power: z.number().describe('fraction of FTP'),
  cadence: z.number().int().nullable().describe('target cadence in rpm, or null if unspecified'),
})

const IntervalBlockSchema = z.object({
  type: z.literal('interval'),
  reps: z.number().int(),
  onDuration: z.number().int().describe('seconds'),
  onPower: z.number().describe('fraction of FTP'),
  onCadence: z.number().int().nullable().describe('target cadence in rpm, or null if unspecified'),
  offDuration: z.number().int().describe('seconds'),
  offPower: z.number().describe('fraction of FTP'),
  offCadence: z.number().int().nullable().describe('target cadence in rpm, or null if unspecified'),
})

export const CoachWorkoutSchema = z.object({
  name: z.string().describe('short workout title, e.g. "3x10min Sweet Spot"'),
  blocks: z.array(z.discriminatedUnion('type', [RampBlockSchema, SteadyBlockSchema, IntervalBlockSchema]))
    .describe('ordered list of workout blocks — warmup first, cooldown last'),
  fuellingGuide: z.string().describe('pre-ride, during-ride, and post-ride fuelling/hydration guidance for this specific workout, as three short paragraphs separated by blank lines (one per phase, each starting with a "Pre-ride:"/"During:"/"Post-ride:" label)'),
})

export type CoachWorkout = z.infer<typeof CoachWorkoutSchema>

/**
 * Wire schema for `output_config.format`. Must stay in sync with
 * `CoachWorkoutSchema` above — kept hand-written (see the file header for
 * why). Only the keywords the structured-output endpoint supports: types,
 * `enum`/`const`, `anyOf`, `required`, `additionalProperties: false`,
 * `description`.
 */
const cadence = {
  anyOf: [{ type: 'integer' }, { type: 'null' }],
  description: 'target cadence in rpm, or null if unspecified',
} as const

const COACH_WORKOUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'blocks', 'fuellingGuide'],
  properties: {
    name: { type: 'string', description: 'short workout title, e.g. "3x10min Sweet Spot"' },
    blocks: {
      type: 'array',
      description: 'ordered list of workout blocks — warmup first, cooldown last',
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'duration', 'powerStart', 'powerEnd', 'cadence'],
            properties: {
              type: { type: 'string', enum: ['warmup', 'cooldown'] },
              duration: { type: 'integer', description: 'seconds' },
              powerStart: { type: 'number', description: 'fraction of FTP, e.g. 0.5 = 50% FTP' },
              powerEnd: { type: 'number', description: 'fraction of FTP' },
              cadence,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'duration', 'power', 'cadence'],
            properties: {
              type: { type: 'string', const: 'steady' },
              duration: { type: 'integer', description: 'seconds' },
              power: { type: 'number', description: 'fraction of FTP' },
              cadence,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'reps', 'onDuration', 'onPower', 'onCadence', 'offDuration', 'offPower', 'offCadence'],
            properties: {
              type: { type: 'string', const: 'interval' },
              reps: { type: 'integer' },
              onDuration: { type: 'integer', description: 'seconds' },
              onPower: { type: 'number', description: 'fraction of FTP' },
              onCadence: cadence,
              offDuration: { type: 'integer', description: 'seconds' },
              offPower: { type: 'number', description: 'fraction of FTP' },
              offCadence: cadence,
            },
          },
        ],
      },
    },
    fuellingGuide: {
      type: 'string',
      description: 'pre-ride, during-ride, and post-ride fuelling/hydration guidance for this specific workout, as three short paragraphs separated by blank lines (one per phase, each starting with a "Pre-ride:"/"During:"/"Post-ride:" label)',
    },
  },
} as const

/**
 * One streamed structured-output call. Returns the validated workout, or
 * throws — `AnthropicTransientError` for something the caller may retry, a
 * plain `Error` for anything terminal (bad request, refusal, truncation,
 * schema mismatch). Never returns a partial result.
 */
async function streamCoachRequest(apiKey: string, body: string): Promise<CoachWorkout> {
  const controller = new AbortController()
  let firstTokenSeen = false
  let timer: ReturnType<typeof setTimeout> = setTimeout(
    () => controller.abort(new Error('time-to-first-token timeout')),
    TTFT_TIMEOUT_MS,
  )

  let res: Response
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body,
      signal: controller.signal,
    })
  }
  catch (err) {
    clearTimeout(timer)
    throw new AnthropicTransientError(`request failed before response: ${(err as Error).message}`)
  }

  if (!res.ok || !res.body) {
    clearTimeout(timer)
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    if (RETRYABLE_STATUS.has(res.status)) {
      throw new AnthropicTransientError(`HTTP ${res.status}: ${detail}`, parseRetryAfter(res.headers.get('retry-after')))
    }
    throw new Error(`Anthropic API error HTTP ${res.status}: ${detail}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let jsonText = ''
  let stopReason: string | null = null
  let streamError: string | null = null

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      if (!firstTokenSeen) {
        firstTokenSeen = true
        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(new Error('overall stream timeout')), OVERALL_TIMEOUT_MS)
      }

      buffer += decoder.decode(value, { stream: true })
      // SSE frames are separated by a blank line; keep the trailing partial.
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        const dataLine = frame.split('\n').find(line => line.startsWith('data:'))
        if (!dataLine) continue
        const payload = dataLine.slice('data:'.length).trim()
        if (!payload || payload === '[DONE]') continue

        let evt: {
          type?: string
          delta?: { type?: string, text?: string, stop_reason?: string }
          error?: { type?: string, message?: string }
        }
        try {
          evt = JSON.parse(payload)
        }
        catch {
          continue
        }

        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          jsonText += evt.delta.text ?? ''
        }
        else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
          stopReason = evt.delta.stop_reason
        }
        else if (evt.type === 'error') {
          streamError = evt.error?.type
            ? `${evt.error.type}: ${evt.error.message ?? ''}`
            : 'unknown stream error'
        }
      }
    }
  }
  catch (err) {
    clearTimeout(timer)
    if (!firstTokenSeen) {
      throw new AnthropicTransientError(`stream aborted before first token: ${(err as Error).message}`)
    }
    throw new Error(`coach stream failed mid-response: ${(err as Error).message}`)
  }
  clearTimeout(timer)

  if (streamError) {
    // `overloaded_error` and friends can arrive mid-stream. Retry only if
    // nothing was emitted yet — never hand back a half-built workout.
    if (!jsonText) throw new AnthropicTransientError(streamError)
    throw new Error(`coach stream reported an error: ${streamError}`)
  }
  if (stopReason === 'refusal') throw new Error('coach request was refused by the safety system')
  if (stopReason === 'max_tokens') throw new Error('coach response was truncated (hit max_tokens)')

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  }
  catch {
    throw new Error('coach response was not valid JSON')
  }

  const result = CoachWorkoutSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`coach response did not match the expected schema: ${result.error.message.slice(0, 300)}`)
  }
  return result.data
}

/**
 * Generate today's workout. `systemBlocks` is the assembled `system` prompt
 * (training plan + coach instructions, built by the route); `userText` is
 * the single user turn. Retries transient failures with backoff; a terminal
 * failure (or exhausted retries) throws.
 */
export async function generateCoachWorkout(
  systemBlocks: AnthropicSystemBlock[],
  userText: string,
): Promise<CoachWorkout> {
  const apiKey = useRuntimeConfig().anthropicApiKey
  if (!apiKey) {
    throw createError({ statusCode: 500, statusMessage: 'ANTHROPIC_API_KEY is not configured' })
  }

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    stream: true,
    system: systemBlocks,
    messages: [{ role: 'user', content: userText }],
    output_config: { format: { type: 'json_schema', schema: COACH_WORKOUT_JSON_SCHEMA } },
  })

  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = lastErr instanceof AnthropicTransientError && lastErr.retryAfterMs
        ? Math.min(lastErr.retryAfterMs, 10_000)
        : 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250)
      await new Promise(resolve => setTimeout(resolve, wait))
    }

    try {
      return await streamCoachRequest(apiKey, body)
    }
    catch (err) {
      lastErr = err
      if (err instanceof AnthropicTransientError && attempt < MAX_RETRIES) continue
      throw err
    }
  }

  throw lastErr
}

/** `Retry-After` is seconds (or an HTTP date); we only handle the seconds form. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) ? seconds * 1000 : undefined
}
