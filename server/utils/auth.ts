/**
 * Authentication utilities.
 *
 * Provides two helpers:
 *   - hashPassword   — hashes a plaintext password with bcrypt
 *   - verifyPassword — compares a plaintext password against a stored hash
 *
 * bcrypt is deliberately slow (controlled by `SALT_ROUNDS`) which makes
 * brute-force attacks expensive even if the database is compromised.
 */

import bcrypt from 'bcryptjs'

/**
 * Number of salt rounds for bcrypt.
 * 12 is a good balance between security and performance (~300ms on modern hardware).
 * Increase if your server is fast; decrease only in test environments.
 */
const SALT_ROUNDS = 12

/**
 * Hashes a plaintext password using bcrypt.
 *
 * @param password - The raw password from the registration form
 * @returns A bcrypt hash string safe to store in the database
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS)
}

/**
 * Verifies a plaintext password against a stored bcrypt hash.
 *
 * @param password - The raw password from the login form
 * @param hash     - The stored bcrypt hash from the database
 * @returns `true` if the password matches, `false` otherwise
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}
