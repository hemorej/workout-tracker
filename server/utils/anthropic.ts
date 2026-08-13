/**
 * Anthropic API client + the structured output schema for AI-generated
 * workouts (server/api/coach/generate.post.ts).
 */

import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

let _client: Anthropic | null = null

/**
 * The SDK's default request timeout (10 min) is far too long for a call
 * blocking a UI spinner before navigation — see server/api/coach/generate.post.ts.
 */
const REQUEST_TIMEOUT_MS = 45_000

export function getAnthropicClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: useRuntimeConfig().anthropicApiKey,
      timeout: REQUEST_TIMEOUT_MS,
    })
  }
  return _client
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
  fuellingGuide: z.string().describe('pre-ride, during-ride, and post-ride fuelling/hydration guidance for this specific workout'),
})

export type CoachWorkout = z.infer<typeof CoachWorkoutSchema>
