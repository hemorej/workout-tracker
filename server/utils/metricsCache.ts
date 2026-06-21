/**
 * Server-side in-memory cache for the computed CTL/ATL/TSB metrics series.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The metrics series (CTL, ATL, TSB for every day) is fully deterministic:
 * given the same workout history it always produces the same output. There is
 * no need to recompute from scratch on every GET request — the values only
 * change when a workout is created or deleted.
 *
 * This module caches the full DayMetrics array per user and invalidates it
 * whenever the underlying workout data changes.
 *
 * ── How invalidation works ───────────────────────────────────────────────────
 *
 *   • GET /api/workouts  → check cache first; compute & store on miss
 *   • POST /api/workouts → invalidate after write (next GET recomputes)
 *   • DELETE /api/workouts/:id → invalidate after delete
 *
 * A short TTL (5 minutes) is also applied as a safety net so the series
 * rolls forward across midnight even if a mutation event is missed.
 *
 * ── Limitations ─────────────────────────────────────────────────────────────
 *
 * This cache is in-process only — it is lost on server restart and is NOT
 * shared across multiple Nitro worker instances. For a single-process dev
 * server this is perfectly fine.
 *
 * For a multi-instance production deployment, replace the Map with a shared
 * store such as Redis (via Nitro's `useStorage` driver) or store a single
 * checkpoint row in the database (date + ctl + atl) and only recompute
 * forward from there.
 */

import type { DayMetrics } from './tss'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry {
  /** Full day-by-day series from first workout to endDate */
  series: DayMetrics[]
  /** ISO date string of the last day included in this series ("YYYY-MM-DD") */
  endDate: string
  /** Unix timestamp (ms) when this entry was stored — used for TTL */
  storedAt: number
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Module-level singleton.
 * Lives for the entire lifetime of the Nitro server process.
 */
const _store = new Map<number, CacheEntry>()

/**
 * Maximum age of a cache entry before it is considered stale.
 * This is a safety net — explicit invalidation on writes is the primary
 * mechanism. 5 minutes ensures the series stays current across midnight
 * even without a write event.
 */
const TTL_MS = 5 * 60 * 1_000

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the cached series for a user, or null if:
 *   - no entry exists for this user, OR
 *   - the entry is older than TTL_MS, OR
 *   - the entry's endDate is before today (series needs extending to today)
 *
 * Returning null signals the caller to run a full recompute.
 */
export function getCachedMetrics(userId: number): DayMetrics[] | null {
  const entry = _store.get(userId)
  if (!entry) return null

  // Stale by time
  if (Date.now() - entry.storedAt > TTL_MS) {
    _store.delete(userId)
    return null
  }

  // Stale by date — the series was computed on a previous day and does not
  // include today's rest day yet. Invalidate so the next request recomputes
  // with the current date as the endpoint.
  const today = new Date().toISOString().slice(0, 10)
  if (entry.endDate < today) {
    _store.delete(userId)
    return null
  }

  return entry.series
}

/**
 * Stores the computed series for a user.
 * Call this after every full recompute so subsequent reads can skip the work.
 *
 * @param userId  - the authenticated user's ID
 * @param series  - the full DayMetrics array returned by computeMetricsSeries()
 */
export function setCachedMetrics(userId: number, series: DayMetrics[]): void {
  const endDate = series.at(-1)?.date ?? new Date().toISOString().slice(0, 10)
  _store.set(userId, { series, endDate, storedAt: Date.now() })
}

/**
 * Removes the cached series for a user.
 *
 * Call this immediately after any write (create / delete workout) so that the
 * next GET request triggers a fresh computation with the updated data.
 *
 * @param userId - the authenticated user's ID
 */
export function invalidateMetrics(userId: number): void {
  _store.delete(userId)
}
