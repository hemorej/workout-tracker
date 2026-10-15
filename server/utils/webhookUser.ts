/**
 * Resolves the single target user for secret-authed, session-less endpoints
 * (Zwift sync, and the same logic the Wahoo webhook / segments reconcile
 * inline): `NUXT_WEBHOOK_USER_EMAIL` if set, else the sole `users` row.
 * Ambiguous or empty ⇒ `null` (the caller decides how to respond).
 */

import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import type { useDB } from '../db'

export async function resolveWebhookUserId(db: ReturnType<typeof useDB>): Promise<{ userId: number | null, matched: number }> {
  const email = useRuntimeConfig().webhookUserEmail
  const rows = email
    ? await db.select({ id: users.id }).from(users)
        .where(eq(users.email, String(email).toLowerCase())).limit(1)
    : await db.select({ id: users.id }).from(users).limit(2)
  return { userId: rows.length === 1 ? rows[0]!.id : null, matched: rows.length }
}
