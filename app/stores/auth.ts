/**
 * Auth store (Pinia)
 *
 * Wraps nuxt-auth-utils session data in a Pinia store so any component
 * can read the current user and trigger login / logout without prop-drilling.
 *
 * nuxt-auth-utils already handles the session cookie — this store is a thin
 * reactive layer on top of it that also owns the API call logic.
 */

import { defineStore } from 'pinia'

// Shape of the user object stored in the session
interface SessionUser {
  id: number
  email: string
  username: string
}

export const useAuthStore = defineStore('auth', () => {
  // nuxt-auth-utils composable — reactive session state
  const { user: sessionUser, loggedIn, clear: clearSession, fetch: fetchSession } = useUserSession()

  // Expose the user as a typed computed ref
  const user = computed<SessionUser | null>(() => sessionUser.value as SessionUser | null)

  /**
   * Sends login credentials to the server, then refreshes the session
   * so `loggedIn` and `user` update reactively.
   *
   * Throws if the server returns an error (e.g. 401 invalid credentials).
   */
  async function login(email: string, password: string) {
    await $fetch('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    })
    // Refresh session state from the new cookie
    await fetchSession()
  }

  /**
   * Sends registration data to the server.
   * The server automatically logs the user in upon success.
   */
  async function register(email: string, username: string, password: string) {
    await $fetch('/api/auth/register', {
      method: 'POST',
      body: { email, username, password },
    })
    await fetchSession()
  }

  /**
   * Clears the session cookie server-side then wipes local state.
   * Navigates to /login after logout.
   */
  async function logout() {
    await $fetch('/api/auth/logout', { method: 'POST' })
    await clearSession()
    await navigateTo('/login')
  }

  return {
    user,
    loggedIn,
    login,
    register,
    logout,
  }
})
