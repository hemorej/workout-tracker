/**
 * POST /api/auth/register
 *
 * Registration is disabled. Accounts must be created directly in the DB.
 */

export default defineEventHandler(async () => {
  throw createError({ statusCode: 403, statusMessage: 'Account registration is currently closed.' })
})
