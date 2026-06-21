/**
 * POST /api/auth/register
 *
 * Creates a new user account.
 *
 * Returns:
 *   201 { user: { id, email, username } }
 *   400 if required fields are missing or validation fails
 *   409 if the email or username is already taken
 */

import { eq, or } from 'drizzle-orm'
import { users } from '../../db/schema'
import { useDB } from '../../db'
import { hashPassword } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)

  // Basic presence validation
  if (!body?.email || !body?.password || !body?.username) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Email, username and password are required.',
    })
  }

  // Password length check
  if (body.password.length < 8) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Password must be at least 8 characters.',
    })
  }

  const email = (body.email as string).toLowerCase().trim()
  const username = (body.username as string).trim()

  const db = useDB()

  // Check for existing user with the same email or username
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(or(eq(users.email, email), eq(users.username, username)))
    .limit(1)

  if (existing) {
    throw createError({
      statusCode: 409,
      statusMessage: 'An account with that email or username already exists.',
    })
  }

  // Hash password before storing
  const passwordHash = await hashPassword(body.password)

  // Insert new user
  const [newUser] = await db
    .insert(users)
    .values({ email, username, passwordHash })
    .returning({ id: users.id, email: users.email, username: users.username })

  // Automatically log the user in after registration
  await setUserSession(event, {
    user: { id: newUser!.id, email: newUser!.email, username: newUser!.username },
  })

  setResponseStatus(event, 201)
  return { user: newUser }
})
