/**
 * Scans a folder of Zwift .zwo workout files, estimates each workout's
 * duration and TSS, and prints a table sorted by TSS ascending.
 *
 * Parsing/TSS-estimation logic lives in scripts/lib/zwift-workouts.ts,
 * shared with the local-library provider in scripts/workout-search.ts.
 *
 * Usage:
 *   node --experimental-strip-types scripts/zwift-workout-tss.ts [folder]
 *
 * Defaults to ~/Documents/Zwift/Workouts if no folder is given.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { scanZwiftWorkouts } from './lib/zwift-workouts.ts'

const ROOT = process.argv[2] ?? join(homedir(), 'Documents/Zwift/Workouts')

// ── Terminal colour (raw ANSI, no dependency) ────────────────────────────

const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR

function ansi(code: string, s: string): string {
  return colorEnabled ? `\x1b[${code}m${s}\x1b[0m` : s
}

const headerColor = (s: string) => ansi('1;36', s) // bold cyan
const rowColorA = (s: string) => ansi('37', s) // white
const rowColorB = (s: string) => ansi('90', s) // grey

function fmtDuration(totalSec: number): string {
  const s = Math.round(totalSec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m`
}

async function main() {
  const { results, cacheHits } = await scanZwiftWorkouts(ROOT)
  if (results.length === 0) {
    console.error(`No .zwo files found under ${ROOT}`)
    process.exit(1)
  }

  results.sort((a, b) => a.tss - b.tss)

  const nameWidth = Math.max(4, ...results.map(r => r.name.length))
  const durWidth = Math.max(8, ...results.map(r => fmtDuration(r.durationSec).length))

  console.log(headerColor(`${'Workout'.padEnd(nameWidth)}  ${'Duration'.padEnd(durWidth)}  TSS`))
  console.log(headerColor(`${'-'.repeat(nameWidth)}  ${'-'.repeat(durWidth)}  ---`))
  results.forEach((r, i) => {
    const color = i % 2 === 0 ? rowColorA : rowColorB
    console.log(color(`${r.name.padEnd(nameWidth)}  ${fmtDuration(r.durationSec).padEnd(durWidth)}  ${r.tss}`))
  })

  console.log(`\n${results.length} workout(s) — ${cacheHits} from cache, ${results.length - cacheHits} (re)computed.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
