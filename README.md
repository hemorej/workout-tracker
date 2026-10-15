# Sprocket

[![Laravel Forge Site Deployment Status](https://img.shields.io/endpoint?url=https%3A%2F%2Fforge.laravel.com%2Fsite-badges%2Fa0b639e9-8525-463d-afcd-29ef34240d2e&style=plastic)](https://forge.laravel.com/jerome-zpm/resilient-bird/3264841)

A personal cycling training tracker built on the modern Nuxt 4 + Vue 3.5 + TypeScript stack.

Track your daily sessions, visualise fitness and fatigue over time, and understand your "form" at a glance using industry-standard training load metrics. Also includes: a structured workout builder that exports Zwift `.zwo` files, a 4-week planner with live CTL/TSB projections, a single-user "mark planned workout as completed" flow that pulls the ride title from Strava and the real power/TSS numbers from a parsed FIT file (via Wahoo's Cloud API or manual upload), an AI coach that turns a written training plan into a structured workout (or a multi-week plan suggestion), a Wahoo webhook that auto-logs finished outdoor rides, a Strava-segment tracker, and a Zwift workout library that mirrors your local `.zwo` folder.

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Nuxt 4 (`compatibilityVersion: 4`) |
| Frontend | Vue 3.5, TypeScript |
| State | Pinia (`@pinia/nuxt`) |
| UI | Nuxt UI v4 (Tailwind v4), Heroicons |
| Fonts | Self-hosted via `@fontsource` (no remote font requests) |
| Auth | `nuxt-auth-utils` (cookie sessions) + scrypt (`@adonisjs/hash`) |
| Database | PostgreSQL 18 |
| ORM | Drizzle ORM (`drizzle-orm/node-postgres`) |
| Migrations | Drizzle Kit |
| Logging | `tslog` (structured, per-domain; see CLAUDE.md → App logging) |
| AI | Anthropic Messages API via plain `fetch` (no SDK), `zod` for response validation |

---

## Project structure

```
sprocket/
├── app/                        ← Nuxt 4 source directory
│   ├── app.vue                 ← Root component (UApp wrapper)
│   ├── pages/
│   │   ├── [[tab]].vue         ← Dashboard shell + Training log tab; routes /, /planning, /builder, /history (protected)
│   │   ├── login.vue           ← Login page (registration disabled — no signup form)
│   │   ├── overlay/[activityId].vue ← Photo-overlay poster generator (Strava route + photo → PNG, drawn to <canvas>)
│   │   └── [...slug].vue       ← Catch-all 404
│   ├── components/
│   │   ├── PlanningTab.vue / PlanSuggest.vue ← 4+ week planning grid; multi-week "Suggest plan" preview/apply/undo
│   │   ├── WorkoutBuilderTab.vue ← Structured workout builder, exports Zwift .zwo files
│   │   ├── ZwiftLibraryPanel.vue ← Builder slide-over: browse/preview the mirrored Zwift workouts
│   │   ├── WorkoutTimeline.vue ← Shared zone-coloured timeline (builder, library preview, thumbnails)
│   │   ├── HistoryTab.vue / HistorySegmentsPanel.vue ← Aggregated history + power bests; starred-segment top-5 efforts
│   │   ├── TodaysEventsDialog.vue ← Planning tab: today's Zwift climbs + races
│   │   ├── MetricsSummary.vue / MetricsHistoryChart.vue ← Weekly stats + CTL/TSB cards; inline-SVG CTL/TSB chart
│   │   ├── WorkoutCard.vue     ← Single day row (workout or rest)
│   │   ├── WorkoutFitOverlay.vue ← "Brief ride stats" popup (power, time-in-zone, laps) for workouts with FIT data
│   │   ├── AddWorkoutModal.vue ← Log/edit workout form; prefilled by the completed-workout picker
│   │   ├── UserSettingsModal.vue ← Edit weight + training plan
│   │   ├── BikeLogo / BikeSpinner.vue ← Brand mark / loading spinner
│   │   └── Flame / Mountain / Intervals / FreeRide / TextEvent / ZoneIcon.vue ← Custom glyphs Heroicons lacks
│   ├── stores/
│   │   ├── auth.ts             ← Login, logout actions
│   │   ├── workouts.ts         ← Day list, weekly stats, pagination, log filters
│   │   ├── planning.ts         ← Planned workouts, live CTL/TSB projection, Suggest-plan draft
│   │   ├── coach.ts            ← Read-once hand-off of an AI-generated workout to the builder
│   │   └── zwiftLibrary.ts     ← Read-once hand-off of a library workout to the builder
│   ├── utils/
│   │   ├── trend.ts            ← Shared ▲/▼ trend-arrow helper
│   │   └── blockDetect.ts      ← Training-block position detection for Suggest plan
│   └── middleware/
│       ├── auth.ts             ← Redirects guests → /login
│       └── guest.ts            ← Redirects logged-in users → /
│
├── server/
│   ├── api/                    ← See the API reference below
│   │   ├── auth/ · workouts/ · planned-workouts/ · history/ · metrics/ · users/ · ftp/
│   │   ├── coach/              ← AI coach: generate, generate-plan, block-progression
│   │   ├── strava/ · wahoo/ · fit/ ← Completed-workout picker sources; Wahoo webhook (public, secret-authed)
│   │   ├── segments/           ← Tracked Strava segments (reconcile is public, secret-authed)
│   │   └── zwift/              ← today's events; library + drafts (session); sync + manifest (public, token-authed)
│   ├── db/
│   │   ├── index.ts            ← Drizzle client (singleton pool)
│   │   └── schema.ts           ← Table definitions + inferred types
│   ├── plugins/requestLogger.ts ← Nitro plugin: request IDs + one log line per /api/* call
│   └── utils/
│       ├── tss.ts              ← CTL / ATL / TSB formula engine
│       ├── metricsCache.ts     ← In-process series cache (TTL + write invalidation)
│       ├── fit.ts / fitWorkout.ts / fitStorage.ts ← FIT parsing (NP, TSS, bests, zones, laps); FIT→workout shaping; raw FIT persistence
│       ├── ftp.ts / powerBests.ts ← FTP-as-of lookups; "best effort" filtering against trailing-8-week / all-time bests
│       ├── strava.ts / wahoo.ts ← Refresh-token exchange + activity/FIT fetching (single-user OAuth)
│       ├── wahooWebhook.ts / webhookUser.ts ← Webhook types + constant-time secret compare; sole-user resolver
│       ├── stravaSegments.ts / zwiftEvents.ts / zwiftEventsCache.ts ← Segment sync helpers; Zwift events scraping + cache
│       ├── zwiftSync.ts / zwiftLibrary.ts ← Sync-daemon receiver logic; library/draft shaping
│       ├── anthropic.ts        ← Anthropic client (streamed, retried, structured output) + coach schemas
│       ├── polyline.ts         ← Google-encoded polyline decoder
│       └── logger.ts           ← getLogger(domain), tslog structured logging
│
├── shared/
│   ├── types/session.d.ts      ← UserSession type augmentation for nuxt-auth-utils
│   └── utils/zwo.ts (+ .test.ts) ← .zwo parse/serialize/TSS-estimate; shared by server, builder and scripts
├── scripts/
│   ├── reset-password.ts       ← CLI utility to reset a user's password (AdonisJS Scrypt)
│   ├── zwift-sync.ts           ← Local daemon: Zwift Workouts folder → server (launchd agent in infra/)
│   ├── backfill-*.ts, gen-*-sql.ts ← One-off historical backfills / recovery SQL generators, kept for reference
│   └── check-new-publishers.mjs ← CI supply-chain check for newly published dependency versions
├── infra/                      ← Forge deploy script, nginx/supervisor/psql configs, zwift-sync launchd plist
├── drizzle/                    ← Auto-generated migration SQL files
├── drizzle.config.ts
├── nuxt.config.ts
├── package.json
└── .env.example
```

---

## Getting started

### 1. Prerequisites

- Node.js 24.x
- pnpm 11+ (`npm install -g pnpm`)
- PostgreSQL 18+ running locally (or a hosted instance)

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

### 3.5 Install and configure the database server

```bash
brew install postgresql@18
brew services start postgresql@18
brew services stop postgresql@18
```

Edit `.env`:

```env
# Your PostgreSQL connection string
DATABASE_URL="postgresql://postgres:password@localhost:5432/workout_tracker"

# Session encryption secret (must be ≥ 32 characters)
# Generate one with: openssl rand -base64 32
NUXT_SESSION_PASSWORD="replace-this-with-a-long-random-secret!!"

# Optional — Strava integration (ride titles for the completed-workout picker,
# photo overlay, tracked segments). Single-user, no in-app OAuth flow. See
# "Strava integration" below for how to acquire these.
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
STRAVA_REFRESH_TOKEN=

# Optional — Wahoo Cloud API (fetches the actual recorded FIT file for the
# completed-workout flow; Strava's API has no FIT download). Single-user,
# out-of-band OAuth like Strava. Wahoo rotates the refresh token on every
# use — after the first refresh the live token lives in the wahoo_tokens
# table, and this value is only the bootstrap fallback. (.env.example spells
# these NUXT_WAHOO_*; both forms work.)
WAHOO_CLIENT_ID=
WAHOO_CLIENT_SECRET=
WAHOO_REFRESH_TOKEN=

# Shared secret for the public Wahoo webhook (must equal the subscription's
# webhook_token), and where raw FIT files it receives are stored (use an
# absolute path outside the release dir in production).
NUXT_WAHOO_WEBHOOK_TOKEN=
NUXT_FIT_STORAGE_DIR=

# Optional — pin the target user of the secret-authed endpoints by email.
# Unset ⇒ the sole row in `users`.
NUXT_WEBHOOK_USER_EMAIL=

# Optional — shared secrets for POST /api/segments/reconcile (nightly cron) and
# the Zwift sync daemon (POST /api/zwift/sync + manifest). Unset ⇒ not callable.
# Generate with: openssl rand -hex 32
NUXT_SEGMENTS_SYNC_TOKEN=
NUXT_ZWIFT_SYNC_TOKEN=

# Optional — Anthropic API key for the AI coach (workout generation, plan
# suggestion, block-progression parsing). Static, no rotation.
ANTHROPIC_API_KEY=

# Optional — app log verbosity (silly|trace|debug|info|warn|error|fatal), default info
LOG_LEVEL=info
```

### 4. Create the database

```bash
# In psql or your preferred client:
psql postgres
CREATE DATABASE workout_tracker;
CREATE USER workout_tracker WITH PASSWORD '...';
GRANT ALL PRIVILEGES ON DATABASE workout_tracker TO workout_tracker;
CREATE USER postgres WITH SUPERUSER CREATEDB CREATEROLE LOGIN PASSWORD 'postgres';
```

### 5. Run migrations

```bash
# Generate the SQL from the schema (only needed after schema changes)
pnpm db:generate

# Apply migrations to the database
pnpm db:migrate
```

### 6. Start the dev server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). You'll see the login page. Registration is disabled — create your account directly in the database:

```sql
-- Password hash must be generated with the app's scrypt hasher, not by hand.
-- Easiest path: insert a placeholder row, then set a real password with:
--   pnpm reset-password   (edit EMAIL / NEW_PASSWORD in scripts/reset-password.ts first)
INSERT INTO users (email, username, password_hash) VALUES ('you@example.com', 'you', 'placeholder');
```

---

## Database schema

### `users`

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | Auto-increment |
| `email` | text | Unique |
| `username` | text | Unique |
| `password_hash` | text | scrypt hash |
| `initial_ctl` | integer | Seed CTL before first workout (default 0) |
| `initial_atl` | integer | Seed ATL before first workout (default 0) |
| `training_plan` | text | Optional free-text plan, context for the AI coach |
| `weight_kg` | real | Optional current weight, used in AI fuelling guides |
| `created_at` | timestamptz | Default: now() |

Set `initial_ctl` and `initial_atl` to seed the rolling averages from a realistic baseline rather than zero:

```sql
UPDATE users SET initial_ctl = 44, initial_atl = 44 WHERE email = 'you@example.com';
```

### `workouts`

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | Auto-increment |
| `user_id` | integer FK | → users.id (cascade delete) |
| `date` | date | One workout per user per day (unique index) |
| `name` | text | Required |
| `duration_minutes` | integer | > 0 |
| `distance_km` | real | Optional, ≥ 0 (null for rows logged before this field existed) |
| `tss` | integer | ≥ 0 |
| `rpe` | integer | Optional, 1–10 |
| `notes` | text | Optional |
| `ftp_watts` | integer | Optional **sparse FTP marker** — set only on the day FTP changed; the FTP on a date is the latest marker ≤ that date |
| `ride_type` | text | Optional `trainer` \| `outdoor` |
| `strava_activity_id` | bigint | Optional Strava activity the workout was created from |
| `fit_data` | jsonb | Optional parsed-FIT stats (avg/max/NP/IF power, HR, cadence, time-in-zone buckets + the FTP they used) |
| `laps` | jsonb | Optional per-lap splits (only stored when the file has 2+ laps) |
| `created_at` | timestamptz | Default: now() |

### `power_bests`

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | Auto-increment |
| `workout_id` | integer FK | → workouts.id (cascade delete) |
| `duration` | text | One of the 14 standard durations (5sec … 1h) |
| `watts` | integer | Best power in watts for this duration |

One row per duration per workout. Unique index on `(workout_id, duration)`. A parsed FIT file yields all 14 candidates, but only durations that beat the trailing-8-week max (falling back to all-time) are stored as that workout's best efforts.

### `planned_workouts`

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | Auto-increment |
| `user_id` | integer FK | → users.id (cascade delete) |
| `date` | date | One plan per user per day (unique index) |
| `name` | text | Optional workout name |
| `type` | text | Training zone: `zone2`, `zone4`, `zone5`, `zone6`, `rest`, `outdoor` |
| `tss` | integer | Optional planned TSS |
| `duration_minutes` | integer | Optional planned duration |
| `notes` | text | Optional note (also holds generated fuelling guides) |
| `created_at` | timestamptz | Default: now() |

### `tracked_segments` / `segment_efforts`

Starred Strava segments (un-starring sets `starred = false`, never deletes) and their per-effort history, keyed on Strava ids so every write is an upsert. Shown in History → Segments. See CLAUDE.md → "Tracked segments".

### `zwift_workouts` / `zwift_workout_drafts`

Server-side mirror of the local Zwift `.zwo` folder (written only by the sync daemon; soft-deleted when a file disappears) and the web edits made to those workouts (one draft per workout, cleared when the edit is saved back into the folder). See CLAUDE.md → "Zwift workout library sync".

### `wahoo_power_bests` / `wahoo_tokens`

`wahoo_power_bests` records power-curve bests auto-detected from rides seen via the Wahoo API (keyed on the Wahoo activity id), merged into the History tab alongside `power_bests`. `wahoo_tokens` holds the single connected account's rotating OAuth refresh token — Wahoo issues a new one on every refresh, so it must be persisted rather than read from `.env` after the first exchange (see `server/utils/wahoo.ts`).

---

## Training load metrics

The app computes three derived metrics from your TSS history. These are the same formulas used by TrainingPeaks and most endurance coaching software.

### TSS — Training Stress Score

A single number representing the load of one workout session. A 1-hour ride at your functional threshold power = 100 TSS. Easy workouts are lower; very long or hard sessions can exceed 200.

### CTL — Chronic Training Load ("Fitness")

```
CTL(today) = CTL(yesterday) + (TSS(today) − CTL(yesterday)) / 42
```

An exponentially-weighted moving average of daily TSS over a ~42-day window. It rises slowly as you train consistently and falls when you rest. A higher CTL generally means higher fitness.

### ATL — Acute Training Load ("Fatigue")

```
ATL(today) = ATL(yesterday) + (TSS(today) − ATL(yesterday)) / 7
```

Same formula with a 7-day window. ATL reacts quickly to recent training — a hard week spikes it; a few easy days bring it down fast.

### TSB — Training Stress Balance ("Form")

```
TSB(today) = CTL(today) − ATL(today)
```

Measures form at the end of the day, once today's load has been absorbed (the same-day convention Strava's Fitness/Freshness uses; some PMC tools instead use yesterday's CTL − ATL). Positive values mean you're rested; negative values mean you're carrying fatigue.

CTL and ATL are seeded from `users.initial_ctl` / `initial_atl` on the day before the first logged workout.

**Form zone guide:**

| TSB range | Zone | Meaning |
|---|---|---|
| > 25 | Very fresh | May be detrained; too much rest |
| 10 – 25 | Fresh | Good race/peak condition |
| −10 – 10 | Neutral | Moderate readiness |
| −30 – −10 | Tired | Productive training zone |
| < −30 | Very fatigued | Overreaching risk |

---

## API reference

All routes require a valid session cookie except `/api/auth/login`, `/api/auth/register`, and the machine endpoints that authenticate with a shared secret instead (`/api/wahoo/webhook`, `/api/segments/reconcile`, `/api/zwift/sync`, `/api/zwift/sync/manifest`).

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | Create account + auto-login *(currently disabled — returns 403)* |
| POST | `/api/auth/login` | Login with email + password |
| POST | `/api/auth/logout` | Clear session cookie |
| GET | `/api/workouts?page=1&limit=14` | Paginated day list with metrics; optional filters `name`, `type` (`all`\|`zwift`\|`outdoor`), `minTss`, `minDistance`, `minDuration`, `dateFrom`, `dateTo` (filtered mode lists logged workouts only) |
| POST | `/api/workouts` | Log a new workout |
| GET | `/api/workouts/:id` | One workout's FIT-derived `fitData` + `laps` (omitted from the list) |
| PATCH | `/api/workouts/:id` | Edit a logged workout (full replace of the editable columns) |
| DELETE | `/api/workouts/:id` | Delete a workout |
| GET | `/api/planned-workouts` | Planning grid (4+ weeks) with projected CTL/TSB |
| PUT | `/api/planned-workouts` | Upsert one planned workout (only the fields sent are overwritten) |
| PUT | `/api/planned-workouts/batch` | Transactional multi-upsert/delete (Suggest plan Apply / Undo) |
| DELETE | `/api/planned-workouts/:date` | Delete a planned workout by date |
| GET | `/api/history?groupBy=week\|month\|year` | Aggregated history periods + power bests panel |
| GET | `/api/metrics/series?weeks=8` | Daily CTL/TSB series for charting |
| GET | `/api/users/me` · PUT `/api/users/me` | Read / update weight, training plan |
| GET | `/api/ftp/current` | Current FTP (latest `ftp_watts` marker, fallback 230) |
| GET | `/api/strava/recent-rides` | Last 3 Strava rides for the completed-workout picker |
| GET | `/api/strava/activity/:id` | One Strava activity's detail (route, streams, NP) for the photo overlay |
| GET | `/api/wahoo/by-date?date=YYYY-MM-DD` | Wahoo workout for that day + parsed FIT metrics |
| POST | `/api/fit/upload` | Manual FIT upload (multipart), indoor/Zwift branch |
| POST | `/api/wahoo/webhook` | Wahoo workout-summary webhook — **public**, shared-secret auth (`NUXT_WAHOO_WEBHOOK_TOKEN`) |
| POST | `/api/coach/generate` | AI coach: structured workout + fuelling guide for a planned day (`?date=`, `?mode=fuelling` for the guide only) |
| POST | `/api/coach/generate-plan` | AI coach: suggest 1–4 weeks of planned workouts (writes nothing) |
| GET | `/api/coach/block-progression` | Weekly TSS progression of the training block, parsed from the stored plan |
| GET | `/api/segments` | Starred segments with their top-5 efforts |
| POST | `/api/segments/sync` | Manual "Sync segments" (session auth) |
| POST | `/api/segments/reconcile` | Nightly reconcile — **public**, shared-secret auth (`NUXT_SEGMENTS_SYNC_TOKEN`) |
| GET | `/api/zwift/today?date=YYYY-MM-DD` | Today's climb portals + upcoming races |
| GET | `/api/zwift/library` · GET `/api/zwift/library/:id` | Mirrored Zwift workouts (list with thumbnails / one workout with draft state) |
| PUT | `/api/zwift/drafts` | Save the builder's edit of a library workout as its draft |
| DELETE | `/api/zwift/drafts/:workoutId` · POST `.../rebase` | Discard a draft / keep it on top of the changed disk file |
| POST | `/api/zwift/sync` · GET `/api/zwift/sync/manifest` | Sync daemon receiver + hash manifest — **public**, Bearer-token auth (`NUXT_ZWIFT_SYNC_TOKEN`) |

### GET /api/workouts response shape

```json
{
  "days": [
    {
      "date": "2026-05-25",
      "isRestDay": false,
      "metrics": { "ctl": 65.3, "atl": 72.1, "tsb": -6.8 },
      "workout": {
        "id": 42,
        "name": "Morning Ride",
        "durationMinutes": 60,
        "distanceKm": 32.4,
        "tss": 80,
        "rpe": 7,
        "notes": "Felt strong in the second half.",
        "ftpWatts": null,
        "rideType": "outdoor",
        "hasFitData": true,
        "stravaActivityId": 123456789,
        "powerBests": [{ "duration": "20min", "watts": 245 }]
      }
    },
    {
      "date": "2026-05-24",
      "isRestDay": true,
      "metrics": { "ctl": 64.8, "atl": 70.2, "tsb": -5.4 },
      "workout": null
    }
  ],
  "weeklyStats": { "tssTotal": 420, "hoursTotal": 8.5, "kmTotal": 190 },
  "todayMetrics": { "ctl": 65.3, "atl": 72.1, "tsb": -6.8 },
  "yesterdayMetrics": { "ctl": 64.8, "atl": 70.2, "tsb": -5.4 },
  "pagination": { "page": 1, "limit": 14, "totalDays": 90, "totalPages": 7 }
}
```

### GET /api/planned-workouts response shape

```json
{
  "plans": [
    {
      "date": "2026-06-23",
      "isPast": true,
      "actual": { "tss": 118, "durationMinutes": 175 },
      "plan": { "id": 1, "name": "Long ride", "type": "zone2", "tss": 120, "durationMinutes": 180, "notes": null },
      "projectedCtl": 62.4,
      "projectedTsb": -8.1
    },
    {
      "date": "2026-06-28",
      "isPast": false,
      "actual": null,
      "plan": null,
      "projectedCtl": 61.8,
      "projectedTsb": -5.3
    }
  ],
  "currentCtl": 61.2,
  "currentAtl": 68.5
}
```

At least 28 entries are returned (4 weeks starting from the current Monday), extended to whole weeks to cover any later planned day. Past days carry their actual historical CTL/TSB (and `actual` logged totals); future days carry projected values computed from planned TSS.

---

## Strava integration

Single-user flow — there's no in-app OAuth flow. `server/utils/strava.ts` exchanges a long-lived `STRAVA_REFRESH_TOKEN` for a short-lived access token (cached in-process, refreshed as needed) and exposes `fetchRecentStravaRides()`. `GET /api/strava/recent-rides` returns the last 3 `Ride`/`VirtualRide` activities for the completed-workout picker, supplying the ride *title* and outdoor/trainer classification. TSS, duration, distance and power bests always come from a parsed FIT file (Wahoo API or manual upload) since Strava's own NP/TSS formula doesn't match the user's bike computer. Strava also powers the tracked-segments feature (needs a Strava subscription for effort history).

To (re)acquire a refresh token: register an app at [strava.com/settings/api](https://www.strava.com/settings/api) with Authorization Callback Domain `localhost`, visit the OAuth authorize URL with `scope=activity:read_all`, approve, copy the `code` param from the (failed-to-load) `localhost` redirect, then `POST https://www.strava.com/oauth/token` with `client_id`, `client_secret`, `code`, `grant_type=authorization_code` to get the initial token pair.

---

## Wahoo webhook and FIT storage

Besides the on-demand lookup, the app receives Wahoo's workout-summary webhook at `POST /api/wahoo/webhook` (shared-secret auth — `NUXT_WAHOO_WEBHOOK_TOKEN` must equal the subscription's `webhook_token`). For a finished outdoor ride with a FIT file it stores the raw file under `NUXT_FIT_STORAGE_DIR` (default `.data/fit-files`; in production use an absolute path outside the release dir), parses it, and upserts that day's `workouts` row (FIT-derived fields refresh; a manual name/notes/RPE/FTP are kept). Zwift rides never carry a FIT file in Wahoo's API, hence the manual-upload branch. Details: CLAUDE.md → "Wahoo webhook + FIT file storage".

---

## Zwift workout library sync

`pnpm zwift-sync` runs a local daemon that watches `~/Documents/Zwift/Workouts` and mirrors every `.zwo` to the server (`POST /api/zwift/sync`, authenticated with `NUXT_ZWIFT_SYNC_TOKEN`; set `SPROCKET_URL` and `ZWIFT_SYNC_TOKEN` for the daemon). The folder is the source of truth — sync is one-way (disk → server), with a periodic full reconcile because file events are lossy. The Workout builder's library panel lists the mirror; edits are saved as server-side drafts and reach the real file only when you download the `.zwo` and save it back into the folder. `infra/zwift-sync.plist.example` is a launchd agent for running it at login. Details: CLAUDE.md → "Zwift workout library sync".

---

## Resetting a password

Edit the email and new password at the top of `scripts/reset-password.ts`, then run:

```bash
pnpm reset-password
```

---

## Useful commands

```bash
pnpm dev             # Start dev server with hot reload (also starts PostgreSQL via brew services)
pnpm stop            # Stop the brew PostgreSQL service
pnpm build           # Build for production
pnpm start           # Run the production build (.output/server/index.mjs)
pnpm test            # Unit tests for the .zwo parser (node:test, no test dependency)
pnpm zwift-sync      # Local Zwift-folder sync daemon (--once, --dry-run, --force-deletes)

pnpm db:generate     # Generate migration files after schema changes
pnpm db:migrate      # Apply pending migrations
pnpm typecheck       # Type-check the whole app (nuxt typecheck / vue-tsc)
pnpm reset-password  # Reset a user's password (edit EMAIL/NEW_PASSWORD in the script first)
```

---

## Planning feature

The Planning tab shows a rolling grid of at least 4 weeks (current week + 3 ahead, with an "Add week" action) where you can sketch out upcoming training.

- **Zone badge** — click to cycle through Z2 → Z4 → Z5 → Z6 → REST → OUTDOOR → (none). Color-coded for quick scanning.
- **Inline editing** — workout name, TSS, duration and a per-day note save on blur or Enter. No save button.
- **Live projections** — CTL and TSB update as you type, before a field is saved, so you can see the impact of planned load in real time.
- **Past days** — shown dimmed and non-editable; display the logged workout's actual TSS/duration and historical CTL/TSB.
- **Weekly TSS totals** — each week header shows logged TSS plus the planned total.
- **AI row actions** — build a complete workout for the day (hands off to the Workout builder) or generate just a fuelling guide into the day's note.
- **Suggest plan** — generate 1–4 weeks as a preview overlay (block position detected from `w1:`-style names or weekly TSS), then Apply (with an overwrite prompt) or Undo.
- **Today's events** — a link opens today's Zwift climb-portal rotation and upcoming TT/crit races.

Planned workouts are stored in the `planned_workouts` table and are independent of actual logged workouts.

---

## Design conventions

- **Fonts are self-hosted.** Hanken Grotesk, Archivo and Instrument Serif are vendored via `@fontsource` packages and declared with `@font-face` in `app/assets/css/main.css`; `nuxt.config.ts` disables `@nuxt/fonts` remote providers for them. No request ever goes to Google Fonts or another font CDN.
- **Icons are Heroicons** (`i-heroicons-*`). Nuxt UI's built-in component icons are remapped from Lucide to Heroicons via `appConfig.ui.icons`. A few custom SVG components cover glyphs Heroicons lacks (flame, mountain, intervals, bike logo). Some older components still hand-inline SVGs — prefer `<UIcon>` for new work.
- **Theme:** orange primary, stone neutral. See `CLAUDE.md` for the full conventions.

---

## Key patterns to study

This codebase is intentionally annotated to be a learning reference. A few patterns worth noting:

**Singleton DB pool** (`server/db/index.ts`) — One `pg.Pool` is created for the whole server process. Drizzle wraps it but the pool handles connection reuse transparently.

**Row-level security in routes** — Every workout mutation filters by both `id` AND `userId`. This is the simplest safeguard against insecure direct object reference (IDOR) bugs.

**Timing-safe login** (`server/api/auth/login.post.ts`) — scrypt is run even when the email isn't found, so response times don't reveal whether an email address is registered.

**Server-side metrics with in-process cache** (`server/utils/tss.ts`, `server/utils/metricsCache.ts`) — CTL/ATL/TSB are computed from the full workout history and cached per user in a module-level Map. The cache is invalidated on every workout write (create/edit/delete and the Wahoo webhook upsert) and has a 5-minute TTL as a safety net to roll forward across midnight. For multi-instance deployments, replace the Map with a shared store such as Redis.

**Live projections without a round-trip** (`PlanningTab.vue`) — The planning grid recomputes projected CTL/TSB locally using the same EMA formula as the server. Draft TSS values (not yet saved) are included in the computation, so the numbers update as you type.

**Structured workout builder** (`WorkoutBuilderTab.vue`) — Composes warmup/cooldown ramps, steady-power blocks, on/off intervals, free rides and text cues on a zone-colored timeline, then exports a Zwift `.zwo` file (parsed/serialized by `shared/utils/zwo.ts`, which treats its input as untrusted). State is local to the component; the only things crossing in are the AI-coach hand-off (`coach` store) and library workouts (`zwiftLibrary` store), whose edits persist only as server-side drafts.

**Secret-authed machine endpoints** — the Wahoo webhook, segments reconcile and Zwift sync routes sit outside session auth by design (there's no server middleware in this repo): each checks a constant-time shared-secret match as the very first thing it does.

**Right-sized LLM integration** (`server/utils/anthropic.ts`) — a single streamed, structured-output `fetch` call instead of the SDK; the stream only exists so the timeout bounds time-to-first-token, and the zod schema is the real gate on the response.
