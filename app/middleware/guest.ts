/**
 * Route middleware: guest
 *
 * Redirects already-authenticated users away from guest-only pages (login).
 * Apply with: definePageMeta({ middleware: 'guest' })
 */

export default defineNuxtRouteMiddleware(() => {
  const { loggedIn } = useUserSession()

  if (loggedIn.value) {
    return navigateTo('/')
  }
})
