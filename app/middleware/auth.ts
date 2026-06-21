/**
 * Route middleware: auth
 *
 * Redirects unauthenticated users to /login.
 * Apply this middleware to any page that requires a logged-in session.
 *
 * Usage in a page component:
 * ```ts
 * definePageMeta({ middleware: 'auth' })
 * ```
 *
 * How it works:
 * - `useUserSession()` is provided by nuxt-auth-utils.
 * - `loggedIn` is a computed boolean derived from the session cookie.
 * - If the user is not logged in, we redirect to /login before the page renders.
 */

export default defineNuxtRouteMiddleware(() => {
  const { loggedIn } = useUserSession()

  if (!loggedIn.value) {
    return navigateTo('/login')
  }
})
