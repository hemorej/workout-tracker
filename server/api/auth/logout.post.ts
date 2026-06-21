/**
 * POST /api/auth/logout
 *
 * Clears the user's session cookie, effectively logging them out.
 * Always returns 200 (idempotent — logging out when already logged out is fine).
 */

export default defineEventHandler(async (event) => {
  await clearUserSession(event)
  return { ok: true }
})
