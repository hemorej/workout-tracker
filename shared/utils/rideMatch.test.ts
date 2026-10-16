/**
 * Run with: pnpm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickStravaRide, type RideCandidate } from './rideMatch.ts'

const ride = (date: string, rideType: 'trainer' | 'outdoor', movingTimeSeconds: number, id = 0): RideCandidate & { id: number } =>
  ({ id, startDateLocal: `${date}T07:00:00Z`, movingTimeSeconds, rideType })

test('never falls back to a ride from another day', () => {
  const rides = [ride('2026-10-14', 'outdoor', 3600, 1)]
  assert.equal(pickStravaRide(rides, { rideDate: '2026-10-15' }), null)
})

test('filters by ride type when known', () => {
  const rides = [ride('2026-10-15', 'outdoor', 3600, 1), ride('2026-10-15', 'trainer', 3600, 2)]
  assert.equal(pickStravaRide(rides, { rideDate: '2026-10-15', rideType: 'trainer' })?.id, 2)
})

test('type mismatch on the same day is no match', () => {
  const rides = [ride('2026-10-15', 'outdoor', 3600, 1)]
  assert.equal(pickStravaRide(rides, { rideDate: '2026-10-15', rideType: 'trainer' }), null)
})

test('disambiguates same-day rides by closest duration', () => {
  const rides = [ride('2026-10-15', 'outdoor', 1800, 1), ride('2026-10-15', 'outdoor', 5400, 2)]
  assert.equal(pickStravaRide(rides, { rideDate: '2026-10-15', durationSeconds: 5300 })?.id, 2)
})

test('without a duration, the first (newest) same-day ride wins', () => {
  const rides = [ride('2026-10-15', 'outdoor', 1800, 1), ride('2026-10-15', 'outdoor', 5400, 2)]
  assert.equal(pickStravaRide(rides, { rideDate: '2026-10-15' })?.id, 1)
})
