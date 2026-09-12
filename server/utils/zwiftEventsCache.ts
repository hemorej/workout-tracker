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
  storedAt: number
}

const _store = new Map<string, CacheEntry>()

const TTL_MS = 10 * 60 * 1_000

export function getCachedZwiftData(key: string): unknown | null {
  const entry = _store.get(key)
  if (!entry) return null
  if (Date.now() - entry.storedAt > TTL_MS) {
    _store.delete(key)
    return null
  }
  return entry.value
}

export function setCachedZwiftData(key: string, value: unknown): void {
  _store.set(key, { value, storedAt: Date.now() })
}
