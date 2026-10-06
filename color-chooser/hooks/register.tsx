import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { SessionColor } from '../types'

// The color last set through the picker or a typed /color; null while unknown
const current = atom({ plugin: 'color-chooser', key: 'current' } as const, null)

const PANE = 'color-chooser'
const DEFAULT = 'default'

// What /color takes, in its own order
const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']
// The ones that still differ in 16 colors: orange draws as red, blue as cyan, pink as purple
const BASIC = ['red', 'green', 'yellow', 'purple', 'cyan']
// Arguments /color reads as the theme's own color
const RESETS = [DEFAULT, 'reset', 'none', 'gray', 'grey']

// Each color as the dark theme paints it: for surfaces without the theme's keys, and to pick the check's contrast
const RGB: Record<string, number> = {
  red: 0xdc2626,
  blue: 0x6a9bcc,
  green: 0x16a34a,
  yellow: 0xca8a04,
  purple: 0x827dbd,
  orange: 0xd97757,
  pink: 0xc46686,
  cyan: 0x0891b2,
}
const GRAY = 0x888888

// A swatch's size in cells, how many share a row, and the room between two
const TILE_W = 5
const TILE_H = 3
const PER_ROW = 3
const GAP = 2

// The colors on offer, settled at session start by the terminal's color depth
let choices = [...COLORS, DEFAULT]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    choices = [...((await colorLevel($)) >= 2 ? COLORS : BASIC), DEFAULT]
    // The session color shows in the terminal's prompt bar alone: elsewhere there is nothing to pick for
    if (e.surface === 'terminal') {
      await $.command.register({ name: 'colors', description: 'Pick the prompt bar color for this session' })
    }

    return next(e)
  })

  on('command.run', { command: 'colors' }, async $ => {
    await openPicker($)

    return {}
  })

  // A typed /color moves the mark in the picker too
  on('command.run', { command: 'color' }, async ($, e, next) => {
    const ran = await next(e)
    const color = chosen(e.args, ran.text)
    if (color !== undefined) {
      await update($, current, () => color)
    }

    return ran
  })

  // The palette button sits at the right end of the terminal's band, beside whatever the plugins beneath draw
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || e.surface !== 'terminal') {
      return below
    }

    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexShrink={1}>{below}</Box>
        <Button key="open" plain label="🎨" onPress={() => void openPicker($)} />
      </Box>
    )
  })

  // Swatches are painted through the theme as the prompt bar is, so the terminal's color depth treats both alike
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const Client = e.surface === 'terminal' ? $.ui.resolve(e).Client : null
    const active = await read($, current)
    const focused = active !== null && choices.includes(active) ? active : choices[0]
    const rows = Array.from({ length: Math.ceil(choices.length / PER_ROW) }, (_, row) =>
      choices.slice(row * PER_ROW, (row + 1) * PER_ROW),
    )

    return (
      <Box flexDirection="column">
        {rows.map((row, rowIndex) => (
          <Box key={`row-${rowIndex}`} flexDirection="row" columnGap={GAP}>
            {row.map((color, column) => {
              const digit = String(rowIndex * PER_ROW + column + 1)
              const isDefault = color === DEFAULT
              const paint = shade(color, e.surface)
              const check = color === active ? '✓' : isDefault ? '╱' : ' '
              const side = (isDefault ? '╱' : ' ').repeat((TILE_W - 1) / 2)

              return (
                <Box key={`tile-${color}`} flexDirection="column" width={TILE_W}>
                  {Array.from({ length: TILE_H }, (_, line) => {
                    const glyphs = line === (TILE_H - 1) / 2 ? [side, check, side] : [side + (isDefault ? '╱' : ' ') + side]

                    return (
                      <Box key={`line-${line}`} flexDirection="row">
                        {glyphs.map(text =>
                          isDefault ? (
                            <Text color={text === '✓' ? 'text' : paint}>{text}</Text>
                          ) : (
                            <Text backgroundColor={paint} color={hex(contrast(rgbOf(color)))} bold>
                              {text}
                            </Text>
                          ),
                        )}
                      </Box>
                    )
                  })}
                  {Client !== null && (
                    <Box position="absolute" top={0} left={0}>
                      <Client key={`hit-${color}`} module="./tile.tsx" props={{ color }} width={TILE_W} height={TILE_H} />
                    </Box>
                  )}
                  <Button
                    key={color}
                    hotkey={digit}
                    label={digit}
                    {...(color === focused ? { autoFocus: true as const } : {})}
                    onPress={() => void choose($, color)}
                  />
                </Box>
              )
            })}
          </Box>
        ))}
        <Text dimColor>
          {active === null ? '' : `Current: ${active} · `}Click or 1-{choices.length} · Esc closes
        </Text>
      </Box>
    )
  })

  // A click on a swatch, from the hit area laid over it
  on('ui.message', async ($, e, next) => {
    const color = picked(e.data)
    if (e.requestId === PANE && color !== null) {
      await choose($, color)
    }

    return next(e)
  })
}

async function openPicker($: EngineInterface) {
  await $.ui.open({
    id: PANE,
    title: 'Session color',
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
    rows: Math.ceil(choices.length / PER_ROW) * (TILE_H + 1) + 1,
    columns: PER_ROW * TILE_W + (PER_ROW - 1) * GAP + 2,
  })
}

async function choose($: EngineInterface, color: SessionColor) {
  await $.ui.close({ id: PANE })
  // Runs once the session is idle, so a turn in flight delays it: not awaited here
  void $.command.run({ command: 'color', args: color }).then(
    () => update($, current, () => color),
    (error: unknown) => $.ui.toast(`Could not set the color: ${error instanceof Error ? error.message : String(error)}`),
  )
}

// The color depth Claude Code draws in, by the rules of its color support: 0 none, 1 16 colors, 2 256, 3 full
async function colorLevel($: EngineInterface): Promise<number> {
  const force = await $.env.get('FORCE_COLOR')
  const forced =
    force === undefined
      ? undefined
      : force === 'true' || force === ''
        ? 1
        : force === 'false'
          ? 0
          : Math.min(Number.parseInt(force, 10), 3)
  if (forced === 0) {
    return 0
  }

  const fallback = forced || 0
  const term = (await $.env.get('TERM')) ?? ''
  if (term === 'dumb' || (await $.env.get('CI')) !== undefined) {
    return fallback
  }

  const colorterm = await $.env.get('COLORTERM')
  if (colorterm === 'truecolor') {
    return 3
  }

  const program = await $.env.get('TERM_PROGRAM')
  if (program === 'iTerm.app') {
    const major = Number.parseInt(((await $.env.get('TERM_PROGRAM_VERSION')) ?? '').split('.')[0] ?? '', 10)

    return major >= 3 ? 3 : 2
  }
  if (program === 'Apple_Terminal' || /-256(color)?$/i.test(term)) {
    return 2
  }
  if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(term) || colorterm !== undefined) {
    return 1
  }

  return fallback
}

// What a /color run left the session with: a color, null for a random one, undefined when unchanged
function chosen(args: string, text: string | undefined): SessionColor | null | undefined {
  if (text) {
    const set = /Session color set to: (\S+)/.exec(text)
    if (set) {
      return set[1]
    }

    return text.includes('reset to default') ? DEFAULT : undefined
  }

  const arg = args.trim().toLowerCase()
  if (arg === '') {
    return null
  }
  if (RESETS.includes(arg)) {
    return DEFAULT
  }

  return COLORS.includes(arg) ? arg : undefined
}

function picked(data: unknown): SessionColor | null {
  if (typeof data !== 'object' || data === null || !('pick' in data)) {
    return null
  }

  const { pick } = data

  return typeof pick === 'string' && choices.includes(pick) ? pick : null
}

// The terminal paints the theme's own keys, as the prompt bar does; other surfaces the dark theme's values
function shade(color: SessionColor, surface: RenderSurface): string {
  if (surface === 'terminal') {
    return color === DEFAULT ? 'promptBorder' : `${color}_FOR_SUBAGENTS_ONLY`
  }

  return hex(rgbOf(color))
}

function rgbOf(color: SessionColor): number {
  return RGB[color] ?? GRAY
}

// Black or white, whichever reads on the color
function contrast(rgb: number): number {
  const luma = 0.299 * ((rgb >> 16) & 0xff) + 0.587 * ((rgb >> 8) & 0xff) + 0.114 * (rgb & 0xff)

  return luma > 150 ? 0x000000 : 0xffffff
}

function hex(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`
}
