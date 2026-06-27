# WorkoutTracker

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
| Auth | `nuxt-auth-utils` (cookie sessions) + bcrypt |
| Database | PostgreSQL |
| ORM | Drizzle ORM (`drizzle-orm/node-postgres`) |
| Migrations | Drizzle Kit |

---

## Project structure

```
workout-tracker/
├── app/                        ← Nuxt 4 source directory
│   ├── app.vue                 ← Root component (UApp wrapper)
│   ├── pages/
│   │   ├── index.vue           ← Dashboard with Log + Planning tabs (protected)
│   │   └── login.vue           ← Login / register
│   ├── components/
│   │   ├── MetricsSummary.vue  ← Weekly stats + CTL/TSB cards
│   │   ├── WorkoutCard.vue     ← Single day row (workout or rest)
│   │   ├── AddWorkoutModal.vue ← Log workout form (modal)
│   │   └── PlanningTab.vue     ← 4-week planning grid with live projections
│   ├── stores/
│   │   ├── auth.ts             ← Login, register, logout actions
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
│   │   │   └── register.post.ts
│   │   ├── workouts/
│   │   │   ├── index.get.ts        ← Paginated list + metrics
│   │   │   ├── index.post.ts       ← Create workout
│   │   │   └── [id].delete.ts      ← Delete workout
│   │   └── planned-workouts/
│   │       ├── index.get.ts        ← 4-week plan grid + projections
│   │       ├── index.put.ts        ← Upsert planned workout
│   │       └── [date].delete.ts    ← Delete planned workout
│   ├── db/
│   │   ├── index.ts            ← Drizzle client (singleton pool)
│   │   └── schema.ts           ← Table definitions + inferred types
│   └── utils/
│       ├── auth.ts             ← hashPassword / verifyPassword
│       ├── tss.ts              ← CTL / ATL / TSB formula engine
│       └── metricsCache.ts     ← In-process series cache (TTL + write invalidation)
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

- Node.js 20+
- PostgreSQL 15+ running locally (or a hosted instance)

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

### 3.5 Install and configure the database server

```bash
brew install postgresql@15
brew services start postgresql@15
brew services stop postgresql@15
```

Edit `.env`:

```env
# Your PostgreSQL connection string
DATABASE_URL="postgresql://postgres:password@localhost:5432/workout_tracker"

# Session encryption secret (must be ≥ 32 characters)
# Generate one with: openssl rand -base64 32
NUXT_SESSION_PASSWORD="replace-this-with-a-long-random-secret!!"
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
npm run db:generate

# Apply migrations to the database
npm run db:migrate
```

### 6. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You'll see the login page — create an account to get started.

---

## Database schema

### `users`

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | Auto-increment |
| `email` | text | Unique |
| `username` | text | Unique |
| `password_hash` | text | bcrypt hash |
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
| `tss` | integer | ≥ 0 |
| `rpe` | integer | Optional, 1–10 |
| `notes` | text | Optional |
| `created_at` | timestamptz | Default: now() |

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
| POST | `/api/auth/register` | Create account + auto-login |
| POST | `/api/auth/login` | Login with email + password |
| POST | `/api/auth/logout` | Clear session cookie |
| GET | `/api/workouts?page=1&limit=14` | Paginated day list with metrics |
| POST | `/api/workouts` | Log a new workout |
| DELETE | `/api/workouts/:id` | Delete a workout |
| GET | `/api/planned-workouts` | 4-week plan grid with projected CTL/TSB |
| PUT | `/api/planned-workouts` | Upsert a planned workout |
| DELETE | `/api/planned-workouts/:date` | Delete a planned workout by date |

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

## Resetting a password

Edit the email and new password at the top of `scripts/reset-password.ts`, then run:

```bash
npm run reset-password
```

---

## Useful commands

```bash
npm run dev          # Start dev server with hot reload
npm run build        # Build for production
npm run preview      # Preview production build locally

npm run db:generate  # Generate migration files after schema changes
npm run db:migrate   # Apply pending migrations
npm run db:studio    # Open Drizzle Studio (visual DB browser at localhost:4983)
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

**Timing-safe login** (`server/api/auth/login.post.ts`) — bcrypt is run even when the email isn't found, so response times don't reveal whether an email address is registered.

**Server-side metrics with in-process cache** (`server/utils/tss.ts`, `server/utils/metricsCache.ts`) — CTL/ATL/TSB are computed from the full workout history and cached per user in a module-level Map. The cache is invalidated on every write (create/delete workout) and has a 5-minute TTL as a safety net to roll forward across midnight. For multi-instance deployments, replace the Map with a shared store such as Redis.

**Live projections without a round-trip** (`PlanningTab.vue`) — The planning grid recomputes projected CTL/TSB locally using the same EMA formula as the server. Draft TSS values (not yet saved) are included in the computation, so the numbers update as you type.

**`defineExpose` for modal control** (`AddWorkoutModal.vue`) — The parent holds a template ref to the modal and calls `modal.open()`. This keeps the open/close state encapsulated inside the modal component.
