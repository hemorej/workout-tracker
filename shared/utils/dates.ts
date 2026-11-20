/** Calendar-date helpers for YYYY-MM-DD strings (shared by the Training tab and its API). */

/** `date` shifted by `days` calendar days. */
export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The Monday of `date`'s week. */
export function mondayOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
  return addDaysIso(date, dow === 0 ? -6 : 1 - dow)
}

/** Today in the runtime's local calendar (browser on the client, server TZ in the API). */
export function localDateIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
