/**
 * Shared .zwo scanning/parsing/TSS-estimation logic, used by both
 * scripts/zwift-workout-tss.ts (standalone CLI table) and the local-library
 * provider in scripts/workout-search.ts.
 *
 * Parsing and the TSS estimate live in shared/utils/zwo.ts (also used by the
 * server's sync endpoint and the Workout Builder), so a file is read the same
 * way everywhere. This module only adds the folder walk + on-disk cache.
 *
 * Results are cached in .zwift-tss-cache.json (in the scanned folder) keyed
 * by a content hash of each file, so unchanged workouts are only parsed once.
 *
 * Zone tagging: since .zwo files carry no power-zone classification of their
 * own, workouts tagged by hand (see the one-time tagging pass referenced in
 * git history) carry a `<tag name="zone:SweetSpot"/>` entry inside the
 * standard <tags> element — real Zwift-recognized XML, just with a value
 * Zwift itself doesn't assign meaning to. `parseZoneTag` reads it back out
 * for scripts/workout-search.ts's LocalZwift provider to filter on.
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { parseZwo, zoneFromTags } from '../../shared/utils/zwo.ts'
import type { ZoneName } from './zones.ts'

interface CacheEntry {
  hash: string
  name: string
  durationSec: number
  tss: number
}

type Cache = Record<string, CacheEntry>

async function loadCache(cachePath: string): Promise<Cache> {
  try {
    return JSON.parse(await readFile(cachePath, 'utf-8'))
  }
  catch {
    return {}
  }
}

async function saveCache(cachePath: string, cache: Cache): Promise<void> {
  await writeFile(cachePath, JSON.stringify(cache, null, 2))
}

async function findZwoFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await findZwoFiles(full))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zwo')) files.push(full)
  }
  return files
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function parseZoneTag(xml: string): ZoneName | null {
  const parsed = parseZwo(xml)
  return parsed.ok ? zoneFromTags(parsed.workout.meta.tags) : null
}

export interface ZwiftWorkoutResult {
  path: string
  name: string
  durationSec: number
  tss: number
  zone: ZoneName | null
}

export interface ScanZwiftWorkoutsResult {
  results: ZwiftWorkoutResult[]
  cacheHits: number
}

export async function scanZwiftWorkouts(root: string): Promise<ScanZwiftWorkoutsResult> {
  const cachePath = join(root, '.zwift-tss-cache.json')
  const files = await findZwoFiles(root)

  const cache = await loadCache(cachePath)
  const nextCache: Cache = {}
  let cacheHits = 0

  const results: ZwiftWorkoutResult[] = []

  for (const path of files) {
    const content = await readFile(path, 'utf-8')
    const hash = hashContent(content)
    const key = relative(root, path)

    const parsed = parseZwo(content)
    if (!parsed.ok) {
      console.error(`Skipping ${key}: ${parsed.error}`)
      continue
    }
    // Zone tag is cheap to re-read every time, so it's kept out of the TSS
    // cache entry rather than duplicated there.
    const zone = zoneFromTags(parsed.workout.meta.tags)

    const cached = cache[key]
    if (cached && cached.hash === hash) {
      nextCache[key] = cached
      cacheHits += 1
      results.push({ path: key, name: cached.name, durationSec: cached.durationSec, tss: cached.tss, zone })
      continue
    }

    const { durationSec, tss } = parsed.workout
    const name = parsed.workout.meta.name || key

    const entry: CacheEntry = { hash, name, durationSec, tss }
    nextCache[key] = entry
    results.push({ path: key, name, durationSec, tss, zone })
  }

  await saveCache(cachePath, nextCache)

  return { results, cacheHits }
}
