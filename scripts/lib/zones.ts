/**
 * Shared power-zone vocabulary, used by scripts/workout-search.ts (TrainerRoad
 * and What's on Zwift both have their own zone taxonomies that map onto this
 * one) and scripts/zwift-tag-workouts.ts (which tags local .zwo files with
 * one of these zones so workout-search.ts's local provider can filter on it).
 */

// Ordered low-to-high by roughly how much power each zone targets, not alphabetically.
export const ZONES = ['Endurance', 'Tempo', 'SweetSpot', 'Threshold', 'VO2Max', 'Anaerobic', 'Sprint'] as const
export type ZoneName = typeof ZONES[number]
