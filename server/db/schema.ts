/**
 * Drizzle ORM schema definitions.
 *
 * Two tables:
 *   - users     — stores login credentials (email, username, hashed password)
 *   - workouts  — one workout entry per user per calendar day
 *
 * Relationships:
 *   workouts.userId → users.id  (cascade delete: removing a user also removes their workouts)
 */

import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  real,
  date,
  timestamp,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'

export const POWER_BEST_DURATIONS = [
  '5sec', '15sec', '30sec', '1min', '2min', '3min', '5min',
  '8min', '10min', '15min', '20min', '30min', '45min', '1h',
] as const

export type PowerBestDuration = typeof POWER_BEST_DURATIONS[number]

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  /** Auto-incrementing primary key */
  id: serial('id').primaryKey(),

  /** Unique email address used for login */
  email: text('email').unique().notNull(),

  /** Display name / username (also unique) */
  username: text('username').unique().notNull(),

  /** hash of the user's password — never store plaintext */
  passwordHash: text('password_hash').notNull(),

  /**
   * Chronic Training Load (fitness) on the day BEFORE the user's first
   * logged workout. Used to seed the rolling average so it starts from a
   * realistic baseline rather than zero.
   *
   * Update via: UPDATE users SET initial_ctl = 44 WHERE email = 'you@example.com';
   */
  initialCtl: integer('initial_ctl').default(0).notNull(),

  /**
   * Acute Training Load (fatigue) on the day before the first workout.
   * Defaults to the same value as initialCtl (assumes neutral form / TSB ≈ 0).
   *
   * Override only if you know your actual fatigue level at that point.
   */
  initialAtl: integer('initial_atl').default(0).notNull(),

  /** Row creation timestamp (UTC) */
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// workouts
// ---------------------------------------------------------------------------

export const workouts = pgTable(
  'workouts',
  {
    /** Auto-incrementing primary key */
    id: serial('id').primaryKey(),

    /** Foreign key referencing the owning user */
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),

    /**
     * The calendar date of the workout (stored as DATE, no time component).
     * Combined with userId in a unique index so each user can only log
     * one workout per day.
     */
    date: date('date').notNull(),

    /** Short descriptive name for the workout, e.g. "Morning Run" */
    name: text('name').notNull(),

    /** Duration of the workout in minutes (must be > 0) */
    durationMinutes: integer('duration_minutes').notNull(),

    /** Distance covered in kilometres (optional — null for older rows logged before this field existed) */
    distanceKm: real('distance_km'),

    /**
     * Training Stress Score — a composite measure of workout load.
     * Must be a non-negative integer.
     */
    tss: integer('tss').notNull(),

    /**
     * Rate of Perceived Exertion (optional).
     * Constrained to 1–10 by a CHECK constraint.
     */
    rpe: integer('rpe'),

    /** Optional free-text notes about the workout */
    notes: text('notes'),

    /** FTP (Functional Threshold Power) in watts recorded during this workout, if updated */
    ftpWatts: integer('ftp_watts'),

    /**
     * Indoor/trainer (Zwift, etc.) vs outdoor ride. Optional — null for rows
     * logged before this field existed, until backfilled from Strava
     * (Strava's `type: 'VirtualRide'` vs `'Ride'`).
     */
    rideType: text('ride_type'),

    /** Row creation timestamp (UTC) */
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    /**
     * Enforces one workout per user per day at the database level.
     * Attempting to insert a duplicate (userId, date) will throw a
     * unique constraint violation. Also serves as the index backing
     * date-range filtering and the default newest-first ordering.
     */
    uniqueIndex('workouts_user_id_date_idx').on(table.userId, table.date),

    /**
     * Composite indexes backing the training-log filter bar's "minimum X"
     * boundary filters (tss/distance/duration) and the ride-type chip, so
     * those queries stay index-scans instead of full table scans as the
     * log grows.
     */
    index('workouts_user_id_tss_idx').on(table.userId, table.tss),
    index('workouts_user_id_distance_km_idx').on(table.userId, table.distanceKm),
    index('workouts_user_id_duration_minutes_idx').on(table.userId, table.durationMinutes),
    index('workouts_user_id_ride_type_idx').on(table.userId, table.rideType),

    /**
     * CHECK constraint: RPE must be between 1 and 10 when provided.
     */
    check('rpe_range', sql`${table.rpe} IS NULL OR (${table.rpe} >= 1 AND ${table.rpe} <= 10)`),

    /**
     * CHECK constraint: duration must be positive.
     */
    check('duration_positive', sql`${table.durationMinutes} > 0`),

    /**
     * CHECK constraint: TSS must be non-negative.
     */
    check('tss_non_negative', sql`${table.tss} >= 0`),

    /**
     * CHECK constraint: distance, when provided, must be non-negative.
     */
    check('distance_km_non_negative', sql`${table.distanceKm} IS NULL OR ${table.distanceKm} >= 0`),

    /**
     * CHECK constraint: ride_type, when provided, must be 'outdoor' or 'trainer'.
     */
    check('ride_type_valid', sql`${table.rideType} IS NULL OR ${table.rideType} IN ('outdoor', 'trainer')`),
  ],
)

// ---------------------------------------------------------------------------
// power_bests
// ---------------------------------------------------------------------------

export const powerBests = pgTable(
  'power_bests',
  {
    id: serial('id').primaryKey(),
    workoutId: integer('workout_id')
      .references(() => workouts.id, { onDelete: 'cascade' })
      .notNull(),
    duration: text('duration').notNull(),
    watts: integer('watts').notNull(),
  },
  (table) => [
    uniqueIndex('power_bests_workout_id_duration_idx').on(table.workoutId, table.duration),
    check('pb_watts_positive', sql`${table.watts} > 0`),
  ],
)

// ---------------------------------------------------------------------------
// planned_workouts
// ---------------------------------------------------------------------------

export const plannedWorkouts = pgTable(
  'planned_workouts',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    date: date('date').notNull(),
    name: text('name'),
    /** Training zone: 'zone2' | 'zone4' | 'zone5' | 'zone6' */
    type: text('type'),
    tss: integer('tss'),
    durationMinutes: integer('duration_minutes'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('planned_workouts_user_id_date_idx').on(table.userId, table.date),
  ],
)

// ---------------------------------------------------------------------------
// wahoo_power_bests
//
// Best rolling-average watts per duration, derived from Wahoo activity FIT
// files (parsed by server/utils/fit.ts). Distinct from `power_bests` above,
// which holds manually-entered/confirmed per-workout bests — this table
// records whatever the raw power data showed for any ride the user previewed
// via the "Mark completed" picker, regardless of whether they logged it.
//
// Formerly `strava_power_bests`, populated by a nightly script against
// Strava's power streams — renamed when the data source moved to Wahoo's
// FIT files (see CLAUDE.md). Existing rows were preserved across the rename.
//
// Only rows still relevant to either the all-time top 3 or the trailing
// 8-week window are retained — each write prunes everything else, so
// "all-time best" and "8-week best" are always plain queries against this
// table rather than separately maintained values.
// ---------------------------------------------------------------------------

export const wahooPowerBests = pgTable(
  'wahoo_power_bests',
  {
    id: serial('id').primaryKey(),

    /** Wahoo workout ID */
    activityId: bigint('activity_id', { mode: 'number' }).notNull(),

    duration: text('duration').notNull(),

    /** Best rolling-average power for this duration within the activity */
    watts: integer('watts').notNull(),

    /** The activity's date — what the 8-week rolling window filters on */
    achievedAt: date('achieved_at').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('wahoo_power_bests_activity_id_duration_idx').on(table.activityId, table.duration),

    /** Backs both the all-time top-3 query and the prune step's ranking */
    index('wahoo_power_bests_duration_watts_idx').on(table.duration, table.watts),

    /** Backs the 8-week rolling-window query */
    index('wahoo_power_bests_duration_achieved_at_idx').on(table.duration, table.achievedAt),

    check('wahoo_pb_watts_positive', sql`${table.watts} > 0`),
    check(
      'wahoo_pb_duration_valid',
      sql`${table.duration} IN (${sql.raw(POWER_BEST_DURATIONS.map((d) => `'${d}'`).join(', '))})`,
    ),
  ],
)

// ---------------------------------------------------------------------------
// wahoo_tokens
//
// Single-row table holding the current Wahoo OAuth refresh token. Wahoo
// rotates the refresh token on every use (unlike Strava's, which never
// expires under normal use) — server/utils/wahoo.ts persists the newest
// value here so a process restart/deploy can pick up where the last one
// left off instead of falling back to the (by then stale) WAHOO_REFRESH_TOKEN
// env var. See CLAUDE.md's Wahoo integration section.
// ---------------------------------------------------------------------------

export const wahooTokens = pgTable('wahoo_tokens', {
  /** Always 1 — this table only ever holds a single row. */
  id: integer('id').primaryKey().default(1),

  refreshToken: text('refresh_token').notNull(),

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Relations (used by Drizzle's relational query API)
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  workouts: many(workouts),
  plannedWorkouts: many(plannedWorkouts),
}))

export const workoutsRelations = relations(workouts, ({ one, many }) => ({
  user: one(users, {
    fields: [workouts.userId],
    references: [users.id],
  }),
  powerBests: many(powerBests),
}))

export const powerBestsRelations = relations(powerBests, ({ one }) => ({
  workout: one(workouts, {
    fields: [powerBests.workoutId],
    references: [workouts.id],
  }),
}))

export const plannedWorkoutsRelations = relations(plannedWorkouts, ({ one }) => ({
  user: one(users, {
    fields: [plannedWorkouts.userId],
    references: [users.id],
  }),
}))

// ---------------------------------------------------------------------------
// Inferred TypeScript types
// ---------------------------------------------------------------------------

/** Full row type as returned from the database */
export type User = typeof users.$inferSelect
export type Workout = typeof workouts.$inferSelect
export type PlannedWorkout = typeof plannedWorkouts.$inferSelect
export type PowerBest = typeof powerBests.$inferSelect
export type WahooPowerBest = typeof wahooPowerBests.$inferSelect
export type WahooToken = typeof wahooTokens.$inferSelect

/** Insert types (id and createdAt are optional / auto-generated) */
export type NewUser = typeof users.$inferInsert
export type NewWorkout = typeof workouts.$inferInsert
export type NewPlannedWorkout = typeof plannedWorkouts.$inferInsert
export type NewPowerBest = typeof powerBests.$inferInsert
export type NewWahooPowerBest = typeof wahooPowerBests.$inferInsert
export type NewWahooToken = typeof wahooTokens.$inferInsert
