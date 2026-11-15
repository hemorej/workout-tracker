/**
 * App logging via tslog: pretty in dev, one-line JSON in production. Level is
 * read once from LOG_LEVEL (default `info`). Separate from nginx access logs.
 */

import { Logger } from 'tslog'
import * as Sentry from '@sentry/nuxt'

const levels: Record<string, number> = { silly: 0, trace: 1, debug: 2, info: 3, warn: 4, error: 5, fatal: 6 }

const root = new Logger({
  name: 'sprocket',
  type: process.env.NODE_ENV === 'production' ? 'json' : 'pretty',
  minLevel: levels[process.env.LOG_LEVEL ?? 'info'] ?? levels.info,
})

// Forward app logs to Sentry Logs. Convention is (eventName, flatAttrs), so the
// first arg becomes the message and the second the attributes. Sentry.logger is
// a no-op until the SDK is initialised (sentry.server.config.ts, needs SENTRY_DSN).
const sentryLevels = ['trace', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
root.attachTransport((logObj) => {
  const { _meta, 0: message, 1: attrs } = logObj as any
  const level = sentryLevels[_meta?.logLevelId ?? 3] ?? 'info'
  Sentry.logger[level](String(message), typeof attrs === 'object' && attrs ? attrs : undefined)
})

/**
 * Named sub-logger for one domain. Convention: `getLogger('<domain>')` per
 * module, `<domain>.<action>` event-name strings, flat primitive attributes.
 */
export function getLogger(domain: string) {
  return root.getSubLogger({ name: domain })
}
