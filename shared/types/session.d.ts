/**
 * nuxt-auth-utils `User` type augmentation.
 *
 * Tells TypeScript the exact shape of the data we store in the encrypted
 * session cookie. Must augment `User` (not `UserSession.user`) — helpers
 * like `requireUserSession()` type their return as `UserSessionRequired`,
 * which is declared as `UserSession & { user: User }`, so an override on
 * `UserSession.user` alone gets shadowed there.
 *
 * Lives under `shared/` (not `server/`) so both the app-side and server-side
 * TS projects pick it up — the app project also transitively type-checks
 * `server/api/**` for Nitro's typed-`$fetch` route inference, but doesn't
 * include arbitrary `server/utils/*.d.ts` files as root files, so an
 * augmentation placed there never actually merged into that program.
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
