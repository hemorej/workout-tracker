/**
 * Run with: pnpm test
 * (node's built-in runner under --experimental-strip-types — no test dependency.)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseZwo,
  serializeZwo,
  zwoCanonicalString,
  normalizeZwoPath,
  zoneFromTags,
  ZWO_LIMITS,
  type ZwoWorkout,
} from './zwo.ts'

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment -->
<workout_file>
  <author>Someone &amp; Co</author>
  <name>Over/Unders &quot;Hard&quot;</name>
  <description><![CDATA[Line one <b>bold</b>]]></description>
  <sportType>bike</sportType>
  <category>Threshold</category>
  <tags>
    <tag name="zone:SweetSpot"/>
    <tag name="outdoor"/>
  </tags>
  <workout>
    <Warmup Duration="600" PowerLow="0.4" PowerHigh="0.75" Cadence="90"/>
    <SteadyState Duration="300" Power="0.65"/>
    <IntervalsT Repeat="4" OnDuration="240" OffDuration="120" OnPower="1.05" OffPower="0.55" Cadence="95">
      <textevent timeoffset="0" message="Go &amp; hold it"/>
    </IntervalsT>
    <FreeRide Duration="300" FlatRoad="1"/>
    <Cooldown Duration="300" PowerLow="0.7" PowerHigh="0.4"/>
  </workout>
</workout_file>`

function parseOk(xml: string): ZwoWorkout {
  const r = parseZwo(xml)
  assert.ok(r.ok, r.ok ? '' : r.error)
  return r.workout
}

test('parses meta, blocks, text events and totals', () => {
  const w = parseOk(SAMPLE)
  assert.equal(w.meta.author, 'Someone & Co')
  assert.equal(w.meta.name, 'Over/Unders "Hard"')
  assert.equal(w.meta.description, 'Line one <b>bold</b>')
  assert.deepEqual(w.meta.tags, ['zone:SweetSpot', 'outdoor'])
  assert.deepEqual(w.meta.extraMeta, { category: 'Threshold' })
  assert.equal(w.blocks.length, 5)
  assert.equal(w.editable, true)
  assert.equal(w.durationSec, 600 + 300 + 4 * 360 + 300 + 300)

  const interval = w.blocks[2]!
  assert.equal(interval.type, 'interval')
  assert.equal(interval.textEvents?.[0]?.attrs.message, 'Go & hold it')
  assert.equal(w.blocks[3]!.type, 'freeride')
  assert.equal(zoneFromTags(w.meta.tags), 'SweetSpot')
  assert.ok(w.tss > 0)
})

test('serialize → parse is idempotent after the first pass and keeps meta + text events', () => {
  const first = parseOk(SAMPLE)
  const xml1 = serializeZwo(first.meta, first.blocks)
  const second = parseOk(xml1)
  const xml2 = serializeZwo(second.meta, second.blocks)

  assert.equal(xml2, xml1)
  assert.equal(zwoCanonicalString(second), zwoCanonicalString(first))
  assert.deepEqual(second.meta.tags, first.meta.tags)
  assert.equal(second.meta.description, first.meta.description)
  assert.equal(second.blocks[2]!.textEvents?.[0]?.attrs.message, 'Go & hold it')
})

test('canonical string ignores formatting but not content', () => {
  const a = parseOk(SAMPLE)
  const reformatted = parseOk(SAMPLE.replace(/>\s+</g, '><'))
  assert.equal(zwoCanonicalString(a), zwoCanonicalString(reformatted))

  const changed = parseOk(SAMPLE.replace('Duration="300" Power="0.65"', 'Duration="310" Power="0.65"'))
  assert.notEqual(zwoCanonicalString(a), zwoCanonicalString(changed))
})

test('interval cadence: one-sided cadence is completed on serialize', () => {
  const w = parseOk(SAMPLE)
  const out = serializeZwo(w.meta, w.blocks)
  assert.match(out, /Cadence="95" CadenceResting="85"/)
})

test('unsupported content makes the file non-editable but still previewable', () => {
  const w = parseOk(SAMPLE.replace('<SteadyState Duration="300" Power="0.65"/>', '<SteadyState Duration="300" Power="0.65" pace="1"/><MaxEffort Duration="30"/>'))
  assert.equal(w.editable, false)
  assert.equal(w.unsupported.length, 2)
  // The pace block is still parsed (stats stay right); the unknown MaxEffort is dropped.
  assert.equal(w.blocks.length, 5)
})

test("Zwift's own pace=\"0\" attribute is a no-op", () => {
  const w = parseOk('<workout_file><name>r</name><workout><SteadyState Duration="60" Power="0.5" pace="0"/></workout></workout_file>')
  assert.equal(w.editable, true)
  assert.equal(w.blocks.length, 1)
})

test('Ramp is classified by direction', () => {
  const w = parseOk('<workout_file><name>r</name><workout><Ramp Duration="60" PowerLow="0.5" PowerHigh="0.9"/><Ramp Duration="60" PowerLow="0.9" PowerHigh="0.5"/></workout></workout_file>')
  assert.deepEqual(w.blocks.map(b => b.type), ['warmup', 'cooldown'])
})

test('hostile / malformed input is an error, never a throw', () => {
  const bad = [
    '',
    'not xml',
    '<workout_file>',
    '<workout_file></workout_file>',
    '<other/>',
    '<!DOCTYPE x [<!ENTITY a "b">]><workout_file><workout/></workout_file>',
    `<workout_file><workout><IntervalsT Repeat="999999999" OnDuration="1" OffDuration="1" OnPower="1" OffPower="1"/></workout></workout_file>`,
    `<workout_file><workout><SteadyState Duration="999999" Power="1"/></workout></workout_file>`,
    '<workout_file><workout><SteadyState Duration="1" Power="1"></workout></workout_file>',
    `<workout_file>${'<a>'.repeat(50)}</workout_file>`,
    'x'.repeat(ZWO_LIMITS.maxXmlLength + 1),
    '<workout_file><!-- unclosed',
  ]
  for (const xml of bad) {
    const r = parseZwo(xml)
    assert.equal(r.ok, false, `expected failure for: ${xml.slice(0, 60)}`)
  }
})

test('parse stays fast on adversarial whitespace / tag soup', () => {
  const started = Date.now()
  parseZwo(`<workout_file><workout>${'<SteadyState Duration="1" Power="1"' + ' '.repeat(100_000)}`)
  parseZwo(`<workout_file>${'<x '.repeat(80_000)}`)
  parseZwo(`<workout_file><workout>${'<SteadyState Duration="1" Power="1"/>'.repeat(5000)}</workout></workout_file>`)
  assert.ok(Date.now() - started < 2000, 'parser too slow on adversarial input')
})

test('path validation', () => {
  assert.equal(normalizeZwoPath('123456/Foo Bar.zwo'), '123456/Foo Bar.zwo')
  assert.equal(normalizeZwoPath('Foo.ZWO'), 'Foo.ZWO')
  for (const p of ['', '/abs.zwo', '../x.zwo', 'a/../b.zwo', 'a//b.zwo', 'a\\b.zwo', 'a.txt', 'a\u0000.zwo', 'a/./b.zwo', 5, null]) {
    assert.equal(normalizeZwoPath(p), null, String(p))
  }
  assert.equal(normalizeZwoPath(`${'a'.repeat(300)}.zwo`), null)
})
