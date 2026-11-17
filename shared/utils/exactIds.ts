/**
 * JSON.parse that keeps oversized integer `id` fields exact.
 *
 * Strava segment-effort ids are 64-bit (~3.5e18, past Number.MAX_SAFE_INTEGER)
 * and, unlike activity/athlete ids, come with no `id_str`. A plain JSON.parse
 * rounds them to the nearest double (spacing 512 at that size), so distinct
 * efforts can collapse onto one id. The reviver's `context.source` (Node 21+)
 * is the literal digits from the response text; any `id` that isn't a safe
 * integer is returned as that digit string instead of a rounded number.
 * Safe ids stay numbers, so e.g. segment/activity ids are unaffected.
 *
 * Erasable TS only, no imports (runs under --experimental-strip-types).
 */
export function parseJsonExactIds(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (
      key === 'id'
      && typeof value === 'number'
      && !Number.isSafeInteger(value)
      && context?.source !== undefined
      && /^-?\d+$/.test(context.source)
    ) {
      return context.source
    }
    return value
  })
}
