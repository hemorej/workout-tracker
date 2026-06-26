/**
 * POST /api/auth/login
 *
 * Authenticates a user with email + password.
 * On success, writes an encrypted session cookie via nuxt-auth-utils
 * so subsequent requests are recognised as that user.
 *
 * Returns:
 *   200 { user: { id, email, username } }
 *   400 if body is missing required fields
 *   401 if credentials are invalid
 */

import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import { useDB } from '../../db'

export default defineEventHandler(async (event) => {
  // Parse and validate request body
  const body = await readBody(event)

  if (!body?.email || !body?.password) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Email and password are required.',
    })
  }

  const db = useDB()

  // Look up user by email
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, body.email.toLowerCase().trim()))
    .limit(1)

  // Compare password — always run scrypt even if user not found to
  // prevent timing attacks that reveal whether an email is registered.
  const passwordMatch = user
    ? await verifyPassword(user.passwordHash, body.password)
    : await verifyPassword('$scrypt$n=16384,r=8,p=1$invalidsaltfortimingprotection$invalidhashfortimingprotection', body.password)

  if (!user || !passwordMatch) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Invalid email or password.',
    })
  }

  // Persist session — nuxt-auth-utils encrypts this into a cookie
  await setUserSession(event, {
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
    },
  })

  // Return the public user object (never return passwordHash)
  return {
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
    },
  }
})
