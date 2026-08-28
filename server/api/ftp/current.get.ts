/**
 * GET /api/ftp/current
 *
 * The athlete's current FTP in watts — the most recently logged workout's
 * `ftp_watts`, or the fixed fallback (230) if none has ever been set. Thin
 * wrapper over the shared `getCurrentFtpWatts` used by the FIT-parsing
 * endpoints; exposed on its own so the client can show FTP-relative numbers
 * (e.g. per-zone watt ranges in the workout summary's Power tab) without
 * pulling the whole /api/history aggregate.
 *
 * Response: { currentFtp: number }
 */

import { getCurrentFtpWatts } from '../../utils/ftp'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const currentFtp = await getCurrentFtpWatts(user.id)
  return { currentFtp }
})
