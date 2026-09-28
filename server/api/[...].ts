/**
 * Catch-all for any /api/* route that doesn't match a defined handler.
 *
 * Without this, an unmatched /api/* request (typo'd endpoint, bot probe,
 * malformed double-slash path) falls through past Nitro entirely into the
 * client-side page router, which renders the app's HTML 404 page with a
 * `200` status — the wrong contract for an API caller, and for a malformed
 * path like `//api/feed/` it also still trips Vue Router's
 * "resolved to ..." console warning. Matching it here, server-side, returns
 * a real JSON 404 before either of those happens.
 */

export default defineEventHandler(() => {
  throw createError({ statusCode: 404, statusMessage: 'Not Found' })
})
