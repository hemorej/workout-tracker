/**
 * nuxt-auth-utils UserSession type augmentation.
 *
 * Tells TypeScript the exact shape of the data we store in the encrypted
 * session cookie. Without this, `session.user` would be typed as `unknown`.
 *
 * This file is picked up automatically by Nuxt's type system because it
 * lives inside the `server/` directory.
 *
 * See: https://github.com/atinux/nuxt-auth-utils#session-type
 */

declare module '#auth-utils' {
  interface UserSession {
    user: {
      id: number
      email: string
      username: string
    }
  }
}

export {}
