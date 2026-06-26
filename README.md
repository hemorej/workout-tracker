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
│   │   ├── index.vue           ← Dashboard (protected)
│   │   └── login.vue           ← Login / register
│   ├── components/
│   │   ├── MetricsSummary.vue  ← Weekly stats + CTL/TSB cards
│   │   ├── WorkoutCard.vue     ← Single day row (workout or rest)
│   │   └── AddWorkoutModal.vue ← Log workout form (modal)
│   ├── stores/
│   │   ├── auth.ts             ← Login, register, logout actions
│   │   └── workouts.ts         ← Day list, weekly stats, pagination
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
│   │   └── workouts/
│   │       ├── index.get.ts    ← Paginated list + metrics
│   │       ├── index.post.ts   ← Create workout
│   │       └── [id].delete.ts  ← Delete workout
│   ├── db/
│   │   ├── index.ts            ← Drizzle client (singleton pool)
│   │   └── schema.ts           ← Table definitions + inferred types
│   └── utils/
│       ├── auth.ts             ← hashPassword / verifyPassword
│       └── tss.ts              ← CTL / ATL / TSB formula engine
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
| `created_at` | timestamptz | Default: now() |

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

## Key patterns to study

This codebase is intentionally annotated to be a learning reference. A few patterns worth noting:

**Singleton DB pool** (`server/db/index.ts`) — One `pg.Pool` is created for the whole server process. Drizzle wraps it but the pool handles connection reuse transparently.

**Row-level security in routes** — Every workout mutation filters by both `id` AND `userId`. This is the simplest safeguard against insecure direct object reference (IDOR) bugs.

**Timing-safe login** (`server/api/auth/login.post.ts`) — bcrypt is run even when the email isn't found, so response times don't reveal whether an email address is registered.

**Server-side metrics** (`server/utils/tss.ts`) — CTL/ATL/TSB are computed from the full workout history on each GET request. For a personal app this is fine; at scale you'd cache or persist the computed values.

**`defineExpose` for modal control** (`AddWorkoutModal.vue`) — The parent holds a template ref to the modal and calls `modal.open()`. This keeps the open/close state encapsulated inside the modal component.
