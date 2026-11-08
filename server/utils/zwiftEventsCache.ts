/**
 * In-process TTL cache for the "today's Zwift events" data (climb portals +
 * races). Both upstream calls are unauthenticated and free of side effects,
 * but there's no reason to refetch on every dialog open — a short TTL keeps
 * the dialog snappy without ever going too stale, same tradeoff as
 * `metricsCache.ts`.
 *
 * Not shared across Nitro worker instances — fine for this app's
 * single-process deployment (see metricsCache.ts for the same note).
 */

interface CacheEntry {
  value: unknown
  expiresAt: number
}

const _store = new Map<string, CacheEntry>()

const DEFAULT_TTL_MS = 10 * 60 * 1_000

export function getCachedZwiftData(key: string): unknown | null {
  const entry = _store.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    _store.delete(key)
    return null
  }
  return entry.value
}

/** `ttlMs` overrides the 10-min default (e.g. the per-day climb result). */
export function setCachedZwiftData(key: string, value: unknown, ttlMs = DEFAULT_TTL_MS): void {
  const now = Date.now()
  // Per-day keys would otherwise pile up forever — sweep expired entries on write.
  for (const [k, e] of _store) if (now > e.expiresAt) _store.delete(k)
  _store.set(key, { value, expiresAt: now + ttlMs })
}
