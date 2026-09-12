/**
 * "Today's Zwift events" data for the Planning tab dialog: the Climb Portal
 * rotation and any nearby TT/crit races.
 *
 * Neither Zwift nor a third party publishes a documented, credential-free
 * API for either of these, so both functions here talk to undocumented
 * sources that could change or disappear without notice:
 *
 *   - Which climbs are active today comes from zwiftinsider.com's Climb
 *     Portal Schedule calendar (`https://zwiftinsider.com/climb-portal-schedule/`)
 *     — its Spiffy Calendar widget tags every day cell with all three
 *     rotations (Climb of the Month, Climb of the Week, and the daily
 *     Watopia climb). whatsonzwift.com's homepage only ever surfaces the
 *     month+daily pair, silently missing the weekly one — confirmed live by
 *     comparing both against the in-game "Climb of the Week" card.
 *   - Distance/elevation/gradient for each climb comes from
 *     `https://whatsonzwift.com/climb-portals`, the full climb list (plain
 *     server-rendered HTML, not client-side rendered), joined to the names
 *     from the Insider calendar.
 *   - Races come from https://us-or-rly101.zwift.com/api/public/events/upcoming,
 *     the same backend Zwift's own apps call. It happens to be reachable
 *     without authentication and returns clean JSON, but it is not a
 *     published/supported API.
 *
 * All three are read-only, low-value targets (no user data, no side
 * effects), so a parse/shape failure degrades that half of the dialog
 * rather than throwing — see the try/catch in each function.
 *
 * ── "Today" means the caller's calendar day, not the server's ─────────────
 *
 * `fetchClimbPortalSchedule` takes `todayStr` ("YYYY-MM-DD") rather than
 * computing "today" from the server's own clock/timezone: this app's
 * production server (Forge) and the viewer are not guaranteed to share a
 * timezone, and the climb rotation is genuinely a per-calendar-day fact.
 * Callers pass the browser's local date (see `TodaysEventsDialog.vue`),
 * matching the `todayStr` convention already used client-side in
 * `[[tab]].vue`.
 *
 * `fetchTodaysRaceEvents` takes no date — see its doc comment for why a
 * calendar-day filter doesn't apply cleanly there.
 *
 * Upstream fetches are cached raw (10 min, see zwiftEventsCache.ts) and
 * filtered/joined fresh per call — caching a *filtered* climb result per
 * date would either need per-day cache keys or risk serving yesterday's
 * climb for a few minutes after midnight.
 */

import { getCachedZwiftData, setCachedZwiftData } from './zwiftEventsCache'

// ---------------------------------------------------------------------------
// Climb portals
// ---------------------------------------------------------------------------

export interface ClimbPortalEntry {
  portal: string
  name: string
  slug: string
  distanceKm: number
  elevationM: number
  gradientPercent: number
}

/**
 * Spiffy Calendar category IDs from zwiftinsider.com's climb-portal-schedule
 * legend. 364/365/363 are just alternating colors used to keep adjacent
 * days visually distinct in the calendar — all three mean "the daily
 * Watopia climb", confirmed against the legend's "Climb Portal - Blue/Dark
 * Blue/Light Blue" labels.
 */
const CATEGORY_PORTAL_LABELS: Record<number, string> = {
  366: 'Climb of the Month',
  370: 'Climb of the Week',
  364: 'Featured Daily Climb',
  365: 'Featured Daily Climb',
  363: 'Featured Daily Climb',
}

/** Decodes the small set of numeric HTML entities these pages use in `data-*` attributes (e.g. `&#x20;`, `&#x28;`). */
function decodeHtmlEntities(s: string): string {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/**
 * Case- and diacritic-insensitive key for joining a climb name across the two
 * sources: zwiftinsider.com spells some names with accents (e.g. "Bealach na
 * Bà") that whatsonzwift.com spells without them ("Bealach na Ba") — a plain
 * `.toLowerCase()` match silently drops that climb.
 */
function normalizeClimbName(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

interface TodaysClimbName {
  portal: string
  name: string
}

/**
 * Finds today's active climbs (name + portal only, no stats) from the
 * Insider calendar's day cell for `todayStr`'s day-of-month. The page
 * always renders the current month, so this assumes the calendar's "today"
 * and the caller's `todayStr` fall in the same month — true except right at
 * a month boundary, an acceptable edge case for this feature.
 */
function parseTodaysClimbNames(html: string, todayStr: string): TodaysClimbName[] {
  const day = Number(todayStr.split('-')[2])
  const dayCellMatch = html.match(new RegExp(`spiffy-day-${day}[ "][\\s\\S]*?</td>`))
  if (!dayCellMatch) return []
  const cellHtml = dayCellMatch[0]

  const eventPattern = /class="calnk category_(\d+)[^"]*"[\s\S]*?class="spiffy-title">([^<]+)<\/span>/g
  const results: TodaysClimbName[] = []
  for (const m of cellHtml.matchAll(eventPattern)) {
    const portal = CATEGORY_PORTAL_LABELS[Number(m[1])]
    if (!portal) continue
    // Weekly climb titles carry an XP suffix, e.g. "Cote de Trebiac (250 XP)".
    const name = m[2]!.replace(/\s*\(\d+\s*XP\)\s*$/i, '').trim()
    results.push({ portal, name })
  }
  return results
}

interface ClimbStats {
  distanceKm: number
  elevationM: number
  gradientPercent: number
  slug: string
}

/**
 * Builds a name → stats lookup from whatsonzwift.com's full climb list.
 * Each climb is an `<li data-name="...">...</li>` card; stats are pulled
 * from the same ruler/trending-up icon + "(N%)" markup as the homepage's
 * "currently active" cards. The big decorative elevation-profile chart SVGs
 * are stripped first so they don't get caught in the `[\s\S]*?` spans below.
 */
function parseClimbStatsByName(html: string): Map<string, ClimbStats> {
  const cleaned = html.replace(/<svg[^>]*class="ElevationProfileSvgPlot"[\s\S]*?<\/svg>/g, '')

  const cardPattern = /<li[^>]*data-name="([^"]+)"[\s\S]*?<\/li>/g
  const statsByName = new Map<string, ClimbStats>()
  for (const m of cleaned.matchAll(cardPattern)) {
    const name = decodeHtmlEntities(m[1]!).trim()
    const cardHtml = m[0]

    const distMatch = cardHtml.match(/lucide-ruler[\s\S]*?<\/svg><\/i>([\d.]+)\s*km/)
    const elevMatch = cardHtml.match(/lucide-trending-up[\s\S]*?<\/svg><\/i>(-?[\d,]+)\s*m/)
    const gradeMatch = cardHtml.match(/\((-?[\d.]+)%\)/)
    const slugMatch = cardHtml.match(/climb-portal\/([a-z0-9-]+)/)
    if (!distMatch || !elevMatch || !gradeMatch || !slugMatch) continue

    statsByName.set(normalizeClimbName(name), {
      distanceKm: Number.parseFloat(distMatch[1]!),
      elevationM: Number.parseInt(elevMatch[1]!.replace(/,/g, ''), 10),
      gradientPercent: Number.parseFloat(gradeMatch[1]!),
      slug: slugMatch[1]!,
    })
  }
  return statsByName
}

/** Fetches `url` as text, using the 10-min raw-HTML cache under `cacheKey`. Returns null and logs a warning on failure. */
async function fetchCachedHtml(cacheKey: string, url: string): Promise<string | null> {
  const cached = getCachedZwiftData(cacheKey)
  if (cached) return cached as string

  try {
    const html = await $fetch<string>(url, { responseType: 'text' })
    setCachedZwiftData(cacheKey, html)
    return html
  }
  catch (err: unknown) {
    const e = err as Record<string, any>
    getLogger('zwift').warn('zwift.html_fetch_failed', { url, status: e?.status ?? e?.response?.status })
    return null
  }
}

/**
 * Fetches today's active Climb Portal climbs (Climb of the Month, Climb of
 * the Week, and the daily Watopia climb) with their stats, for the given
 * caller-local date.
 */
export async function fetchClimbPortalSchedule(todayStr: string): Promise<ClimbPortalEntry[]> {
  const [scheduleHtml, statsHtml] = await Promise.all([
    fetchCachedHtml('zi-climb-schedule', 'https://zwiftinsider.com/climb-portal-schedule/'),
    fetchCachedHtml('woz-climb-stats', 'https://whatsonzwift.com/climb-portals'),
  ])
  if (!scheduleHtml || !statsHtml) return []

  const todaysClimbs = parseTodaysClimbNames(scheduleHtml, todayStr)
  const statsByName = parseClimbStatsByName(statsHtml)

  const entries: ClimbPortalEntry[] = []
  for (const climb of todaysClimbs) {
    const stats = statsByName.get(normalizeClimbName(climb.name))
    if (!stats) {
      getLogger('zwift').warn('zwift.climb_stats_not_found', { name: climb.name })
      continue
    }
    entries.push({ portal: climb.portal, name: climb.name, ...stats })
  }
  return entries
}

// ---------------------------------------------------------------------------
// Races (TT / crit)
// ---------------------------------------------------------------------------

export interface RaceEventEntry {
  id: number
  name: string
  type: 'TT' | 'CRIT'
  eventStart: string
  laps: number
  distanceKm: number | null
}

interface ZwiftUpcomingEvent {
  id: number
  name: string
  eventType: string
  eventStart: string
  laps: number
  distanceInMeters: number
}

const CRIT_NAME_PATTERN = /crit/i

/**
 * Fetches upcoming Time Trial and crit-flavored Race events.
 *
 * Deliberately does NOT filter to "today" by calendar day: the upstream
 * `/upcoming` feed only ever covers roughly the next 15 hours to begin with
 * (confirmed live), which already matches what a viewer wants from "today's
 * events" — and bucketing races into calendar days would require knowing
 * the viewer's IANA timezone (not just a date string) to get right around
 * local midnight, which this endpoint doesn't have. `eventStart` is
 * returned as a UTC ISO string and rendered client-side with
 * `toLocaleTimeString`, which correctly uses the browser's own timezone —
 * see `raceTimeLabel` in TodaysEventsDialog.vue.
 */
export async function fetchTodaysRaceEvents(): Promise<RaceEventEntry[]> {
  let events = getCachedZwiftData('races-raw') as ZwiftUpcomingEvent[] | null
  if (!events) {
    try {
      events = await $fetch<ZwiftUpcomingEvent[]>('https://us-or-rly101.zwift.com/api/public/events/upcoming')
      setCachedZwiftData('races-raw', events)
    }
    catch (err: unknown) {
      const e = err as Record<string, any>
      getLogger('zwift').warn('zwift.events_fetch_failed', { status: e?.status ?? e?.response?.status })
      return []
    }
  }

  const entries: RaceEventEntry[] = events
    .filter((e) => e.eventType === 'TIME_TRIAL' || (e.eventType === 'RACE' && CRIT_NAME_PATTERN.test(e.name)))
    .map((e) => ({
      id: e.id,
      name: e.name.trim(),
      type: (e.eventType === 'TIME_TRIAL' ? 'TT' : 'CRIT') as 'TT' | 'CRIT',
      eventStart: e.eventStart,
      laps: e.laps,
      distanceKm: e.distanceInMeters > 0 ? e.distanceInMeters / 1000 : null,
    }))
    .sort((a, b) => a.eventStart.localeCompare(b.eventStart))

  return entries
}
