import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { SessionColor } from '../types'

// The color last set through the picker or a typed /color; null while unknown
const current = atom({ plugin: 'color-chooser', key: 'current' } as const, null)
// The latest pick whose /color still waits in the session's queue: a plugin's runs once the session is idle
const pending = atom({ plugin: 'color-chooser', key: 'pending' } as const, null)
// Whether a turn of the main loop runs
const working = atom({ plugin: 'color-chooser', key: 'working' } as const, false)
// The viaPrompt option: a pick made while a turn runs goes into the prompt box, where Enter runs /color at once
const viaPrompt = atom({ plugin: 'color-chooser', key: 'viaPrompt' } as const, false)
// The color whose /color line the picker put into the prompt box; null when none is there
const offered = atom({ plugin: 'color-chooser', key: 'offered' } as const, null)
// A /color set elsewhere while a pick waited in the queue: the queue would overturn it, so it is set again after
const restore = atom({ plugin: 'color-chooser', key: 'restore' } as const, null)

const PLUGIN = 'color-chooser'
const PANE = PLUGIN
const OPTION = 'viaPrompt'
const DEFAULT = 'default'
// The mark on the swatch the session has, and on the one that waits for the turn to end
const CHECK = '✓'
const WAIT = '…'

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
// The swatches' width, which the picker's notes wrap to
const GRID_W = PER_ROW * TILE_W + (PER_ROW - 1) * GAP

// The notes under the swatches
const WAITS = `${WAIT} set after this turn`
const HELP = 'Mid-turn, /color goes into the empty prompt; Enter applies it'

// The colors on offer, settled at session start by the terminal's color depth
let choices = [...COLORS, DEFAULT]

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    choices = [...((await colorLevel($)) >= 2 ? COLORS : BASIC), DEFAULT]
    // A change of the option in /config reloads the module, and each load starts here
    await update($, viaPrompt, () => options[OPTION] === true)
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

  // A typed /color moves the mark in the picker too. The picker's own runs are `ran`'s to mark, whether or not they
  // reach this hook: one started from a press does not, one from the click's ui.message hook does
  on('command.run', { command: 'color' }, async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind === 'plugin' && e.origin.name === PLUGIN) {
      return result
    }

    const color = chosen(e.args, result.text)
    if (color !== undefined) {
      await setElsewhere($, color)
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    await update($, working, () => true)

    return next(e)
  })

  // Subagents' turns end inside the main one: only the main loop's leaves the session idle
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, working, () => false)
    }

    return next(e)
  })

  // The palette button sits at the right end of the terminal's band, beside whatever the plugins beneath draw
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || e.surface !== 'terminal') {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const notice = await noticeOf($)

    // Beside the button, a dot in the color and a line on it stay while the person has something to wait or press for
    return (
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexShrink={1}>{below}</Box>
        <Box flexDirection="row" gap={1}>
          {notice !== null && <Text color={shade(notice.color, e.surface)}>●</Text>}
          {notice !== null && <Text>{notice.text}</Text>}
          <Button key="open" plain label="🎨" onPress={() => void openPicker($)} />
        </Box>
      </Box>
    )
  })

  // While the /color line the picker put there is in the prompt box, the hint line says what Enter does
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const color = e.props.isDraft && e.surface === 'terminal' ? await inPrompt($) : null
    if (color === null) {
      return next(e)
    }

    const tail = color === DEFAULT ? 'enter to reset the prompt bar' : `enter to set ${color}`

    return next({ ...e, props: { ...e.props, tail } })
  })

  // Swatches are painted through the theme as the prompt bar is, so the terminal's color depth treats both alike
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const Client = e.surface === 'terminal' ? $.ui.resolve(e).Client : null
    const active = await read($, current)
    const waiting = await waitingColor($)
    const isViaPrompt = await read($, viaPrompt)
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
              const check = color === active ? CHECK : color === waiting ? WAIT : isDefault ? '╱' : ' '
              const side = (isDefault ? '╱' : ' ').repeat((TILE_W - 1) / 2)

              return (
                <Box key={`tile-${color}`} flexDirection="column" width={TILE_W}>
                  {Array.from({ length: TILE_H }, (_, line) => {
                    const glyphs = line === (TILE_H - 1) / 2 ? [side, check, side] : [side + (isDefault ? '╱' : ' ') + side]

                    return (
                      <Box key={`line-${line}`} flexDirection="row">
                        {glyphs.map(text =>
                          isDefault ? (
                            <Text color={text === CHECK || text === WAIT ? 'text' : paint}>{text}</Text>
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
        {waiting !== null && <Text dimColor>{WAITS}</Text>}
        <Text dimColor>{footer(active)}</Text>
        <Box marginTop={1}>
          <Button
            key={OPTION}
            plain
            hotkey="p"
            label={toggleLabel(isViaPrompt)}
            onPress={() => void setViaPrompt($, !isViaPrompt)}
          />
        </Box>
        <Text dimColor>{HELP}</Text>
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
  const waiting = await waitingColor($)
  // The toggle's plain Button draws its hotkey before the label, a blank line above it
  const notes = [...(waiting === null ? [] : [WAITS]), footer(await read($, current)), '', `p: ${toggleLabel(true)}`, HELP]
  await $.ui.open({
    id: PANE,
    title: 'Session color',
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
    rows: Math.ceil(choices.length / PER_ROW) * (TILE_H + 1) + notes.reduce((sum, note) => sum + lines(note), 0),
    columns: GRID_W + 2,
  })
}

// The color the queue holds for the end of the running turn; null when none waits or no turn runs
async function waitingColor($: EngineInterface): Promise<SessionColor | null> {
  return (await read($, working)) ? read($, pending) : null
}

// The color whose /color line the picker put into the prompt box, while the box still holds that line as it was put
async function inPrompt($: EngineInterface): Promise<SessionColor | null> {
  const color = await read($, offered)
  if (color === null) {
    return null
  }

  return (await $.prompt.read()).text.trim() === `/color ${color}` ? color : null
}

// What the band says beside the button: Enter for a line in the prompt box comes first, then a pick the queue holds
async function noticeOf($: EngineInterface): Promise<{ color: SessionColor; text: string } | null> {
  const offer = await inPrompt($)
  if (offer !== null) {
    return { color: offer, text: offer === DEFAULT ? 'Press Enter to reset the color' : `Press Enter to set ${offer}` }
  }

  const waiting = await waitingColor($)
  if (waiting !== null) {
    return { color: waiting, text: `${waiting === DEFAULT ? 'default color' : waiting} once Claude is done` }
  }

  return null
}

async function choose($: EngineInterface, color: SessionColor) {
  await $.ui.close({ id: PANE })
  // A plugin's /color runs once the session is idle, unlike a typed one: while a turn runs, offer it in the prompt
  // box when the option asks for that, or say that it waits
  if (await read($, working)) {
    const offer = (await read($, viaPrompt)) ? await fillPrompt($, color) : 'off'
    if (offer === 'filled') {
      return
    }

    const later =
      color === DEFAULT ? 'The prompt bar resets once Claude is done' : `The prompt bar turns ${color} once Claude is done`
    $.ui.toast(offer === 'draft' ? `Prompt not empty. ${later}` : later, { timeoutMs: 6000 })
  }

  // The newest pick runs after all the queue holds, so nothing set before it needs setting again
  await update($, pending, () => color)
  await update($, restore, () => null)
  run($, color)
}

// Not awaited, as a turn in flight holds it in the queue until the session is idle
function run($: EngineInterface, color: SessionColor) {
  void $.command.run({ command: 'color', args: color }).then(
    () => ran($, color),
    async (error: unknown) => {
      await update($, pending, waiting => (waiting === color ? null : waiting))
      $.ui.toast(`Could not set the color: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
}

// The queue ran a pick: the check moves to it. A /color set elsewhere after the pick was queued is the later choice: once
// no pick waits any more, it is set again over what the queue ran
async function ran($: EngineInterface, color: SessionColor) {
  await update($, current, () => color)
  await update($, pending, waiting => (waiting === color ? null : waiting))
  const later = await read($, restore)
  if (later !== null && (await read($, pending)) === null) {
    await update($, restore, () => null)
    run($, later)
  }
}

// A /color the picker did not run, typed or sent from the prompt box: the check moves to it, the line the picker put
// there is spent, and a pick still waiting in the queue no longer stands
async function setElsewhere($: EngineInterface, color: SessionColor | null) {
  await update($, current, () => color)
  await update($, offered, () => null)
  if (color !== null && (await read($, pending)) !== null) {
    await update($, pending, () => null)
    await update($, restore, () => color)
  }
}

// Puts the /color line into the prompt box, where Enter runs it at once. Never over a draft of the person's: only into
// an empty box, or over the line it put there before
async function fillPrompt($: EngineInterface, color: SessionColor): Promise<'filled' | 'draft' | 'refused'> {
  const before = await read($, offered)
  const draft = (await $.prompt.read()).text.trim()
  if (draft !== '' && (before === null || draft !== `/color ${before}`)) {
    return 'draft'
  }

  const { isFilled } = await $.prompt.fill({ text: `/color ${color}` })
  if (!isFilled) {
    return 'refused'
  }

  await update($, offered, () => color)
  $.ui.toast(color === DEFAULT ? 'Press Enter to reset the prompt bar now' : `Press Enter to set ${color} now`, {
    timeoutMs: 6000,
  })

  return 'filled'
}

// The option lives in the plugin's settings, where /config shows it too
async function setViaPrompt($: EngineInterface, value: boolean) {
  try {
    const set = await $.config.set({ key: `${PLUGIN}.${OPTION}`, value })
    if (set.deny !== undefined) {
      $.ui.toast(`Could not change the setting: ${set.deny}`)

      return
    }

    await update($, viaPrompt, () => value)
  } catch (error: unknown) {
    $.ui.toast(`Could not change the setting: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function footer(active: SessionColor | null): string {
  return `${active === null ? '' : `Current: ${active} · `}Click or 1-${choices.length} · Esc closes`
}

function toggleLabel(isOn: boolean): string {
  return `[${isOn ? 'x' : ' '}] Via prompt`
}

// The rows a note takes under the swatches, a blank one included
function lines(note: string): number {
  return Math.max(1, Math.ceil(note.length / GRID_W))
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
