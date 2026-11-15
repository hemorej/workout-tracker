import * as Sentry from '@sentry/nuxt'

const dsn = useRuntimeConfig().public.sentry?.dsn

// No DSN (dev, CI, forks) ⇒ SDK never initialises and nothing is sent.
if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.2,
    // Sentry v11 collects cookies, headers, bodies and user info by default;
    // this app handles session cookies, bearer/webhook tokens and health data.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
  })
}
