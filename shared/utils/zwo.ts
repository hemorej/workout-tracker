/**
 * Zwift `.zwo` workout files: parse, serialize, estimate duration/TSS.
 *
 * Shared by the server (sync endpoint), the Workout Builder (client) and the
 * local sync daemon / CLI scripts. Keep this file dependency-free and limited
 * to erasable TypeScript (no enums, no parameter properties, no imports) so
 * Node can run it directly under `--experimental-strip-types`.
 *
 * ── Input is untrusted ──────────────────────────────────────────────────
 * The server feeds this parser whatever the sync daemon posts, so it is
 * hardened: a small purpose-built scanner (no entity expansion, DOCTYPE /
 * ENTITY rejected outright), hard caps on size / depth / node count /
 * `Repeat` / total duration, and no recursion. Anything over a cap is a
 * parse *error* and is never computed.
 *
 * ── Fidelity ────────────────────────────────────────────────────────────
 * The builder can only model Warmup/Cooldown/Ramp, SteadyState, IntervalsT
 * and FreeRide. Anything else (unknown blocks, `pace` targets, unknown
 * top-level structures) is reported in `unsupported` and makes the file
 * `editable: false` (preview + download-original only) — we never
 * re-serialize something we couldn't fully represent.
 *
 * `<textevent>` children are preserved verbatim on the block they belong to
 * (`textEvents`) and re-emitted on serialize. They are *read-only*: no UI
 * edits them, and they travel with their block (offsets are relative to the
 * block start, so they are not re-timed if the block's duration changes).
 *
 * Non-modelled metadata the builder doesn't touch — description, author,
 * `<tags>` (the `zone:*` tag scripts/workout-search.ts filters on lives
 * here), and any other simple top-level text elements — round-trips via
 * `ZwoMeta`.
 */

// ── Limits ───────────────────────────────────────────────────────────────

export const ZWO_LIMITS = {
  /** Max size of one .zwo document, in UTF-16 code units of the string. */
  maxXmlLength: 256 * 1024,
  maxDepth: 8,
  maxNodes: 20_000,
  maxBlocks: 2_000,
  /** Max `Repeat` on a single IntervalsT. */
  maxRepeat: 500,
  maxTotalDurationSec: 24 * 3600,
  maxPathLength: 255,
} as const

// ── Zone tags ────────────────────────────────────────────────────────────

// Ordered low-to-high by roughly how much power each zone targets, not alphabetically.
export const ZWO_ZONE_NAMES = ['ActiveRecovery', 'Endurance', 'Tempo', 'SweetSpot', 'Threshold', 'VO2Max', 'Anaerobic', 'Sprint'] as const
export type ZwoZoneName = typeof ZWO_ZONE_NAMES[number]

/** The first valid `zone:<Name>` entry in a workout's tag list, if any. */
export function zoneFromTags(tags: readonly string[]): ZwoZoneName | null {
  for (const tag of tags) {
    if (!tag.startsWith('zone:')) continue
    const value = tag.slice('zone:'.length)
    if ((ZWO_ZONE_NAMES as readonly string[]).includes(value)) return value as ZwoZoneName
  }
  return null
}

// ── Model ────────────────────────────────────────────────────────────────

/** A `<textevent>` child, attributes kept raw (`timeoffset`, `message`, …). Read-only. */
export interface ZwoTextEvent {
  attrs: Record<string, string>
}

interface ZwoBlockBase {
  textEvents?: ZwoTextEvent[]
}

export interface ZwoRampBlock extends ZwoBlockBase { type: 'warmup' | 'cooldown', duration: number, powerStart: number, powerEnd: number, cadence: number | null }
export interface ZwoSteadyBlock extends ZwoBlockBase { type: 'steady', duration: number, power: number, cadence: number | null }
export interface ZwoIntervalBlock extends ZwoBlockBase { type: 'interval', reps: number, onDuration: number, onPower: number, onCadence: number | null, offDuration: number, offPower: number, offCadence: number | null }
export interface ZwoFreeRideBlock extends ZwoBlockBase { type: 'freeride', duration: number, flatRoad: boolean, ftpTest: boolean }
export type ZwoBlock = ZwoRampBlock | ZwoSteadyBlock | ZwoIntervalBlock | ZwoFreeRideBlock

export interface ZwoMeta {
  name: string
  author: string
  description: string
  sportType: string
  /** `<tag name="…"/>` values, in file order. */
  tags: string[]
  /** Other simple top-level text elements (e.g. `category`), re-emitted verbatim. */
  extraMeta: Record<string, string>
}

export interface ZwoWorkout {
  meta: ZwoMeta
  blocks: ZwoBlock[]
  /** Human-readable reasons the builder can't faithfully represent this file. */
  unsupported: string[]
  /** True iff `unsupported` is empty — safe to open in the builder and re-serialize. */
  editable: boolean
  durationSec: number
  /** Estimated TSS (Coggan NP model on a 1 Hz trace; power values are %FTP so no FTP needed). */
  tss: number
}

export type ZwoParseResult = { ok: true, workout: ZwoWorkout } | { ok: false, error: string }

export const DEFAULT_CADENCE = 85
const DEFAULT_AUTHOR = 'Sprocket'

// ── Path validation (sync identity key) ──────────────────────────────────

/**
 * A workout's identity is its path relative to the Zwift Workouts root,
 * '/'-separated (Zwift keeps files under a numeric user-id folder and the
 * scanner recurses). The path is never used for filesystem access, but is
 * validated anyway so it can't become a traversal later. Returns the NFC
 * normalized path, or null if invalid.
 */
export function normalizeZwoPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const path = raw.normalize('NFC')
  if (path.length === 0 || path.length > ZWO_LIMITS.maxPathLength) return null
  if (!path.toLowerCase().endsWith('.zwo')) return null
  if (path.startsWith('/') || path.includes('\\')) return null
  if (/[\u0000-\u001f\u007f]/.test(path)) return null
  const segments = path.split('/')
  if (segments.some(s => s === '' || s === '.' || s === '..')) return null
  return path
}

// ── Escaping ─────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (match, entity: string) => {
    switch (entity) {
      case 'lt': return '<'
      case 'gt': return '>'
      case 'amp': return '&'
      case 'quot': return '"'
      case 'apos': return '\''
    }
    const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
    return String.fromCodePoint(code)
  })
}

// ── Minimal XML scanner ──────────────────────────────────────────────────

interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

const TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<(\/)?([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/)?>|([^<]+)/y
const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(raw)) !== null) {
    attrs[m[1]!] = unescapeXml(m[2] ?? m[3] ?? '')
  }
  return attrs
}

function scanXml(src: string): { ok: true, root: XmlNode } | { ok: false, error: string } {
  const stack: XmlNode[] = []
  let root: XmlNode | null = null
  let nodeCount = 0
  TOKEN_RE.lastIndex = 0

  while (TOKEN_RE.lastIndex < src.length) {
    const m = TOKEN_RE.exec(src)
    if (!m) return { ok: false, error: 'malformed XML' }

    const [, cdata, closing, name, rawAttrs, selfClose, text] = m
    const top = stack[stack.length - 1]

    if (cdata !== undefined) {
      if (top) top.text += cdata
      continue
    }
    if (text !== undefined) {
      if (top) top.text += unescapeXml(text)
      else if (text.trim() !== '') return { ok: false, error: 'text outside the root element' }
      continue
    }
    if (name === undefined) continue // comment / processing instruction

    if (closing) {
      const open = stack.pop()
      if (!open || open.name !== name) return { ok: false, error: 'mismatched closing tag' }
      continue
    }

    nodeCount += 1
    if (nodeCount > ZWO_LIMITS.maxNodes) return { ok: false, error: 'too many elements' }
    const node: XmlNode = { name, attrs: parseAttrs(rawAttrs ?? ''), children: [], text: '' }
    if (top) top.children.push(node)
    else if (root) return { ok: false, error: 'multiple root elements' }
    else root = node

    if (!selfClose) {
      if (stack.length >= ZWO_LIMITS.maxDepth) return { ok: false, error: 'nesting too deep' }
      stack.push(node)
    }
  }

  if (stack.length > 0) return { ok: false, error: 'unclosed element' }
  if (!root) return { ok: false, error: 'no root element' }
  return { ok: true, root }
}

// ── Parse ────────────────────────────────────────────────────────────────

function numAttr(node: XmlNode, name: string): number | null {
  const raw = node.attrs[name]
  if (raw === undefined || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function cadenceAttr(node: XmlNode, name: string): number | null {
  const n = numAttr(node, name)
  return n && n > 0 ? n : null
}

function collectTextEvents(node: XmlNode): ZwoTextEvent[] | undefined {
  const events = node.children.filter(c => c.name.toLowerCase() === 'textevent').map(c => ({ attrs: { ...c.attrs } }))
  return events.length ? events : undefined
}

function withTextEvents<T extends ZwoBlock>(block: T, node: XmlNode): T {
  const textEvents = collectTextEvents(node)
  if (textEvents) block.textEvents = textEvents
  return block
}

function hasOnlyTextEventChildren(node: XmlNode): boolean {
  return node.children.every(c => c.name.toLowerCase() === 'textevent')
}

function blockTotalSeconds(block: ZwoBlock): number {
  if (block.type === 'interval') return block.reps * (block.onDuration + block.offDuration)
  return block.duration
}

export function parseZwo(xml: string): ZwoParseResult {
  if (typeof xml !== 'string') return { ok: false, error: 'not a string' }
  if (xml.length > ZWO_LIMITS.maxXmlLength) return { ok: false, error: 'file too large' }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return { ok: false, error: 'DOCTYPE/ENTITY declarations are not allowed' }

  const scanned = scanXml(xml)
  if (!scanned.ok) return scanned
  const root = scanned.root
  if (root.name !== 'workout_file') return { ok: false, error: 'root element is not <workout_file>' }

  const unsupported: string[] = []
  const meta: ZwoMeta = { name: '', author: '', description: '', sportType: 'bike', tags: [], extraMeta: {} }
  const blocks: ZwoBlock[] = []
  let sawWorkout = false

  for (const child of root.children) {
    switch (child.name) {
      case 'name': meta.name = child.text.trim(); break
      case 'author': meta.author = child.text.trim(); break
      case 'description': meta.description = child.text.trim(); break
      case 'sportType': meta.sportType = child.text.trim() || 'bike'; break
      case 'tags':
        for (const t of child.children) {
          if (t.name === 'tag' && t.attrs.name) meta.tags.push(t.attrs.name)
        }
        break
      case 'workout': {
        if (sawWorkout) return { ok: false, error: 'multiple <workout> elements' }
        sawWorkout = true
        if (child.children.length > ZWO_LIMITS.maxBlocks) return { ok: false, error: 'too many blocks' }
        for (const node of child.children) {
          const block = parseBlock(node, unsupported)
          if (block === 'too-many-repeats') return { ok: false, error: `Repeat exceeds ${ZWO_LIMITS.maxRepeat}` }
          if (block) blocks.push(block)
        }
        break
      }
      default:
        if (child.children.length === 0 && child.text.trim() !== '') {
          meta.extraMeta[child.name] = child.text.trim()
        }
        else {
          unsupported.push(`unknown element <${child.name}>`)
        }
    }
  }

  if (!sawWorkout) return { ok: false, error: 'missing <workout> element' }

  let durationSec = 0
  for (const b of blocks) {
    durationSec += blockTotalSeconds(b)
    if (durationSec > ZWO_LIMITS.maxTotalDurationSec) return { ok: false, error: 'workout longer than 24h' }
  }

  return {
    ok: true,
    workout: {
      meta,
      blocks,
      unsupported,
      editable: unsupported.length === 0,
      durationSec,
      tss: estimateTss(blocks),
    },
  }
}

function parseBlock(node: XmlNode, unsupported: string[]): ZwoBlock | 'too-many-repeats' | null {
  const tag = node.name
  if (!hasOnlyTextEventChildren(node)) {
    unsupported.push(`<${tag}> has unsupported children`)
    return null
  }
  // Zwift's own editor writes `pace="0"` on every block — a no-op on bikes.
  // A non-zero pace target can't be modelled (so the file is non-editable) but
  // the block is still parsed, keeping duration/TSS right for the preview.
  const pace = node.attrs.pace ?? node.attrs.Pace
  if (pace !== undefined && Number(pace) !== 0) {
    unsupported.push(`<${tag}> uses a pace target`)
  }

  switch (tag) {
    case 'Warmup':
    case 'Cooldown':
    case 'Ramp': {
      const duration = numAttr(node, 'Duration')
      const low = numAttr(node, 'PowerLow')
      const high = numAttr(node, 'PowerHigh')
      if (duration === null || low === null || high === null) {
        unsupported.push(`<${tag}> is missing Duration/PowerLow/PowerHigh`)
        return null
      }
      // `Ramp` is Zwift's direction-agnostic ramp; classify by direction.
      const type = tag === 'Warmup' ? 'warmup' : tag === 'Cooldown' ? 'cooldown' : (low <= high ? 'warmup' : 'cooldown')
      return withTextEvents({ type, duration, powerStart: low, powerEnd: high, cadence: cadenceAttr(node, 'Cadence') }, node)
    }
    case 'SteadyState': {
      const duration = numAttr(node, 'Duration')
      const power = numAttr(node, 'Power')
      if (duration === null || power === null) {
        unsupported.push('<SteadyState> is missing Duration/Power')
        return null
      }
      return withTextEvents({ type: 'steady', duration, power, cadence: cadenceAttr(node, 'Cadence') }, node)
    }
    case 'IntervalsT': {
      const reps = numAttr(node, 'Repeat')
      const onDuration = numAttr(node, 'OnDuration')
      const offDuration = numAttr(node, 'OffDuration')
      const onPower = numAttr(node, 'OnPower')
      const offPower = numAttr(node, 'OffPower')
      if (reps === null || onDuration === null || offDuration === null || onPower === null || offPower === null) {
        unsupported.push('<IntervalsT> is missing required attributes')
        return null
      }
      if (reps > ZWO_LIMITS.maxRepeat) return 'too-many-repeats'
      // Same completion rule as serialize (see blockXml): if either side has a
      // cadence, both do — so the parsed model already reflects what we'd write.
      const onCad = cadenceAttr(node, 'Cadence')
      const offCad = cadenceAttr(node, 'CadenceResting')
      const hasCadence = onCad || offCad
      return withTextEvents({
        type: 'interval',
        reps,
        onDuration,
        onPower,
        onCadence: hasCadence ? (onCad ?? DEFAULT_CADENCE) : null,
        offDuration,
        offPower,
        offCadence: hasCadence ? (offCad ?? DEFAULT_CADENCE) : null,
      }, node)
    }
    case 'FreeRide': {
      const duration = numAttr(node, 'Duration')
      if (duration === null) {
        unsupported.push('<FreeRide> is missing Duration')
        return null
      }
      return withTextEvents({
        type: 'freeride',
        duration,
        flatRoad: node.attrs.FlatRoad === '1' || node.attrs.flatroad === '1',
        ftpTest: node.attrs.ftptest === '1' || node.attrs.FtpTest === '1',
      }, node)
    }
    default:
      unsupported.push(`unsupported block <${tag}>`)
      return null
  }
}

// ── Serialize ────────────────────────────────────────────────────────────

function cadenceAttrString(name: string, value: number | null): string {
  return value ? ` ${name}="${value}"` : ''
}

function blockXml(b: ZwoBlock): string {
  let tagName: string
  let open: string
  switch (b.type) {
    case 'warmup':
      tagName = 'Warmup'
      open = `<Warmup Duration="${b.duration}" PowerLow="${b.powerStart}" PowerHigh="${b.powerEnd}"${cadenceAttrString('Cadence', b.cadence)}`
      break
    case 'cooldown':
      tagName = 'Cooldown'
      open = `<Cooldown Duration="${b.duration}" PowerLow="${b.powerStart}" PowerHigh="${b.powerEnd}"${cadenceAttrString('Cadence', b.cadence)}`
      break
    case 'steady':
      tagName = 'SteadyState'
      open = `<SteadyState Duration="${b.duration}" Power="${b.power}"${cadenceAttrString('Cadence', b.cadence)}`
      break
    case 'interval': {
      // Zwift renders a missing Cadence/CadenceResting as 0rpm rather than "unconstrained"
      // when the other one is set, so if either side has a cadence, both must be emitted.
      const hasCadence = b.onCadence || b.offCadence
      const onCadence = hasCadence ? (b.onCadence || DEFAULT_CADENCE) : null
      const offCadence = hasCadence ? (b.offCadence || DEFAULT_CADENCE) : null
      tagName = 'IntervalsT'
      open = `<IntervalsT Repeat="${b.reps}" OnDuration="${b.onDuration}" OffDuration="${b.offDuration}" OnPower="${b.onPower}" OffPower="${b.offPower}"${cadenceAttrString('Cadence', onCadence)}${cadenceAttrString('CadenceResting', offCadence)}`
      break
    }
    case 'freeride':
      tagName = 'FreeRide'
      open = `<FreeRide Duration="${b.duration}"${b.flatRoad ? ' FlatRoad="1"' : ''}${b.ftpTest ? ' ftptest="1"' : ''}`
      break
  }

  if (!b.textEvents?.length) return `    ${open}/>\n`
  let out = `    ${open}>\n`
  for (const ev of b.textEvents) {
    const attrs = Object.entries(ev.attrs).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('')
    out += `      <textevent${attrs}/>\n`
  }
  return `${out}    </${tagName}>\n`
}

export function serializeZwo(meta: ZwoMeta, blocks: readonly ZwoBlock[]): string {
  let xml = '<workout_file>\n'
  xml += `  <author>${escapeXml(meta.author || DEFAULT_AUTHOR)}</author>\n`
  xml += `  <name>${escapeXml(meta.name)}</name>\n`
  xml += `  <description>${escapeXml(meta.description)}</description>\n`
  xml += `  <sportType>${escapeXml(meta.sportType || 'bike')}</sportType>\n`
  if (meta.tags.length) {
    xml += '  <tags>\n'
    for (const t of meta.tags) xml += `    <tag name="${escapeXml(t)}"/>\n`
    xml += '  </tags>\n'
  }
  for (const [k, v] of Object.entries(meta.extraMeta)) {
    if (/^[A-Za-z_][\w.-]*$/.test(k)) xml += `  <${k}>${escapeXml(v)}</${k}>\n`
  }
  xml += '  <workout>\n'
  for (const b of blocks) xml += blockXml(b)
  xml += '  </workout>\n</workout_file>'
  return xml
}

// ── Duration / TSS ───────────────────────────────────────────────────────

interface Segment { duration: number, powerStart: number, powerEnd: number }

function blocksToSegments(blocks: readonly ZwoBlock[]): Segment[] {
  const segments: Segment[] = []
  for (const b of blocks) {
    if (b.type === 'warmup' || b.type === 'cooldown') {
      segments.push({ duration: b.duration, powerStart: b.powerStart, powerEnd: b.powerEnd })
    }
    else if (b.type === 'steady') {
      segments.push({ duration: b.duration, powerStart: b.power, powerEnd: b.power })
    }
    else if (b.type === 'freeride') {
      // No target power: contributes duration but 0 TSS.
      segments.push({ duration: b.duration, powerStart: 0, powerEnd: 0 })
    }
    else if (b.type === 'interval') {
      for (let i = 0; i < b.reps; i++) {
        segments.push({ duration: b.onDuration, powerStart: b.onPower, powerEnd: b.onPower })
        segments.push({ duration: b.offDuration, powerStart: b.offPower, powerEnd: b.offPower })
      }
    }
  }
  return segments
}

/**
 * Matches Zwift/Coggan's normalized-power algorithm: a 30 s rolling average
 * of the 1 Hz power trace, ^4, mean, 4th root. Power values are fractions of
 * FTP, so no FTP lookup is needed. Callers must have already bounded total
 * duration (parseZwo does) — the trace is one number per second.
 */
export function estimateTss(blocks: readonly ZwoBlock[]): number {
  const trace: number[] = []
  for (const seg of blocksToSegments(blocks)) {
    const wholeSecs = Math.round(seg.duration)
    for (let i = 0; i < wholeSecs; i++) {
      const frac = wholeSecs <= 1 ? 0 : i / (wholeSecs - 1)
      trace.push(seg.powerStart + (seg.powerEnd - seg.powerStart) * frac)
    }
  }
  if (trace.length === 0) return 0

  const window = 30
  let windowSum = 0
  let fourthPowerSum = 0
  for (let i = 0; i < trace.length; i++) {
    windowSum += trace[i]!
    if (i >= window) windowSum -= trace[i - window]!
    const n = Math.min(i + 1, window)
    fourthPowerSum += (windowSum / n) ** 4
  }

  const np = (fourthPowerSum / trace.length) ** 0.25
  return Math.round((trace.length / 3600) * np ** 2 * 100)
}

// ── Canonical form ───────────────────────────────────────────────────────

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Formatting-independent string form of a workout's meaning (meta + blocks).
 * Hash it to answer "do these two files describe the same workout?" — used to
 * decide that a web draft has been saved back to disk.
 */
export function zwoCanonicalString(workout: Pick<ZwoWorkout, 'meta' | 'blocks'>): string {
  return stableStringify({
    meta: { ...workout.meta, author: workout.meta.author || DEFAULT_AUTHOR },
    blocks: workout.blocks,
  })
}
