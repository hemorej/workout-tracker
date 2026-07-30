import { Logger } from 'tslog'

const levels: Record<string, number> = { silly: 0, trace: 1, debug: 2, info: 3, warn: 4, error: 5, fatal: 6 }

const root = new Logger({
  name: 'sprocket',
  type: process.env.NODE_ENV === 'production' ? 'json' : 'pretty',
  minLevel: levels[process.env.LOG_LEVEL ?? 'info'] ?? levels.info,
})

export function getLogger(domain: string) {
  return root.getSubLogger({ name: domain })
}
