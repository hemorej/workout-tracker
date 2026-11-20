/**
 * Training search store (Pinia) — query, scope, filters and view for the
 * Training tab's search, plus the server results.
 *
 * The state round-trips through the URL query string (`toUrlQuery` /
 * `hydrate`) so a search is shareable and survives reloads; the same keys
 * (minus `view`) are the GET /api/training/search params.
 */

import { defineStore } from 'pinia'
import type { TrainingSearchResponse } from '#shared/types/training'

export type SearchScope = 'all' | 'ridden' | 'planned'
export type SearchIo = 'all' | 'indoor' | 'outdoor'
export type SearchView = 'grid' | 'list'
export type FilterKey = 'io' | 'tss' | 'dur' | 'dist' | 'date' | 'types'

/** Slider ends: at the maximum the bound is open ("150+", "3h+"). */
export const TSS_MAX = 150
export const DURATION_MAX = 180
export const DISTANCE_MAX = 100

const SEARCH_DEBOUNCE_MS = 250

const encodeRange = (min: number | null, max: number | null) => (min == null && max == null ? '' : `${min ?? ''}-${max ?? ''}`)

function decodeRange(raw: unknown): [number | null, number | null] {
  const m = typeof raw === 'string' ? /^(\d*)-(\d*)$/.exec(raw) : null
  return [m?.[1] ? Number(m[1]) : null, m?.[2] ? Number(m[2]) : null]
}

function rangeLabel(name: string, min: number | null, max: number | null, fmt: (n: number) => string) {
  if (min != null && max != null) return `${name} ${fmt(min)} – ${fmt(max)}`
  return min != null ? `${name} ${fmt(min)}+` : `${name} ≤ ${fmt(max!)}`
}

const shortDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

export const useTrainingSearchStore = defineStore('trainingSearch', () => {
  const q = ref('')
  const scope = ref<SearchScope>('all')
  const view = ref<SearchView>('grid')
  const io = ref<SearchIo>('all')
  const tssMin = ref<number | null>(null)
  const tssMax = ref<number | null>(null)
  const durMin = ref<number | null>(null)
  const durMax = ref<number | null>(null)
  const distMin = ref<number | null>(null)
  const distMax = ref<number | null>(null)
  const dateFrom = ref('')
  const dateTo = ref('')
  const types = ref<string[]>([])

  const results = ref<TrainingSearchResponse | null>(null)
  const isSearching = ref(false)
  const error = ref<string | null>(null)

  const hasFilters = computed(() =>
    io.value !== 'all' || tssMin.value != null || tssMax.value != null || durMin.value != null || durMax.value != null || distMin.value != null || distMax.value != null
    || !!dateFrom.value || !!dateTo.value || types.value.length > 0,
  )
  /** Anything narrowing the day list: query, scope or a filter. */
  const isActive = computed(() => q.value.trim() !== '' || scope.value !== 'all' || hasFilters.value)

  /** GET /api/training/search params (only non-default values). */
  const apiQuery = computed(() => {
    const out: Record<string, string> = {}
    if (q.value.trim()) out.q = q.value.trim()
    if (scope.value !== 'all') out.scope = scope.value
    if (io.value !== 'all') out.io = io.value
    const tss = encodeRange(tssMin.value, tssMax.value)
    if (tss) out.tss = tss
    const dur = encodeRange(durMin.value, durMax.value)
    if (dur) out.dur = dur
    const dist = encodeRange(distMin.value, distMax.value)
    if (dist) out.dist = dist
    if (dateFrom.value || dateTo.value) out.date = `${dateFrom.value}..${dateTo.value}`
    if (types.value.length) out.types = types.value.join(',')
    return out
  })

  const urlQuery = computed<Record<string, string>>(() => (view.value === 'list' ? { ...apiQuery.value, view: 'list' } : apiQuery.value))

  /** Loads state from a route query (unknown / malformed values fall back to defaults). */
  function hydrate(query: Record<string, unknown>) {
    const str = (k: string) => (typeof query[k] === 'string' ? query[k] as string : '')
    q.value = str('q')
    scope.value = str('scope') === 'ridden' || str('scope') === 'planned' ? str('scope') as SearchScope : 'all'
    view.value = str('view') === 'list' ? 'list' : 'grid'
    io.value = str('io') === 'indoor' || str('io') === 'outdoor' ? str('io') as SearchIo : 'all'
    ;[tssMin.value, tssMax.value] = decodeRange(query.tss)
    ;[durMin.value, durMax.value] = decodeRange(query.dur)
    ;[distMin.value, distMax.value] = decodeRange(query.dist)
    ;[dateFrom.value = '', dateTo.value = ''] = str('date').split('..')
    types.value = str('types') ? str('types').split(',') : []
  }

  const activeFilters = computed(() => {
    const out: { key: FilterKey, label: string }[] = []
    if (io.value !== 'all') out.push({ key: 'io', label: io.value === 'indoor' ? 'Indoor' : 'Outdoor' })
    if (tssMin.value != null || tssMax.value != null) out.push({ key: 'tss', label: rangeLabel('TSS', tssMin.value, tssMax.value, String) })
    if (durMin.value != null || durMax.value != null) out.push({ key: 'dur', label: rangeLabel('Duration', durMin.value, durMax.value, formatMinutes) })
    if (distMin.value != null || distMax.value != null) out.push({ key: 'dist', label: rangeLabel('Distance', distMin.value, distMax.value, n => `${n} km`) })
    if (dateFrom.value || dateTo.value) {
      const label = dateFrom.value && dateTo.value
        ? `${shortDate(dateFrom.value)} – ${shortDate(dateTo.value)}`
        : dateFrom.value ? `From ${shortDate(dateFrom.value)}` : `Until ${shortDate(dateTo.value)}`
      out.push({ key: 'date', label })
    }
    if (types.value.length) out.push({ key: 'types', label: types.value.map(zoneLabel).join(', ') })
    return out
  })

  function clearFilter(key: FilterKey) {
    if (key === 'io') io.value = 'all'
    else if (key === 'tss') tssMin.value = tssMax.value = null
    else if (key === 'dur') durMin.value = durMax.value = null
    else if (key === 'dist') distMin.value = distMax.value = null
    else if (key === 'date') dateFrom.value = dateTo.value = ''
    else types.value = []
  }

  function clearAll() {
    q.value = ''
    scope.value = 'all'
    io.value = 'all'
    for (const k of ['tss', 'dur', 'dist', 'date', 'types'] as const) clearFilter(k)
  }

  // ── Results ────────────────────────────────────────────────────────────────

  let requestSeq = 0

  async function run() {
    if (import.meta.server) return
    if (!isActive.value) {
      results.value = null
      return
    }
    const seq = ++requestSeq
    isSearching.value = true
    error.value = null
    try {
      const data = await $fetch<TrainingSearchResponse>('/api/training/search', { query: apiQuery.value })
      if (seq === requestSeq) results.value = data
    }
    catch {
      if (seq === requestSeq) error.value = 'Search failed. Try again.'
    }
    finally {
      if (seq === requestSeq) isSearching.value = false
    }
  }

  // Any change to the effective params re-runs the search (debounced, last one wins).
  let debounce: ReturnType<typeof setTimeout> | undefined
  const runSoon = () => {
    clearTimeout(debounce)
    debounce = setTimeout(run, SEARCH_DEBOUNCE_MS)
  }
  watch(apiQuery, runSoon)

  return {
    q, scope, view, io, tssMin, tssMax, durMin, durMax, distMin, distMax, dateFrom, dateTo, types,
    results, isSearching, error, isActive, hasFilters, urlQuery, activeFilters,
    hydrate, clearFilter, clearAll, runSoon,
  }
})
