/**
 * Shared power-zone vocabulary, used by scripts/workout-search.ts (TrainerRoad
 * and What's on Zwift both have their own zone taxonomies that map onto this
 * one) and scripts/zwift-tag-workouts.ts (which tags local .zwo files with
 * one of these zones so workout-search.ts's local provider can filter on it).
 */

// The list itself lives in shared/utils/zwo.ts (the sync endpoint derives a
// workout's zone from the same `zone:*` tags) — re-exported here under the
// names the scripts already use.
export { ZWO_ZONE_NAMES as ZONES, type ZwoZoneName as ZoneName } from '../../shared/utils/zwo.ts'
