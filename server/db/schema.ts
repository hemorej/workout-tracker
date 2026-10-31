/**
 * Drizzle ORM schema definitions.
 *
 * Tables:
 *   - users                 — login credentials, CTL/ATL seeds, training plan, weight
 *   - workouts              — one logged workout per user per calendar day (+ FIT-derived JSON)
 *   - power_bests           — per-workout "best effort" durations (see server/utils/powerBests.ts)
 *   - planned_workouts      — one planned session per user per day (Planning tab)
 *   - power_curve           — a ride's full power curve (all 14 durations); source for History
 *   - wahoo_power_bests     — LEGACY power-curve bests auto-detected from Wahoo rides (read-only now)
 *   - wahoo_tokens          — the single rotating Wahoo OAuth refresh token
 *   - tracked_segments / segment_efforts — starred Strava segments and the athlete's efforts
 *   - zwift_workouts / zwift_workout_drafts — mirror of the local Zwift .zwo folder + web drafts
 *
 * Every user-owned table cascades on user delete (workouts → power_bests also cascades).
 * Relations for Drizzle's relational query API are declared near the bottom.
 */

import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  real,
  boolean,
  date,
  timestamp,
  jsonb,
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

/**
 * Extra stats a parsed FIT file produces beyond what's already its own
 * workouts column (TSS/duration/distance stay scalar columns; power-curve
 * bests stay in the power_bests table). Stored as one JSON blob rather than
 * a family of new scalar columns — the UI reads fields straight out of it.
 */
export interface WorkoutFitData {
  avgPower: number
  maxPower: number
  normalizedPower: number
  intensityFactor: number
  avgHr: number | null
  maxHr: number | null
  avgCadence: number | null
  maxCadence: number | null
  /**
   * Seconds spent in each of the six power zones (index 0 = Z1 … 5 = Z6),
   * bucketed sample-by-sample at 1 Hz against `zoneFtp` using the same
   * thresholds as `ZONES` in app/components/WorkoutBuilderTab.vue (see
   * computeZoneBuckets in server/utils/fit.ts). Null on rows whose FIT file
   * was parsed before this field existed — the Power tab in
   * WorkoutFitOverlay.vue hides itself when it's absent.
   */
  zoneBuckets: number[] | null

  /**
   * The FTP (watts) the `zoneBuckets` split was computed against — the
   * marker in effect on the ride's date (getFtpAsOf), not necessarily the
   * athlete's current FTP. Stored so the Power tab's per-zone watt bands
   * line up with the split. Null on blobs written before this existed.
   */
  zoneFtp: number | null
}

/**
 * One lap/split from a parsed FIT file's `lap` messages (device auto-lap or a
 * manual lap-button press) — distinct from the per-second `record` stream
 * `WorkoutFitData` is derived from. `lapNumber` is our own 1-based index into
 * the file's lap order, not the FIT `message_index` field. Stored as a JSON
 * array rather than a child table — same reasoning as `WorkoutFitData`: it's
 * small, read-only once parsed, and the UI reads it straight off the workout.
 */
export interface WorkoutLap {
  lapNumber: number
  durationSeconds: number
  distanceMeters: number
  avgPower: number | null
  maxPower: number | null
  avgHr: number | null
  maxHr: number | null
  avgCadence: number | null
  avgSpeedKph: number | null
}

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
   * Column default is 0 (independent of initialCtl); set it alongside
   * initialCtl if you want to start from a neutral form (TSB ≈ 0).
   *
   * Override only if you know your actual fatigue level at that point.
   */
  initialAtl: integer('initial_atl').default(0).notNull(),

  /**
   * Free-text training plan, used as context for the AI coach (workout
   * generation, plan suggestion and block-progression parsing — see
   * server/api/coach/). Not committed to the repo — edit via the settings UI
   * or SQL when it changes.
   */
  trainingPlan: text('training_plan'),

  /**
   * Current body weight in kg, used for nutrition/hydration calculations
   * in AI-generated fuelling guides. A single current value, not a
   * per-workout history — update via the settings UI or SQL.
   */
  weightKg: real('weight_kg'),

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

    /**
     * FTP (Functional Threshold Power) in watts. A *sparse marker*: set only
     * on the day FTP changed, null otherwise — the FTP in effect on a date is
     * the most recent marker on or before it (see server/utils/ftp.ts).
     */
    ftpWatts: integer('ftp_watts'),

    /**
     * Indoor/trainer (Zwift, etc.) vs outdoor ride. Optional — null for rows
     * logged before this field existed, until backfilled from Strava
     * (Strava's `type: 'VirtualRide'` vs `'Ride'`).
     */
    rideType: text('ride_type'),

    /**
     * The Strava activity this workout was created from, if it was created
     * via the "Mark as completed" picker (see CLAUDE.md's Completed-workout
     * picker). Null for manually-entered workouts or ones logged before this
     * field existed.
     */
    stravaActivityId: bigint('strava_activity_id', { mode: 'number' }),

    /**
     * Extra stats from a parsed FIT file (avg/max power, NP, IF, avg/max HR,
     * avg/max cadence, time-in-zone) — see WorkoutFitData above. Null until a FIT file has
     * been parsed for this workout (via "Mark as completed" or "Refresh ride
     * data"); older/manually-entered workouts never get one.
     */
    fitData: jsonb('fit_data').$type<WorkoutFitData>(),

    /**
     * Per-lap splits from the same parsed FIT file, if it had 2+ lap
     * messages — see WorkoutLap above. Null for a file with 0 or 1 laps (no
     * lap button pressed / no auto-lap) as well as for workouts with no FIT
     * data at all; the UI hides the "Laps" link whenever this isn't at least
     * a 2-element array.
     */
    laps: jsonb('laps').$type<WorkoutLap[]>(),

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
// power_curve
//
// A ride's FULL power curve: the highest average power sustained for each of
// the 14 POWER_BEST_DURATIONS. Unlike `power_bests` (only the efforts that
// were PRs when the ride was logged — the workout card badges), this keeps
// every duration, so History can compute a true rolling 8-week max and an
// all-time top 3 across all rides, not just across past PRs.
// ---------------------------------------------------------------------------

export const powerCurve = pgTable(
  'power_curve',
  {
    id: serial('id').primaryKey(),
    workoutId: integer('workout_id')
      .references(() => workouts.id, { onDelete: 'cascade' })
      .notNull(),
    duration: text('duration').notNull(),
    watts: integer('watts').notNull(),
  },
  (table) => [
    uniqueIndex('power_curve_workout_id_duration_idx').on(table.workoutId, table.duration),
    check('pc_watts_positive', sql`${table.watts} > 0`),
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
    /** Session type: 'zone2' | 'zone4' | 'zone5' | 'zone6' | 'rest' | 'outdoor' (PLAN_DAY_TYPES in server/utils/anthropic.ts) */
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
// which holds the per-workout best efforts saved with a *logged* workout —
// this table records whatever the raw power data showed for any ride seen via
// the Wahoo API (previewed through the "Mark completed" picker, or delivered
// by the webhook), regardless of whether the user logged it. Single-user:
// rows aren't keyed by user.
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
// env var. See CLAUDE.md's "Wahoo Cloud API" section.
// ---------------------------------------------------------------------------

export const wahooTokens = pgTable('wahoo_tokens', {
  /** Always 1 — this table only ever holds a single row. */
  id: integer('id').primaryKey().default(1),

  refreshToken: text('refresh_token').notNull(),

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// tracked_segments
//
// Strava segments the user has starred, mirrored locally. The Strava API has
// no event/webhook for starring and no "list every segment I've ridden"
// endpoint, so the starred list is the tracked set: it's pulled on demand by
// POST /api/segments/sync (the "Sync segments" button) and refreshed by the
// nightly POST /api/segments/reconcile. A row is kept when the segment is
// un-starred (`starred = false`) rather than deleted, so re-starring is
// instant and the effort history survives. See CLAUDE.md's "Tracked segments"
// section.
// ---------------------------------------------------------------------------

export const trackedSegments = pgTable(
  'tracked_segments',
  {
    /** Strava's own segment id (stable, global) — used as the PK directly. */
    id: bigint('id', { mode: 'number' }).primaryKey(),

    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),

    name: text('name').notNull(),

    /** Segment length in metres. */
    distanceMeters: real('distance_meters').notNull(),

    /** Average grade as a percentage, e.g. 4.2. Null if Strava omitted it. */
    averageGrade: real('average_grade'),

    /** Strava climb category 0–5 (5 = HC); null / 0 for a non-categorised climb. */
    climbCategory: integer('climb_category'),

    /** Total elevation gain over the segment, metres. A property of the
     *  segment (identical for every effort) — shown once in the UI's expander
     *  header, not per effort. */
    totalElevationGain: real('total_elevation_gain'),

    city: text('city'),
    state: text('state'),
    country: text('country'),

    /**
     * Still present in the athlete's starred list as of the last sync.
     * Un-starred segments keep their row (and efforts) with this set false.
     */
    starred: boolean('starred').notNull().default(true),

    /**
     * `athlete_segment_stats.effort_count` from the segment-detail response —
     * the reconcile job compares this against the stored effort count to
     * decide whether an effort was missed (Strava matches segments to a new
     * activity asynchronously, so the per-activity sync can run too early).
     */
    stravaEffortCount: integer('strava_effort_count'),

    /** `athlete_segment_stats.pr_elapsed_time` / `pr_date` — the single PR
     *  Strava reports for this athlete, cheap to keep in sync. */
    prElapsedTime: integer('pr_elapsed_time'),
    prDate: date('pr_date'),

    /** Last time all_efforts was pulled for this segment (null = never). */
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('tracked_segments_user_id_idx').on(table.userId),
    check('tracked_segments_distance_positive', sql`${table.distanceMeters} > 0`),
  ],
)

// ---------------------------------------------------------------------------
// segment_efforts
//
// The authenticated athlete's individual efforts on tracked segments. Keyed
// on Strava's own effort id so every sync path (manual, per-activity,
// reconcile) is a plain upsert. Not joined to `workouts` — there's no shared
// id between the two, and an effort can exist for an activity that was never
// logged as a workout.
// ---------------------------------------------------------------------------

export const segmentEfforts = pgTable(
  'segment_efforts',
  {
    /** Strava's own segment-effort id. */
    id: bigint('id', { mode: 'number' }).primaryKey(),

    segmentId: bigint('segment_id', { mode: 'number' })
      .references(() => trackedSegments.id, { onDelete: 'cascade' })
      .notNull(),

    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),

    /** The Strava activity this effort belongs to. */
    stravaActivityId: bigint('strava_activity_id', { mode: 'number' }).notNull(),

    /** Elapsed time in seconds — what efforts are ranked on. */
    elapsedTime: integer('elapsed_time').notNull(),

    /** Moving time in seconds (null on older efforts). */
    movingTime: integer('moving_time'),

    /** Effort distance in metres (≈ segment length) — used to derive speed. */
    distanceMeters: real('distance_meters'),

    startDate: timestamp('start_date', { withTimezone: true }).notNull(),

    /** Average power for the effort, watts. Null if the ride had no power. */
    averageWatts: real('average_watts'),

    /** true ⇒ from a power meter; false ⇒ Strava's estimate; null ⇒ no power. */
    deviceWatts: boolean('device_watts'),

    averageHeartrate: real('average_heartrate'),
    maxHeartrate: real('max_heartrate'),
    averageCadence: real('average_cadence'),

    /**
     * Strava's own PR ranking for this effort within the athlete's history:
     * 1 / 2 / 3, or null. Distinct from the 1–5 list position the UI renders
     * (which is just the sort order of the stored efforts).
     */
    prRank: integer('pr_rank'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    /** Backs the "5 fastest efforts for this segment" query. */
    index('segment_efforts_segment_id_elapsed_time_idx').on(table.segmentId, table.elapsedTime),
    index('segment_efforts_user_id_idx').on(table.userId),
  ],
)

// ---------------------------------------------------------------------------
// zwift_workouts / zwift_workout_drafts
//
// Server-side mirror of the user's local Zwift `.zwo` workout folder, pushed
// by the local sync daemon (scripts/zwift-sync.ts) through the secret-authed
// POST /api/zwift/sync. The local folder is the single source of truth:
// `zwift_workouts` is written ONLY by that sync. Edits made in the web UI go
// to `zwift_workout_drafts` and reach the real file only by the user
// downloading the .zwo and saving it back into the folder (the daemon then
// syncs it, which clears the draft — see zwift_workouts' modelHash).
// ---------------------------------------------------------------------------

export const zwiftWorkouts = pgTable(
  'zwift_workouts',
  {
    id: serial('id').primaryKey(),

    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),

    /**
     * Path relative to the Zwift Workouts root, '/'-separated (Zwift nests
     * files under a numeric user-id folder). The identity key — never used
     * for server filesystem access.
     */
    path: text('path').notNull(),

    /** `<name>` from the file, falling back to the path. */
    name: text('name').notNull(),

    /** The raw .zwo document (bounded to 256 KB at ingest). Untrusted data. */
    xml: text('xml').notNull(),

    /** sha256 of `xml` (utf-8), computed server-side. Daemon reconcile diffs on this. */
    contentHash: text('content_hash').notNull(),

    /**
     * sha256 of the formatting-independent canonical form (meta + blocks).
     * Equal to a draft's modelHash ⇒ the draft has been saved back to disk.
     */
    modelHash: text('model_hash').notNull(),

    durationSec: integer('duration_sec').notNull(),

    /** Estimated TSS (needs no FTP — power values in a .zwo are %FTP). */
    tss: integer('tss').notNull(),

    /** `zone:<Name>` tag value, if the file carries one. */
    zone: text('zone'),

    /** False when the builder can't faithfully represent the file (preview + download only). */
    editable: boolean('editable').notNull().default(true),

    /** Why the file is not editable (empty when it is). */
    unsupported: jsonb('unsupported').$type<string[]>().notNull().default([]),

    /** File mtime reported by the daemon. Informational. */
    fileMtime: timestamp('file_mtime', { withTimezone: true }),

    /** Soft delete: set when the file disappears from disk, cleared if it comes back. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('zwift_workouts_user_path_idx').on(table.userId, table.path),
    index('zwift_workouts_user_deleted_idx').on(table.userId, table.deletedAt),
  ],
)

export const zwiftWorkoutDrafts = pgTable(
  'zwift_workout_drafts',
  {
    id: serial('id').primaryKey(),

    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),

    workoutId: integer('workout_id')
      .references(() => zwiftWorkouts.id, { onDelete: 'cascade' })
      .notNull(),

    /** `zwift_workouts.contentHash` at the moment editing began; ≠ current ⇒ the disk file changed under the draft. */
    baseHash: text('base_hash').notNull(),

    /** The edited document, as produced by the builder's serializer. */
    xml: text('xml').notNull(),

    /** Canonical hash of `xml`, compared to zwift_workouts.modelHash. */
    modelHash: text('model_hash').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('zwift_workout_drafts_user_workout_idx').on(table.userId, table.workoutId),
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

export const trackedSegmentsRelations = relations(trackedSegments, ({ one, many }) => ({
  user: one(users, {
    fields: [trackedSegments.userId],
    references: [users.id],
  }),
  efforts: many(segmentEfforts),
}))

export const segmentEffortsRelations = relations(segmentEfforts, ({ one }) => ({
  segment: one(trackedSegments, {
    fields: [segmentEfforts.segmentId],
    references: [trackedSegments.id],
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
export type PowerCurvePoint = typeof powerCurve.$inferSelect
export type WahooPowerBest = typeof wahooPowerBests.$inferSelect
export type WahooToken = typeof wahooTokens.$inferSelect
export type TrackedSegment = typeof trackedSegments.$inferSelect
export type SegmentEffort = typeof segmentEfforts.$inferSelect
export type ZwiftWorkout = typeof zwiftWorkouts.$inferSelect
export type ZwiftWorkoutDraft = typeof zwiftWorkoutDrafts.$inferSelect

/** Insert types (id and createdAt are optional / auto-generated) */
export type NewUser = typeof users.$inferInsert
export type NewWorkout = typeof workouts.$inferInsert
export type NewPlannedWorkout = typeof plannedWorkouts.$inferInsert
export type NewPowerBest = typeof powerBests.$inferInsert
export type NewPowerCurvePoint = typeof powerCurve.$inferInsert
export type NewWahooPowerBest = typeof wahooPowerBests.$inferInsert
export type NewWahooToken = typeof wahooTokens.$inferInsert
export type NewTrackedSegment = typeof trackedSegments.$inferInsert
export type NewSegmentEffort = typeof segmentEfforts.$inferInsert
export type NewZwiftWorkout = typeof zwiftWorkouts.$inferInsert
export type NewZwiftWorkoutDraft = typeof zwiftWorkoutDrafts.$inferInsert
