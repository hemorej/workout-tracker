/**
 * Shared FTP lookup for anything that needs to compute TSS from a parsed FIT
 * file (Wahoo activity fetch, manual FIT upload) — both want "the most
 * recently logged workout's FTP, or the fixed fallback if none has ever been
 * logged" (see CLAUDE.md's fixed-FTP plan-generation note).
 */

import { desc, isNotNull, eq, and } from 'drizzle-orm'
import { workouts } from '../db/schema'
import { useDB } from '../db'

const FALLBACK_FTP = 230

export async function getCurrentFtpWatts(userId: number): Promise<number> {
  const db = useDB()

  const [mostRecentFtp] = await db
    .select({ ftpWatts: workouts.ftpWatts })
    .from(workouts)
    .where(and(eq(workouts.userId, userId), isNotNull(workouts.ftpWatts)))
    .orderBy(desc(workouts.date))
    .limit(1)

  return mostRecentFtp?.ftpWatts ?? FALLBACK_FTP
}
