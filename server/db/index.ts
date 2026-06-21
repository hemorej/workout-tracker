/**
 * Drizzle ORM client — singleton pattern.
 *
 * We create the postgres connection pool once and reuse it across all
 * server-side requests (Nitro runs in a single Node.js process).
 *
 * The DATABASE_URL env var must be set before starting the server.
 * In development, put it in your `.env` file.
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

/**
 * Lazily-initialised singleton pool.
 * Using a module-level variable ensures the pool is created once,
 * even when Nitro hot-reloads modules during development.
 */
let _pool: Pool | null = null

function getPool(): Pool {
  if (!_pool) {
    const config = useRuntimeConfig()

    if (!config.databaseUrl) {
      throw new Error(
        'DATABASE_URL is not set. Add it to your .env file and restart the server.',
      )
    }

    _pool = new Pool({
      connectionString: config.databaseUrl,
      // Keep a small pool — this is a single-user personal app
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
    })
  }
  return _pool
}

/**
 * Returns a Drizzle client bound to the shared connection pool.
 *
 * Pass `schema` so Drizzle's relational query API (db.query.workouts...)
 * has access to table definitions.
 *
 * Usage in server routes:
 * ```ts
 * const db = useDB()
 * const workouts = await db.select().from(schema.workouts)
 * ```
 */
export function useDB() {
  return drizzle(getPool(), { schema })
}
