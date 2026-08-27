/**
 * Nitro plugin (the hook-based equivalent of Express middleware): tags every
 * request with a `requestId` (UUID) + start time, then emits one
 * `http.request` summary line per `/api/*` request — level by status class.
 * The `error` hook covers thrown handlers, where `afterResponse` doesn't fire.
 */

import type { H3Event } from 'h3'

export default defineNitroPlugin((nitroApp) => {
  const log = getLogger('http')

  /** Emit the one-line summary for a finished `/api/*` request. */
  function logRequest(event: H3Event, status: number) {
    const path = event.path.split('?')[0]!
    if (!path.startsWith('/api/')) return

    const durationMs = Date.now() - (event.context.requestStartedAt ?? Date.now())
    const attrs = { requestId: event.context.requestId, method: event.method, path, status, durationMs }

    if (status >= 500) log.error('http.request', attrs)
    else if (status >= 400) log.warn('http.request', attrs)
    else log.info('http.request', attrs)
  }

  nitroApp.hooks.hook('request', (event) => {
    event.context.requestId = crypto.randomUUID()
    event.context.requestStartedAt = Date.now()
  })

  // Handler completed normally.
  nitroApp.hooks.hook('afterResponse', (event) => {
    logRequest(event, event.node.res.statusCode)
  })

  // Handler threw (createError etc.) — afterResponse does not fire in this case,
  // so the summary line has to be logged from here instead.
  nitroApp.hooks.hook('error', (error: any, { event }) => {
    if (!event) return
    logRequest(event, error?.statusCode ?? 500)
  })
})
