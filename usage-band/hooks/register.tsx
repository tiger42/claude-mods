import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { UsageReading, UsageWindow } from '../types'

// The latest reading this session knows, from its own responses or another session's
const reading = atom({ plugin: 'usage-band', key: 'reading' } as const, null)

// Every session writes its readings here, so a fresh session starts with the last one
const STORE_KEY = 'reading'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const STALE_AFTER = 15 * MINUTE

// How long each window runs: places the pace marker and drives the forecast
const SPANS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * DAY }
const ORDER = ['five_hour', 'seven_day']
const PILLS: Record<string, { label: string; color: string }> = {
  five_hour: { label: ' 5-hour ', color: '#7c3aed' },
  seven_day: { label: ' Weekly ', color: '#0369a1' },
}

// The bar's colors from empty to full: cyan, green, yellow, orange, rose, fuchsia
const STOPS: [number, number][] = [
  [0, 0x22d3ee],
  [0.3, 0x4ade80],
  [0.55, 0xfacc15],
  [0.75, 0xfb923c],
  [0.9, 0xf43f5e],
  [1, 0xd946ef],
]
const TRACK = 0x30303c
const MARKER = 0xffffff
const DEFAULT = 0x01000000
const SPACE = 0x20
const BLOCK = 0x2588
const TICK = 0x2502
// ▏▎▍▌▋▊▉: the cell the fill ends in
const EIGHTHS = [0x258f, 0x258e, 0x258d, 0x258c, 0x258b, 0x258a, 0x2589]

// Column widths of a row: pill, percent, countdown, forecast
const PILL_W = 8
const PCT_W = 4
const RESET_W = 8
const PACE_W = 22
const MAX_BAR = 48

// The desktop's bar is an SVG: CSS pixels per cell of bar width, its height and the track's inset from it
const CELL_PX = 7
const BAR_H = 14
const BAR_INSET = 2

type Bar = { key: string; width: number; used: number; marker: number | null }
type Row = {
  kind: string
  label: string
  pill: string
  used: number
  tip: string
  reset: string
  elapsed: number | null
  pace: { text: string; color: string } | null
}

// What the band drew last, for the shimmer to repaint
let site: { requestId: string; bars: Bar[] } | null = null
let shimmer: Timer | null = null
let frame = 0
const turns = new Set<string>()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await sync($)
    // Picks up readings of other sessions and moves the countdowns on
    $.clock.every(30_000, () => void tick($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0) {
      const fresh: UsageReading = {
        at: await $.clock.now(),
        windows: e.rateLimits.map(w => ({
          kind: w.kind,
          percentUsed: w.percentUsed,
          ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }),
        })),
      }
      await update($, reading, () => fresh)
      await $.store.set(STORE_KEY, fresh)
    }

    return next(e)
  })

  // A light runs along the filled part of the bars while Claude works
  on('turn.start', async ($, e, next) => {
    turns.add(e.turnId)
    if (shimmer === null) {
      frame = 0
      shimmer = $.clock.every(80, () => void shine($))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    turns.delete(e.turnId)
    if (turns.size === 0 && shimmer !== null) {
      shimmer.cancel()
      shimmer = null
      // A redraw with unchanged cells keeps the last shimmer frame: paint the plain bars back
      await settle($)
    }

    return next(e)
  })

  // The band is shared: what the plugins beneath draw there stays, beside the bars or under them where there is no room
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const data = await read($, reading)
    if (e.props.hasSurvey || data === null || data.windows.length === 0) {
      site = null

      return next(e)
    }

    const below = await next(e)
    const now = await $.clock.now()
    const rows = sorted(data.windows).map(w => describe(w, now))
    const hasPace = e.props.bodyColumns - (PILL_W + PCT_W + RESET_W + PACE_W + 4) >= 12
    const fixed = hasPace ? PILL_W + PCT_W + RESET_W + PACE_W + 4 : PILL_W + PCT_W + RESET_W + 3
    const width = Math.max(6, Math.min(MAX_BAR, e.props.bodyColumns - fixed))
    const lines = rows.map(row => ({
      row,
      bar: {
        key: `bar-${row.kind}`,
        width,
        used: row.used,
        marker: row.elapsed === null ? null : Math.min(width - 1, Math.floor(row.elapsed * width)),
      },
    }))
    const { Box, Text } = $.ui.resolve(e)
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : null
    const Svg = e.surface === 'desktop' ? $.ui.resolve(e).Svg : null
    const age = now - data.at

    // Only the terminal's Rasters take the shimmer's frames
    if (Raster !== null) {
      site = { requestId: e.requestId, bars: lines.map(line => line.bar) }
    }

    return (
      <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={1}>
        <Box flexDirection="column">
          {lines.map(({ row, bar }) =>
            Raster !== null ? (
              <Box flexDirection="row" gap={1}>
                <Text backgroundColor={row.pill} color="#ffffff" bold>
                  {row.label}
                </Text>
                <Raster key={bar.key} columns={width} rows={1} cells={cells(bar, null)} />
                <Text color={row.tip} bold>
                  {`${Math.round(row.used)}%`.padStart(PCT_W)}
                </Text>
                <Text dimColor>{row.reset.padEnd(RESET_W)}</Text>
                {hasPace && row.pace !== null && <Text color={row.pace.color}>{row.pace.text}</Text>}
              </Box>
            ) : (
              // The desktop sets a proportional font and folds runs of spaces: boxes of fixed width keep the columns
              <Box flexDirection="row" alignItems="center" gap={1}>
                <Box width={PILL_W} justifyContent="center" backgroundColor={row.pill}>
                  <Text color="#ffffff" bold>
                    {row.label.trim()}
                  </Text>
                </Box>
                {Svg !== null && (
                  <Svg source={svg(row, width)} alt={describeBar(row)} width={width * CELL_PX} height={BAR_H} />
                )}
                {/* A proportional "100%" runs wider than four cells */}
                <Box minWidth={PCT_W + 1} justifyContent="flex-end">
                  <Text color={row.tip} bold>{`${Math.round(row.used)}%`}</Text>
                </Box>
                <Box minWidth={RESET_W}>
                  <Text dimColor>{row.reset}</Text>
                </Box>
                {hasPace && row.pace !== null && <Text color={row.pace.color}>{row.pace.text}</Text>}
              </Box>
            ),
          )}
          {age > STALE_AFTER && (
            <Text dimColor italic>
              As of {duration(age)} ago · updates with the next response
            </Text>
          )}
        </Box>
        {below}
      </Box>
    )
  })
}

async function tick($: EngineInterface) {
  await sync($)
  $.ui.invalidate('ui.render')
}

// Takes the stored reading when it is newer than the one this session holds
async function sync($: EngineInterface) {
  const stored = asReading(await $.store.get(STORE_KEY))
  const current = await read($, reading)
  if (stored !== null && (current === null || stored.at > current.at)) {
    await update($, reading, () => stored)
  }
}

async function shine($: EngineInterface) {
  if (site === null) {
    return
  }

  frame += 1
  const { requestId, bars } = site
  for (const [index, bar] of bars.entries()) {
    const fill = (Math.min(bar.used, 100) / 100) * bar.width
    if (fill < 1) {
      continue
    }

    // The turn may have ended while the bar before was painted
    if (shimmer === null) {
      return
    }

    const sweep = Math.ceil(fill) + 10
    const head = ((frame + index * 5) % sweep) - 4
    await $.ui.blit({ requestId, key: bar.key, cells: cells(bar, head), columns: bar.width, rows: 1 })
  }
}

async function settle($: EngineInterface) {
  if (site === null) {
    return
  }

  const { requestId, bars } = site
  for (const bar of bars) {
    await $.ui.blit({ requestId, key: bar.key, cells: cells(bar, null), columns: bar.width, rows: 1 })
  }
}

function asReading(value: unknown): UsageReading | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const { at, windows } = value as Partial<UsageReading>
  if (typeof at !== 'number' || !Array.isArray(windows)) {
    return null
  }

  return { at, windows: windows.filter(w => typeof w?.kind === 'string' && typeof w.percentUsed === 'number') }
}

function sorted(windows: UsageWindow[]): UsageWindow[] {
  const rank = (kind: string) => (ORDER.includes(kind) ? ORDER.indexOf(kind) : ORDER.length)

  return [...windows].sort((a, b) => rank(a.kind) - rank(b.kind))
}

function describe(w: UsageWindow, now: number): Row {
  const pill = PILLS[w.kind] ?? {
    label: ` ${w.kind.replace(/_/g, ' ').slice(0, PILL_W - 2).padEnd(PILL_W - 2)} `,
    color: '#475569',
  }
  const left = w.resetsAt === undefined ? NaN : Date.parse(w.resetsAt) - now
  const hasReset = left <= 0
  const used = hasReset ? 0 : w.percentUsed
  const span = SPANS[w.kind]
  const elapsed =
    span === undefined || Number.isNaN(left) || hasReset ? null : Math.min(1, Math.max(0, 1 - left / span))

  return {
    kind: w.kind,
    label: pill.label,
    pill: pill.color,
    used,
    tip: hex(colorAt(Math.min(used, 100) / 100)),
    reset: hasReset ? '↻ reset' : Number.isNaN(left) ? '' : `↻ ${duration(left)}`,
    elapsed,
    pace: hasReset ? null : forecast(used, elapsed, span),
  }
}

// Where the window ends up at the current rate: the share at reset, or when it runs full
function forecast(used: number, elapsed: number | null, span: number | undefined) {
  if (used >= 100) {
    return { text: '■ Limit reached', color: '#f43f5e' }
  }

  if (elapsed === null || span === undefined || elapsed < 0.03 || used < 1) {
    return null
  }

  const projected = used / elapsed
  if (projected <= 100) {
    return { text: `→ ~${Math.round(projected)}% at reset`, color: projected < 80 ? '#4ade80' : '#facc15' }
  }

  return { text: `▲ full in ${duration(((100 - used) / used) * elapsed * span)}`, color: '#fb923c' }
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE))
  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  }

  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

// One row of Raster cells: the gradient up to the fill, the track after it, the pace marker
function cells(bar: Bar, head: number | null): string {
  const words = new Uint32Array(bar.width * 3)
  const fill = (Math.min(bar.used, 100) / 100) * bar.width
  const whole = Math.floor(fill)
  const eighths = Math.round((fill - whole) * 8)

  for (let i = 0; i < bar.width; i++) {
    const color = glow(colorAt(bar.width > 1 ? i / (bar.width - 1) : 1), i, head)
    let glyph = SPACE
    let fg = DEFAULT
    let bg = TRACK

    if (i < whole || (i === whole && eighths === 8)) {
      glyph = BLOCK
      fg = color
      bg = color
    } else if (i === whole && eighths > 0) {
      glyph = EIGHTHS[eighths - 1] ?? BLOCK
      fg = color
    }

    if (i === bar.marker) {
      glyph = TICK
      fg = MARKER
    }

    words.set([glyph, fg, bg], i * 3)
  }

  return base64(new Uint8Array(words.buffer))
}

// The desktop's bar: the gradient up to the fill over a track, the pace marker a white line with a dark edge that shows in either theme
function svg(row: Row, width: number): string {
  const w = width * CELL_PX
  const fill = round((Math.min(row.used, 100) / 100) * w)
  const track = BAR_H - 2 * BAR_INSET
  const stops = STOPS.map(([at, color]) => `<stop offset="${at}" stop-color="${hex(color)}"/>`).join('')
  const x = row.elapsed === null ? null : round(Math.min(w - 2, Math.max(2, row.elapsed * w)))
  const marker =
    x === null
      ? ''
      : `<rect x="${round(x - 1.5)}" width="3" height="${BAR_H}" rx="1" fill="#1e1e2a" fill-opacity="0.6"/>` +
        `<rect x="${round(x - 0.5)}" y="1" width="1" height="${BAR_H - 2}" fill="#ffffff"/>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${BAR_H}" viewBox="0 0 ${w} ${BAR_H}">` +
    `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${w}" y2="0">${stops}</linearGradient>` +
    `<clipPath id="c"><rect y="${BAR_INSET}" width="${w}" height="${track}" rx="${track / 2}"/></clipPath></defs>` +
    `<g clip-path="url(#c)"><rect width="${w}" height="${BAR_H}" fill="#8b8ba0" fill-opacity="0.3"/>` +
    `<rect width="${fill}" height="${BAR_H}" fill="url(#g)"/></g>${marker}</svg>`
  )
}

function describeBar(row: Row): string {
  const elapsed = row.elapsed === null ? '' : `, ${Math.round(row.elapsed * 100)}% of the window elapsed`

  return `${row.label.trim()}: ${Math.round(row.used)}% used${elapsed}`
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}

function colorAt(t: number): number {
  let from = 0
  let start = 0
  for (const [to, end] of STOPS) {
    if (t <= to) {
      return to === from ? end : mix(start, end, (t - from) / (to - from))
    }
    from = to
    start = end
  }

  return start
}

function glow(color: number, i: number, head: number | null): number {
  if (head === null) {
    return color
  }

  const distance = Math.abs(i - head)

  return distance >= 3 ? color : mix(color, 0xffffff, (1 - distance / 3) * 0.6)
}

function mix(a: number, b: number, t: number): number {
  const channel = (shift: number) => {
    const from = (a >> shift) & 0xff
    const to = (b >> shift) & 0xff

    return Math.round(from + (to - from) * t) << shift
  }

  return channel(16) | channel(8) | channel(0)
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? ALPHABET.charAt((n >> 6) & 63) : '='
    out += i + 2 < bytes.length ? ALPHABET.charAt(n & 63) : '='
  }

  return out
}
