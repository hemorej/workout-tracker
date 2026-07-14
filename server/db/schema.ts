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
  real,
  date,
  timestamp,
  uniqueIndex,
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

  /** bcrypt hash of the user's password — never store plaintext */
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

    /** Row creation timestamp (UTC) */
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    /**
     * Enforces one workout per user per day at the database level.
     * Attempting to insert a duplicate (userId, date) will throw a
     * unique constraint violation.
     */
    uniqueIndex('workouts_user_id_date_idx').on(table.userId, table.date),

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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('planned_workouts_user_id_date_idx').on(table.userId, table.date),
  ],
)

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

/** Insert types (id and createdAt are optional / auto-generated) */
export type NewUser = typeof users.$inferInsert
export type NewWorkout = typeof workouts.$inferInsert
export type NewPlannedWorkout = typeof plannedWorkouts.$inferInsert
export type NewPowerBest = typeof powerBests.$inferInsert
