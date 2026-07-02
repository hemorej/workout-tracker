import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle Kit configuration.
 * Used by the `drizzle-kit` CLI for generating and running migrations.
 *
 * Commands:
 *   pnpm db:generate  — generates SQL migration files from schema changes
 *   pnpm db:migrate   — applies pending migrations to the database
 *   pnpm db:studio    — opens Drizzle Studio (visual DB browser)
 */
export default defineConfig({
  // Path to schema file(s) — Drizzle reads these to diff against the DB
  schema: './server/db/schema.ts',

  // Directory where generated migration SQL files are stored
  out: './drizzle',

  // PostgreSQL dialect
  dialect: 'postgresql',

  // Connection string read from environment variable
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
