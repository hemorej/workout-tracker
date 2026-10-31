import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findNewBestEfforts, topDistinctWatts } from './powerBestRules.ts'

const e = (date: string, watts: number, duration = '5sec') => ({ date, watts, duration })

test('PR must be strictly higher than the 8-week max', () => {
  const existing = [e('2026-09-20', 300)]
  assert.deepEqual(findNewBestEfforts(existing, '2026-10-01', [{ duration: '5sec', watts: 300 }]), [])
  assert.equal(findNewBestEfforts(existing, '2026-10-01', [{ duration: '5sec', watts: 301 }]).length, 1)
})

test('efforts older than 8 weeks do not count as the baseline', () => {
  const existing = [e('2026-06-01', 900)]
  assert.equal(findNewBestEfforts(existing, '2026-10-01', [{ duration: '5sec', watts: 300 }]).length, 1)
})

test('no data in the window: any value is a PR', () => {
  assert.equal(findNewBestEfforts([], '2026-10-01', [{ duration: '1h', watts: 150 }]).length, 1)
})

test('rides on or after the ride date are ignored', () => {
  const existing = [e('2026-10-01', 900), e('2026-10-05', 900)]
  assert.equal(findNewBestEfforts(existing, '2026-10-01', [{ duration: '5sec', watts: 300 }]).length, 1)
})

test('durations are independent', () => {
  const existing = [e('2026-09-20', 300, '5sec')]
  assert.equal(findNewBestEfforts(existing, '2026-10-01', [{ duration: '1min', watts: 100 }]).length, 1)
})

test('topDistinctWatts skips ties and takes the next highest', () => {
  assert.deepEqual(topDistinctWatts([300, 300, 290, 290, 280, 270]), [300, 290, 280])
})
