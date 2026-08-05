/**
 * Searches multiple public workout libraries (TrainerRoad, What's on Zwift)
 * with precise numeric filters (duration range, TSS/stress-points range,
 * power zone) and prints a single merged, sorted table.
 *
 * Each source is a `Provider` — a small object exposing a `search(criteria)`
 * function that returns `NormalizedWorkout[]`. Adding a new source means
 * writing one more provider and pushing it into `PROVIDERS`; nothing else
 * in the script needs to change.
 *
 * ── TrainerRoad ───────────────────────────────────────────────────────────
 * Reverse-engineered from a HAR capture of POST
 * https://www.trainerroad.com/app/workouts/list -> app/api/workouts.
 * That endpoint's own duration/zone filters are bucketed checkboxes, but
 * every workout it returns carries exact `tss`, `duration` (minutes) and
 * `powerZones` fields — so this provider requests broadly (sorted by tss
 * ascending) and does the precise filtering client-side, stopping as soon
 * as results pass the requested TSS ceiling.
 *
 * Auth is cookie-based (SharedTrainerRoadAuth, a persistent but not
 * permanent login cookie). The cookie is cached in
 * scripts/.trainerroad-session (gitignored) so it's not refetched every
 * run. When a request comes back non-JSON (logged out / cookie expired),
 * the provider logs back in automatically using credentials cached in
 * scripts/.trainerroad-credentials (also gitignored, prompted for once).
 *
 * The login flow itself (reverse-engineered from a HAR of the real login
 * form) is: GET /app/login to pick up the antiforgery + tracking cookies
 * the server seeds, then POST /app/api/login/login with those cookies and
 * a JSON {username, password, returnUrl} body, which responds with
 * Set-Cookie: SharedTrainerRoadAuth=... on success.
 *
 * ── What's on Zwift ──────────────────────────────────────────────────────
 * No auth needed — GET https://whatsonzwift.com/search with query params
 * (dmin/dmax, spmin/spmax, z, sort, etc.) that map directly onto its own
 * search form. The response is a full HTML page, not JSON, so this
 * provider scrapes each result `<section>` for name, duration, and stress
 * points, and follows the "Page X of Y" footer to walk all result pages.
 * WoZ's zone taxonomy (z1-z6) doesn't have a Sprint or SweetSpot bucket, so
 * those two TrainerRoad zones are approximated with their nearest WoZ
 * neighbor (Sprint -> Anaerobic, SweetSpot -> Threshold).
 *
 * Usage:
 *   pnpm workout-search
 */

import { readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

// ── Terminal colour (raw ANSI, no dependency) ────────────────────────────

const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR

function ansi(code: string, s: string): string {
  return colorEnabled ? `\x1b[${code}m${s}\x1b[0m` : s
}

const headerColor = (s: string) => ansi('1;36', s) // bold cyan
const rowColorA = (s: string) => ansi('37', s) // white
const rowColorB = (s: string) => ansi('90', s) // grey

const rl = createInterface({ input: process.stdin, output: process.stdout })

async function ask(prompt: string): Promise<string> {
  return (await rl.question(prompt)).trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Shared search criteria + result shape ────────────────────────────────

const ZONES = ['Anaerobic', 'Endurance', 'Sprint', 'SweetSpot', 'Tempo', 'Threshold', 'VO2Max'] as const
type ZoneName = typeof ZONES[number]

interface Criteria {
  zone: ZoneName | null
  minDuration: number // minutes, 0 = no floor
  maxDuration: number // minutes, Infinity = no ceiling
  tssMin?: number
  tssMax?: number
}

interface NormalizedWorkout {
  source: string
  name: string
  zone: string
  profile: string
  duration: number // minutes
  tss: number
  url?: string
}

interface Provider {
  name: string
  search: (criteria: Criteria) => Promise<NormalizedWorkout[]>
}

// ── TrainerRoad provider ──────────────────────────────────────────────────

const TR_SESSION_PATH = fileURLToPath(new URL('.trainerroad-session', import.meta.url))
const TR_CREDENTIALS_PATH = fileURLToPath(new URL('.trainerroad-credentials', import.meta.url))
const TR_API_URL = 'https://www.trainerroad.com/app/api/workouts'
const TR_LOGIN_SEED_URL = 'https://www.trainerroad.com/app/login'
const TR_LOGIN_URL = 'https://www.trainerroad.com/app/api/login/login'

// Each zone's workout profiles (subcategories), from TrainerRoad's own filter menu.
const TR_ZONE_PROFILES: Record<ZoneName, string[]> = {
  Anaerobic: ['Attacks', 'Intervals', 'Mixed Intervals', 'On-Offs', 'Steps'],
  Endurance: ['Sustained Power', 'With Bursts'],
  Sprint: ['Attacks', 'Max Efforts'],
  SweetSpot: ['Hard Starts', 'Intervals', 'Mixed Intervals', 'Over-Unders', 'Sustained Power', 'With Bursts'],
  Tempo: ['Intervals', 'Sustained Power'],
  Threshold: ['Hard Starts', 'Intervals', 'Long Suprathreshold', 'Mixed Intervals', 'Over-Unders', 'Ramps', 'Sustained Power', 'With Bursts'],
  VO2Max: ['Attacks', 'Float Sets', 'Intervals', 'Long Suprathreshold', 'Mixed Intervals', 'On-Offs', 'Over-Unders', 'Ramps', 'Traditional'],
}

interface TrWorkout {
  id: number
  workoutName: string
  duration: number
  tss: number
  powerZones: string[]
  profileName: string
  workoutDifficultyRating: number
}

interface TrWorkoutsResponse {
  workoutsCacheUnavailable: boolean
  predicate: { totalCount: number }
  workouts: TrWorkout[]
}

interface TrCredentials { username: string, password: string }

async function trLoadCookie(): Promise<string | null> {
  try {
    return (await readFile(TR_SESSION_PATH, 'utf-8')).trim() || null
  }
  catch {
    return null
  }
}

async function trSaveCookie(cookie: string): Promise<void> {
  await writeFile(TR_SESSION_PATH, cookie, { mode: 0o600 })
}

async function trLoadCredentials(): Promise<TrCredentials | null> {
  try {
    return JSON.parse(await readFile(TR_CREDENTIALS_PATH, 'utf-8'))
  }
  catch {
    return null
  }
}

async function trSaveCredentials(creds: TrCredentials): Promise<void> {
  await writeFile(TR_CREDENTIALS_PATH, JSON.stringify(creds), { mode: 0o600 })
}

async function trPromptForCredentials(): Promise<TrCredentials> {
  console.log('\nTrainerRoad login (cached locally in scripts/.trainerroad-credentials, gitignored, plaintext — visible as you type):')
  const username = await ask('Username/email: ')
  const password = await ask('Password: ')
  const creds = { username, password }
  await trSaveCredentials(creds)
  return creds
}

function trParseSetCookies(res: Response): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(';', 1)[0]!
    const eq = pair.indexOf('=')
    if (eq > -1) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }
  return cookies
}

function trCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
}

async function trLogin(creds: TrCredentials): Promise<string> {
  const seedRes = await fetch(TR_LOGIN_SEED_URL)
  const seedCookies = trParseSetCookies(seedRes)

  const loginRes = await fetch(TR_LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'TrainerRoad-JsonFormat': 'camel-case',
      'TrainerRoad-AppVersion': '18771',
      'Origin': 'https://www.trainerroad.com',
      'Referer': 'https://www.trainerroad.com/app/login?ReturnUrl=%2Fapp%2Fworkouts%2Flist',
      'Cookie': trCookieHeader(seedCookies),
    },
    body: JSON.stringify({ username: creds.username, password: creds.password, returnUrl: '/app/workouts/list' }),
  })

  const loginCookies = trParseSetCookies(loginRes)
  const body = await loginRes.json().catch(() => null) as { success?: boolean } | null

  if (!loginRes.ok || !body?.success) {
    throw new Error(`TrainerRoad login failed (HTTP ${loginRes.status}). Check your username/password.`)
  }

  const cookie = trCookieHeader({ ...seedCookies, ...loginCookies })
  await trSaveCookie(cookie)
  return cookie
}

async function trGetCookie(): Promise<string> {
  const cached = await trLoadCookie()
  if (cached) return cached
  const creds = await trLoadCredentials() ?? await trPromptForCredentials()
  return await trLogin(creds)
}

async function trRelogin(): Promise<string> {
  const creds = await trLoadCredentials() ?? await trPromptForCredentials()
  return await trLogin(creds)
}

function trBuildRequestBody(pageNumber: number, pageSize: number) {
  return {
    pageNumber,
    pageSize,
    isDescending: false,
    sortProperty: 'tss',
    allProfiles: { profileIds: [] },
    custom: { yup: false, nope: false, memberAccessId: 0 },
    durations: {
      lessThanFortyFive: false,
      fortyFive: false,
      oneHour: false,
      oneHourFifteen: false,
      oneHourThirty: false,
      oneHourFortyFive: false,
      twoHours: false,
      twoHoursFifteen: false,
      twoHoursThirty: false,
      moreThanTwoHoursThirty: false,
    },
    favorite: { yup: false, nope: false, favoriteWorkoutIds: [] },
    progressions: { profileIds: [], progressionIds: [], progressionLevels: [], adaptiveTrainingVersion: 1000, workoutTypeIds: [] },
    restrictToTeams: false,
    teamIds: [],
    teamOptions: [],
    workoutDifficultyRatings: { productive: false, stretch: false, breakthrough: false, notRecommended: false, achievable: false, recovery: false, adaptiveTrainingVersion: 1000 },
    workoutInstructions: { yup: false, nope: false },
    workoutLabels: { workoutLabelIds: [] },
    workoutTags: { workoutTagIds: [] },
    workoutTypes: { raceSimulation: false, standard: false, test: false, video: false, warmup: false, outside: false },
    zoneOptions: [],
    searchText: '',
  }
}

async function trFetchPage(cookie: string, pageNumber: number, pageSize: number): Promise<TrWorkoutsResponse | 'auth-failed'> {
  const res = await fetch(TR_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'TrainerRoad-JsonFormat': 'camel-case',
      'TrainerRoad-AppVersion': '18746',
      'Origin': 'https://www.trainerroad.com',
      'Referer': 'https://www.trainerroad.com/app/workouts/list',
      'Cookie': cookie,
    },
    body: JSON.stringify(trBuildRequestBody(pageNumber, pageSize)),
  })

  const contentType = res.headers.get('content-type') ?? ''
  if (!res.ok || !contentType.includes('application/json')) {
    return 'auth-failed'
  }

  return await res.json() as TrWorkoutsResponse
}

const trainerRoadProvider: Provider = {
  name: 'TrainerRoad',
  async search(criteria) {
    const zone = criteria.zone
    // A specific zone implies its full set of subcategories (matches TrainerRoad's
    // own filter menu, where picking a zone checks all of its subcategory boxes).
    const profiles = zone ? TR_ZONE_PROFILES[zone] : null

    const tssMin = criteria.tssMin ?? -Infinity
    const tssMax = criteria.tssMax ?? Infinity

    let cookie = await trGetCookie()

    const PAGE_SIZE = 100
    const HARD_SAFETY_CAP = 500 // pages; ~50,000 workouts, just to prevent a runaway loop
    const matches: NormalizedWorkout[] = []
    let totalCount = 0
    let stoppedAtCap = false

    for (let page = 0; page < HARD_SAFETY_CAP; page++) {
      let result = await trFetchPage(cookie, page, PAGE_SIZE)

      if (result === 'auth-failed') {
        console.log('\nTrainerRoad session cookie looks expired or invalid — logging in again...')
        cookie = await trRelogin()
        result = await trFetchPage(cookie, page, PAGE_SIZE)
        if (result === 'auth-failed') {
          throw new Error('TrainerRoad login still failing after re-login attempt.')
        }
      }

      if (result.workouts.length === 0) break
      totalCount = result.predicate.totalCount ?? totalCount

      for (const w of result.workouts) {
        if (w.tss >= tssMin && w.tss <= tssMax
          && w.duration >= criteria.minDuration && w.duration <= criteria.maxDuration
          && (!zone || w.powerZones.some(z => z.toLowerCase() === zone.toLowerCase()))
          && (!profiles || profiles.some(p => p.toLowerCase() === (w.profileName ?? '').toLowerCase()))) {
          matches.push({
            source: 'TrainerRoad',
            name: w.workoutName ?? '',
            zone: w.powerZones[0] ?? '',
            profile: w.profileName ?? '',
            duration: w.duration,
            tss: w.tss,
          })
        }
      }

      // Results are sorted by tss ascending — once every workout on this page
      // is past our ceiling, later pages can only be further past it too.
      if (result.workouts.every(w => w.tss > tssMax)) break
      if ((page + 1) * PAGE_SIZE >= totalCount) break
      if (page === HARD_SAFETY_CAP - 1) stoppedAtCap = true
    }

    if (stoppedAtCap) {
      console.log(`[warning] TrainerRoad: hit the ${HARD_SAFETY_CAP}-page safety cap before exhausting the catalog or passing the TSS ceiling — results may be incomplete.`)
    }

    return matches
  },
}

// ── What's on Zwift provider ─────────────────────────────────────────────

const WOZ_SEARCH_URL = 'https://whatsonzwift.com/search'
const WOZ_USER_AGENT = 'Mozilla/5.0 (compatible; sprocket-workout-search/1.0; personal training tracker)'

// WoZ's zone taxonomy (z1-z6) has no Sprint or SweetSpot bucket, so those two
// TrainerRoad zones are approximated with their nearest WoZ neighbor: Sprint
// (all-out, short) rounds up to Anaerobic capacity, and SweetSpot (just below
// threshold) rounds up to Threshold.
const TR_TO_WOZ_ZONE: Record<ZoneName, string> = {
  Anaerobic: 'z6',
  Endurance: 'z2',
  Sprint: 'z6',
  SweetSpot: 'z4',
  Tempo: 'z3',
  Threshold: 'z4',
  VO2Max: 'z5',
}

function wozBuildUrl(criteria: Criteria, page: number): string {
  const params = new URLSearchParams({
    sport: 'bike',
    d: 'all',
    sp: 'all',
    l: 'all',
    z: (criteria.zone && TR_TO_WOZ_ZONE[criteria.zone]) || 'all',
    k: '',
    s: 'sp-asc',
    'o[zc]': '1',
    'o[zw]': '1',
    'o[zf]': '1',
    'o[c]': '1',
    a: 'on',
    dmin: Number.isFinite(criteria.minDuration) && criteria.minDuration > 0 ? String(criteria.minDuration) : '',
    dmax: Number.isFinite(criteria.maxDuration) ? String(criteria.maxDuration) : '',
    spmin: criteria.tssMin !== undefined ? String(criteria.tssMin) : '',
    spmax: criteria.tssMax !== undefined ? String(criteria.tssMax) : '',
  })
  if (page > 1) params.set('page', String(page))
  return `${WOZ_SEARCH_URL}?${params.toString()}`
}

function wozDecodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&raquo;/g, '»')
    .replace(/&laquo;/g, '«')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

function wozStripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function wozParseDurationToMinutes(text: string): number {
  const hr = text.match(/(\d+)\s*hr/)
  const min = text.match(/(\d+)\s*min/)
  const sec = text.match(/(\d+)\s*sec/)
  let minutes = 0
  if (hr) minutes += Number(hr[1]) * 60
  if (min) minutes += Number(min[1])
  if (sec) minutes += Number(sec[1]) / 60
  return Math.round(minutes)
}

function wozParseResultsPage(html: string): NormalizedWorkout[] {
  const results: NormalizedWorkout[] = []
  const sectionRegex = /<section class="relative flex flex-wrap items-center border-b border-ccc pt-6 pb-6">([\s\S]*?)<\/section>/g

  for (const sectionMatch of html.matchAll(sectionRegex)) {
    const chunk = sectionMatch[1]!

    const nameMatch = chunk.match(/<strong>([\s\S]*?)<\/strong>/)
    const durationMatch = chunk.match(/Duration:\s*([^<]+)/)
    const tssMatch = chunk.match(/Stress points:\s*(\d+)/)
    const urlMatch = chunk.match(/href="(https:\/\/whatsonzwift\.com\/workouts\/[^"]+)"/)

    if (!nameMatch || !durationMatch || !tssMatch) continue

    const name = wozDecodeEntities(wozStripTags(nameMatch[1]!))
      .split('»')
      .map(part => part.trim())
      .filter(Boolean)
      .join(' » ')

    results.push({
      source: 'WhatsOnZwift',
      name,
      zone: '',
      profile: '',
      duration: wozParseDurationToMinutes(durationMatch[1]!),
      tss: Number(tssMatch[1]),
      url: urlMatch?.[1],
    })
  }

  return results
}

const whatsOnZwiftProvider: Provider = {
  name: 'WhatsOnZwift',
  async search(criteria) {
    const PAGE_DELAY_MS = 300
    const HARD_SAFETY_CAP = 20 // pages
    const results: NormalizedWorkout[] = []
    let page = 1
    let totalPages = 1

    do {
      const res = await fetch(wozBuildUrl(criteria, page), {
        headers: { 'User-Agent': WOZ_USER_AGENT },
      })
      if (!res.ok) {
        throw new Error(`WhatsOnZwift search failed (HTTP ${res.status}).`)
      }
      const html = await res.text()

      if (page === 1) {
        const pagingMatch = html.match(/Page \d+ of (\d+)/)
        if (pagingMatch) totalPages = Number(pagingMatch[1])
      }

      results.push(...wozParseResultsPage(html))

      page++
      if (page <= totalPages && page <= HARD_SAFETY_CAP) await sleep(PAGE_DELAY_MS)
    } while (page <= totalPages && page <= HARD_SAFETY_CAP)

    if (page > HARD_SAFETY_CAP && page <= totalPages) {
      console.log(`[warning] WhatsOnZwift: hit the ${HARD_SAFETY_CAP}-page safety cap before reaching the last page — results may be incomplete.`)
    }

    return results
  },
}

const PROVIDERS: Provider[] = [trainerRoadProvider, whatsOnZwiftProvider]

// ── CLI ────────────────────────────────────────────────────────────────

function printResults(results: NormalizedWorkout[]): void {
  if (results.length === 0) {
    console.log('\nNo workouts matched.')
    return
  }

  const sorted = [...results].sort((a, b) => a.tss - b.tss || a.name.localeCompare(b.name))

  const nameWidth = Math.max(4, ...sorted.map(w => w.name.length))
  const sourceWidth = Math.max(6, ...sorted.map(w => w.source.length))
  console.log(headerColor(`\n${'Workout'.padEnd(nameWidth)}  ${'Source'.padEnd(sourceWidth)}  Zone         Profile              Dur   TSS`))
  console.log(headerColor(`${'-'.repeat(nameWidth)}  ${'-'.repeat(sourceWidth)}  -----------  -------------------  ----  ---`))
  sorted.forEach((w, i) => {
    const color = i % 2 === 0 ? rowColorA : rowColorB
    console.log(color(
      `${w.name.padEnd(nameWidth)}  ${w.source.padEnd(sourceWidth)}  ${w.zone.padEnd(11)}  ${w.profile.padEnd(19)}  ${String(w.duration).padStart(3)}m  ${w.tss}`,
    ))
  })
  console.log(`\n${sorted.length} match(es).`)
}

async function main() {
  console.log('\nZone:')
  ZONES.forEach((z, i) => console.log(`  ${i + 1}) ${z}`))
  console.log('  (blank = any)')
  const zoneChoice = await ask('> ')
  const zoneIndex = Number(zoneChoice) - 1
  const zone = zoneChoice && zoneIndex >= 0 && zoneIndex < ZONES.length ? ZONES[zoneIndex]! : null

  const durationStr = await ask('Duration (minutes, blank = no filter): ')
  const durationParts = durationStr.split(',').map(s => Number(s.trim())).filter(n => !Number.isNaN(n))
  const minDuration = durationParts.length > 0 ? durationParts[0]! : 0
  const maxDuration = durationParts.length > 1 ? durationParts[1]! : Infinity

  const tssMinStr = await ask('TSS (minimum, blank = no filter): ')
  const tssMin = tssMinStr ? Number(tssMinStr) : undefined
  const tssMax = tssMin !== undefined ? tssMin + 4 : undefined

  console.log('\nSources:')
  PROVIDERS.forEach((p, i) => console.log(`  ${i + 1}) ${p.name}`))
  console.log('  (blank = all)')
  const sourceChoice = await ask('> ')
  const chosenIndices = sourceChoice
    ? sourceChoice.split(',').map(s => Number(s.trim()) - 1).filter(i => i >= 0 && i < PROVIDERS.length)
    : PROVIDERS.map((_, i) => i)
  const providers = chosenIndices.length > 0 ? chosenIndices.map(i => PROVIDERS[i]!) : PROVIDERS

  rl.close()

  const criteria: Criteria = { zone, minDuration, maxDuration, tssMin, tssMax }

  console.log('\nSearching...')

  const outcomes = await Promise.allSettled(providers.map(provider => provider.search(criteria)))

  const results: NormalizedWorkout[] = []
  outcomes.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      results.push(...outcome.value)
    }
    else {
      const err = outcome.reason
      console.error(`\n[${providers[i]!.name}] ${err instanceof Error ? err.message : err}`)
    }
  })

  printResults(results)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
