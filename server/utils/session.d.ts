/**
 * nuxt-auth-utils `User` type augmentation.
 *
 * Tells TypeScript the exact shape of the data we store in the encrypted
 * session cookie. Must augment `User` (not `UserSession.user`) — helpers
 * like `requireUserSession()` type their return as `UserSessionRequired`,
 * which is declared as `UserSession & { user: User }`, so an override on
 * `UserSession.user` alone gets shadowed there.
 *
 * This file is picked up automatically by Nuxt's type system because it
 * lives inside the `server/` directory.
 *
 * See: https://github.com/atinux/nuxt-auth-utils#session-type
 */

declare module '#auth-utils' {
  interface User {
    id: number
    email: string
    username: string
  }
}

export {}
