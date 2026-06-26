import { Hash } from '@adonisjs/hash'
import { Scrypt } from '@adonisjs/hash/drivers/scrypt'
import { Pool } from 'pg'

const EMAIL = '' // <-- change this
const NEW_PASSWORD = '' // <-- change this (min 8 chars)

if (!process.env.DATABASE_URL) {
  console.error('Error: DATABASE_URL environment variable is not set.')
  process.exit(1)
}

const hash = new Hash(new Scrypt({}))
const passwordHash = await hash.make(NEW_PASSWORD)

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const result = await pool.query(
  'UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING id, email, username',
  [passwordHash, EMAIL],
)

if (result.rowCount === 0) {
  await pool.end()
  console.error(`No user found with email: ${EMAIL}`)
  process.exit(1)
}

// Read back the stored hash and verify it matches the new password
const { rows } = await pool.query('SELECT password_hash FROM users WHERE email = $1', [EMAIL])
await pool.end()

const stored = rows[0].password_hash
const valid = await hash.verify(stored, NEW_PASSWORD)

if (!valid) {
  console.error('Hash verification failed — the stored hash cannot be verified with this password.')
  console.error('Stored hash:', stored)
  process.exit(1)
}

console.log(`Password reset for: ${result.rows[0].username} (${result.rows[0].email})`)
console.log('Hash verified OK.')
