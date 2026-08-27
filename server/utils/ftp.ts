/**
 * Shared FTP lookups. `workouts.ftp_watts` is a *sparse marker* column — a
 * row carries a value only on the day the athlete's FTP changed to it (see
 * HistoryTab's "FTP updated to X" markers), so the effective FTP on any given
 * day is the most recent marker on or before that day.
 *
 * - `getCurrentFtpWatts` — the latest marker overall (what a freshly recorded
 *   ride should use; also the AI coach's fixed-FTP input, see CLAUDE.md).
 * - `getFtpAsOf` — the marker in effect on a specific date, for parsing
 *   historical rides against the FTP that actually applied then.
 *
 * Both fall back to the earliest recorded marker for dates that predate it,
 * then to the fixed 230 if the athlete has never logged an FTP at all.
 */

import { desc, asc, isNotNull, eq, and, lte } from 'drizzle-orm'
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

export async function getFtpAsOf(userId: number, date: string): Promise<number> {
  const db = useDB()

  const [onOrBefore] = await db
    .select({ ftpWatts: workouts.ftpWatts })
    .from(workouts)
    .where(and(eq(workouts.userId, userId), isNotNull(workouts.ftpWatts), lte(workouts.date, date)))
    .orderBy(desc(workouts.date))
    .limit(1)
  if (onOrBefore?.ftpWatts != null) return onOrBefore.ftpWatts

  // Date predates the first marker — carry the earliest known value backward.
  const [earliest] = await db
    .select({ ftpWatts: workouts.ftpWatts })
    .from(workouts)
    .where(and(eq(workouts.userId, userId), isNotNull(workouts.ftpWatts)))
    .orderBy(asc(workouts.date))
    .limit(1)

  return earliest?.ftpWatts ?? FALLBACK_FTP
}
