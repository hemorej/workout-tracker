/**
 * Run with: pnpm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJsonExactIds } from './exactIds.ts'

const TEXT = '[{"id":3526248433932148868,"segment":{"id":616309},"activity":{"id":19851421433,"id_str":"19851421433"}}]'

test('keeps ids past 2^53 exact as digit strings', () => {
  const [effort] = parseJsonExactIds(TEXT) as { id: unknown }[]
  assert.equal(effort!.id, '3526248433932148868')
  // sanity: a plain parse really does lose the last digits
  const [lossy] = JSON.parse(TEXT) as { id: number }[]
  assert.notEqual(String(BigInt(lossy!.id)), '3526248433932148868')
})

test('leaves safe integer ids as numbers', () => {
  const [effort] = parseJsonExactIds(TEXT) as { segment: { id: unknown }, activity: { id: unknown } }[]
  assert.equal(effort!.segment.id, 616309)
  assert.equal(effort!.activity.id, 19851421433)
})

test('only touches fields named id', () => {
  const parsed = parseJsonExactIds('{"id":1,"elapsed":9007199254740993,"id_str":"x"}') as Record<string, unknown>
  assert.equal(parsed.id, 1)
  assert.equal(typeof parsed.elapsed, 'number')
  assert.equal(parsed.id_str, 'x')
})
