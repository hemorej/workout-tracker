# Sprocket

[![Laravel Forge Site Deployment Status](https://img.shields.io/endpoint?url=https%3A%2F%2Fforge.laravel.com%2Fsite-badges%2Fa0b639e9-8525-463d-afcd-29ef34240d2e&style=plastic)](https://forge.laravel.com/jerome-zpm/resilient-bird/3264841)

A personal workout logging app built to practice the modern Nuxt 4 + Vue 3.5 + TypeScript stack.

Track your daily training sessions, visualise your fitness and fatigue over time, and understand your "form" at a glance using industry-standard training load metrics.

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Nuxt 4 (`compatibilityVersion: 4`) |
| Frontend | Vue 3.5, TypeScript |
| State | Pinia (`@pinia/nuxt`) |
| UI | Nuxt UI v3 (built on Tailwind CSS) |
| Auth | `nuxt-auth-utils` (cookie sessions) + scrypt (`@adonisjs/hash`) |
| Database | PostgreSQL 18 |
| ORM | Drizzle ORM (`drizzle-orm/node-postgres`) |
| Migrations | Drizzle Kit |

---

## Project structure

```
sprocket/
├── app/                        ← Nuxt 4 source directory
│   ├── app.vue                 ← Root component (UApp wrapper)
│   ├── pages/
│   │   ├── index.vue           ← Dashboard with Log + Planning + Builder + History tabs (protected)
│   │   └── login.vue           ← Login page (registration disabled — no signup form)
│   ├── components/
│   │   ├── BikeLogo.vue        ← App wordmark icon
│   │   ├── MetricsSummary.vue  ← Weekly stats + CTL/TSB cards
│   │   ├── WorkoutCard.vue     ← Single day row (workout or rest)
│   │   ├── AddWorkoutModal.vue ← Log workout form (modal), pre-fillable from recent Strava rides
│   │   ├── PlanningTab.vue     ← 4-week planning grid with live projections
│   │   ├── WorkoutBuilderTab.vue ← Structured workout builder, exports Zwift .zwo files
│   │   └── HistoryTab.vue      ← Aggregated history + power bests panel
│   ├── stores/
│   │   ├── auth.ts             ← Login, logout actions
│   │   ├── workouts.ts         ← Day list, weekly stats, pagination
│   │   └── planning.ts         ← Planned workouts + live CTL/TSB projection
│   └── middleware/
│       ├── auth.ts             ← Redirects guests → /login
│       └── guest.ts            ← Redirects logged-in users → /
│
├── server/
│   ├── api/
│   │   ├── auth/
│   │   │   ├── login.post.ts
│   │   │   ├── logout.post.ts
│   │   │   └── register.post.ts    ← Currently disabled (returns 403)
│   │   ├── strava/
│   │   │   └── recent-rides.get.ts ← Last 3 Strava rides, used to pre-fill the Add Workout form
│   │   ├── workouts/
│   │   │   ├── index.get.ts        ← Paginated list + metrics
│   │   │   ├── index.post.ts       ← Create workout
│   │   │   └── [id].delete.ts      ← Delete workout
│   │   ├── planned-workouts/
│   │   │   ├── index.get.ts        ← 4-week plan grid + projections
│   │   │   ├── index.put.ts        ← Upsert planned workout
│   │   │   └── [date].delete.ts    ← Delete planned workout
│   │   └── history/
│   │       └── index.get.ts        ← Aggregated history + power bests panel
│   ├── db/
│   │   ├── index.ts            ← Drizzle client (singleton pool)
│   │   └── schema.ts           ← Table definitions + inferred types
│   └── utils/
│       ├── tss.ts              ← CTL / ATL / TSB formula engine
│       ├── metricsCache.ts     ← In-process series cache (TTL + write invalidation)
│       ├── strava.ts           ← Refresh-token exchange + fetchRecentRides()
│       └── session.d.ts        ← UserSession type augmentation for nuxt-auth-utils
│
├── scripts/
│   └── reset-password.ts       ← CLI utility to reset a user's password
│
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

# Optional — Strava integration (pre-fills the Add Workout form from your
# last 3 rides). Single-user, no in-app OAuth flow. See "Strava integration"
# below for how to acquire these.
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
STRAVA_REFRESH_TOKEN=
```

### 4. Create the database

```bash
# In psql or your preferred client:
psql postgres
CREATE DATABASE workout_tracker;
CREATE USER workout_tracker WITH PASSWORD 'UjzIe9cvU9sJTwEYAIbU8gXBViKnSbJAj3gbPpEXVOc';
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
| `ftp_watts` | integer | Optional FTP recorded at time of workout |
| `created_at` | timestamptz | Default: now() |

### `power_bests`

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | Auto-increment |
| `workout_id` | integer FK | → workouts.id (cascade delete) |
| `duration` | text | One of the standard durations (5sec, 1min, 5min, 20min, 1h, …) |
| `watts` | integer | Best power in watts for this duration |

One row per duration per workout. Unique index on `(workout_id, duration)`.

### `planned_workouts`

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | Auto-increment |
| `user_id` | integer FK | → users.id (cascade delete) |
| `date` | date | One plan per user per day (unique index) |
| `name` | text | Optional workout name |
| `type` | text | Training zone: `zone2`, `zone4`, `zone5`, `zone6`, `rest` |
| `tss` | integer | Optional planned TSS |
| `duration_minutes` | integer | Optional planned duration |
| `created_at` | timestamptz | Default: now() |

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
TSB(today) = CTL(yesterday) − ATL(yesterday)
```

Measures how fresh you are at the start of the day, before adding today's load. Positive values mean you're rested; negative values mean you're carrying fatigue.

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

All routes require a valid session cookie except `/api/auth/login` and `/api/auth/register`.

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | Create account + auto-login *(currently disabled — returns 403)* |
| POST | `/api/auth/login` | Login with email + password |
| POST | `/api/auth/logout` | Clear session cookie |
| GET | `/api/workouts?page=1&limit=14` | Paginated day list with metrics |
| POST | `/api/workouts` | Log a new workout |
| DELETE | `/api/workouts/:id` | Delete a workout |
| GET | `/api/planned-workouts` | 4-week plan grid with projected CTL/TSB |
| PUT | `/api/planned-workouts` | Upsert a planned workout |
| DELETE | `/api/planned-workouts/:date` | Delete a planned workout by date |
| GET | `/api/history?groupBy=week\|month\|year` | Aggregated history periods + power bests panel |
| GET | `/api/strava/recent-rides` | Last 3 Strava rides, used to pre-fill the Add Workout form |

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
        "name": "Morning Run",
        "durationMinutes": 60,
        "tss": 80,
        "rpe": 7,
        "notes": "Felt strong in the second half."
      }
    },
    {
      "date": "2026-05-24",
      "isRestDay": true,
      "metrics": { "ctl": 64.8, "atl": 70.2, "tsb": -5.4 },
      "workout": null
    }
  ],
  "weeklyStats": { "tssTotal": 420, "hoursTotal": 8.5 },
  "todayMetrics": { "ctl": 65.3, "atl": 72.1, "tsb": -6.8 },
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
      "plan": { "id": 1, "name": "Long ride", "type": "zone2", "tss": 120, "durationMinutes": 180 },
      "projectedCtl": 62.4,
      "projectedTsb": -8.1
    },
    {
      "date": "2026-06-28",
      "isPast": false,
      "plan": null,
      "projectedCtl": 61.8,
      "projectedTsb": -5.3
    }
  ],
  "currentCtl": 61.2,
  "currentAtl": 68.5
}
```

28 entries are returned (4 weeks starting from the current Monday). Past days carry their actual historical CTL/TSB; future days carry projected values computed from planned TSS.

---

## Strava integration

Single-user "pre-fill from a recent ride" flow — there's no in-app OAuth flow and no webhooks/polling. `server/utils/strava.ts` exchanges a long-lived `STRAVA_REFRESH_TOKEN` for a short-lived access token (cached in-process, refreshed as needed) and exposes `fetchRecentRides()`. `GET /api/strava/recent-rides` returns the last 3 Ride-type activities, which the Add Workout form uses to pre-fill name, moving time, and date — TSS and power bests always stay manual since Strava's own NP/TSS formula doesn't match the user's bike computer.

To (re)acquire a refresh token: register an app at [strava.com/settings/api](https://www.strava.com/settings/api) with Authorization Callback Domain `localhost`, visit the OAuth authorize URL with `scope=activity:read_all`, approve, copy the `code` param from the (failed-to-load) `localhost` redirect, then `POST https://www.strava.com/oauth/token` with `client_id`, `client_secret`, `code`, `grant_type=authorization_code` to get the initial token pair.

---

## Resetting a password

Edit the email and new password at the top of `scripts/reset-password.ts`, then run:

```bash
pnpm reset-password
```

---

## Useful commands

```bash
pnpm dev             # Start dev server with hot reload (also starts PostgreSQL)
pnpm build           # Build for production
pnpm preview         # Preview production build locally

pnpm db:generate     # Generate migration files after schema changes
pnpm db:migrate      # Apply pending migrations
pnpm db:studio       # Open Drizzle Studio (visual DB browser at localhost:4983)
pnpm typecheck       # Type-check the whole app (nuxt typecheck / vue-tsc)
pnpm reset-password  # Reset a user's password (edit EMAIL/NEW_PASSWORD in the script first)
```

---

## Planning feature

The Planning tab shows a rolling 4-week grid (current week + 3 ahead) where you can sketch out upcoming training.

- **Zone badge** — click to cycle through Z2 → Z4 → Z5 → Z6 → REST → (none). Color-coded for quick scanning.
- **Inline editing** — workout name, TSS, and duration save on blur or Enter. No save button.
- **Live projections** — CTL and TSB update as you type, before a field is saved, so you can see the impact of planned load in real time.
- **Past days** — shown dimmed and non-editable; display actual historical CTL/TSB values.
- **Weekly TSS totals** — each week header shows the sum of planned TSS for that week.

Planned workouts are stored in the `planned_workouts` table and are independent of actual logged workouts.

---

## Key patterns to study

This codebase is intentionally annotated to be a learning reference. A few patterns worth noting:

**Singleton DB pool** (`server/db/index.ts`) — One `pg.Pool` is created for the whole server process. Drizzle wraps it but the pool handles connection reuse transparently.

**Row-level security in routes** — Every workout mutation filters by both `id` AND `userId`. This is the simplest safeguard against insecure direct object reference (IDOR) bugs.

**Timing-safe login** (`server/api/auth/login.post.ts`) — scrypt is run even when the email isn't found, so response times don't reveal whether an email address is registered.

**Server-side metrics with in-process cache** (`server/utils/tss.ts`, `server/utils/metricsCache.ts`) — CTL/ATL/TSB are computed from the full workout history and cached per user in a module-level Map. The cache is invalidated on every write (create/delete workout) and has a 5-minute TTL as a safety net to roll forward across midnight. For multi-instance deployments, replace the Map with a shared store such as Redis.

**Live projections without a round-trip** (`PlanningTab.vue`) — The planning grid recomputes projected CTL/TSB locally using the same EMA formula as the server. Draft TSS values (not yet saved) are included in the computation, so the numbers update as you type.

**`defineExpose` for modal control** (`AddWorkoutModal.vue`) — The parent holds a template ref to the modal and calls `modal.open()`. This keeps the open/close state encapsulated inside the modal component.

**Structured workout builder** (`WorkoutBuilderTab.vue`) — Composes warmup/cooldown ramps, steady-power blocks, and on/off intervals on a zone-colored timeline, then exports a Zwift `.zwo` file. All state is local to the component — nothing is persisted or shared with the Log/Planning/History tabs.
