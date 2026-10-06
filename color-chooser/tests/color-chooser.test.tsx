import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'color-chooser'
const SURFACES = ['terminal', 'desktop'] as const
const ALL = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan', 'default']
const BASIC = ['red', 'green', 'yellow', 'purple', 'cyan', 'default']

// The terminals the session may run in, by what Claude Code reads of the environment
const TRUECOLOR = { TERM: 'xterm', COLORTERM: 'truecolor' }
const COLORS_256 = { TERM: 'xterm-256color' }
const COLORS_16 = { TERM: 'xterm' }

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}

// A slash command as the person types it
const TYPED = { args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

const PICKER = {
  title: 'Session color',
  isFocused: true,
  bodyColumns: 21,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 13 },
  view: {},
}

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

// What the engine answers beneath the plugin, each call recorded; `below` stands for another plugin's band
function beneath(on: On, env: Record<string, string> = TRUECOLOR, below?: string) {
  const calls = { registered: [] as string[], opened: [] as string[], closed: [] as string[], colors: [] as string[] }

  mock.env(on, env)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    calls.registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('ui.open', (_$, e) => {
    calls.opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    calls.closed.push(e.id)

    return { value: undefined }
  })
  on('command.run', { command: 'color' }, (_$, e) => {
    calls.colors.push(e.args)

    return { text: `Session color set to: ${e.args}` }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return below === undefined ? <Box /> : <Box><Text>{below}</Text></Box>
  })

  return calls
}

test('the palette button sits beside what the band holds and opens the picker', async ($, on) => {
  const calls = beneath(on, TRUECOLOR, 'usage bars')
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ type: 'Text', text: 'usage bars' })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'open' }))?.props.label).toBe('🎨')

  await ui.press({ key: 'open' })
  expect(calls.opened).toEqual([PLUGIN])
})

test('surfaces without the prompt bar get no palette button, only what the band holds', async ($, on) => {
  beneath(on, TRUECOLOR, 'usage bars')
  await $.session.start(START)

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })

    expect(await ui.find({ type: 'Text', text: 'usage bars' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'open' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the band yields to a survey', async ($, on) => {
  beneath(on)
  await $.session.start(START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'AbovePrompt',
      props: { ...BAND, hasSurvey: true },
    })

    expect(await ui.find({ type: 'Button', key: 'open' })).toBeUndefined()
    await ui.unmount()
  }
})

test('/colors opens the picker', async ($, on) => {
  const calls = beneath(on)
  await $.session.start(START)
  await $.command.run({ ...TYPED, command: 'colors' })

  expect(calls.registered).toEqual(['colors'])
  expect(calls.opened).toEqual([PLUGIN])
})

test('a session that starts outside the terminal gets no /colors', async ($, on) => {
  const calls = beneath(on)
  await $.session.start({ ...START, surface: null, isInteractive: false })

  expect(calls.registered).toEqual([])
})

for (const [depth, env, offered] of [
  ['full color', TRUECOLOR, ALL],
  ['256 colors', COLORS_256, ALL],
  ['16 colors', COLORS_16, BASIC],
] as const) {
  test(`in ${depth} the picker offers ${offered.length} swatches, three to a row`, async ($, on) => {
    beneath(on, env)
    await $.session.start(START)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PICKER })
      const buttons = await ui.findAll({ type: 'Button' })
      const digits = offered.map((_, index) => String(index + 1))

      expect(buttons.map(found => found.key)).toEqual([...offered])
      expect(buttons.map(found => found.props.label)).toEqual(digits)
      expect(buttons.map(found => found.props.hotkey)).toEqual(digits)

      const rows = (await ui.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-'))
      expect(rows).toHaveLength(Math.ceil(offered.length / 3))

      // The click areas over the swatches live on the terminal alone
      expect(await ui.findAll({ type: 'Client' })).toHaveLength(surface === 'terminal' ? offered.length : 0)
      await ui.unmount()
    }
  })
}

test('the terminal paints swatches with the theme keys the prompt bar uses, other surfaces with hex', async ($, on) => {
  beneath(on)
  await $.session.start(START)

  const terminal = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PICKER })
  const painted = (await terminal.findAll({ type: 'Text' })).map(found => found.props.backgroundColor)
  expect(painted).toContain('pink_FOR_SUBAGENTS_ONLY')
  expect(painted).toContain('orange_FOR_SUBAGENTS_ONLY')
  const hatch = (await terminal.findAll({ type: 'Text', text: /╱/ })).map(found => found.props.color)
  expect(hatch).toContain('promptBorder')
  await terminal.unmount()

  const desktop = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: PLUGIN, props: PICKER })
  expect((await desktop.findAll({ type: 'Text' })).map(found => found.props.backgroundColor)).toContain('#c46686')
})

test('a pressed button closes the picker, sets the color and marks it', async ($, on) => {
  const calls = beneath(on)
  await $.session.start(START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PICKER })
    await ui.press({ key: 'pink' })
    await ui.unmount()
  }

  expect(calls.closed).toEqual([PLUGIN, PLUGIN])
  expect(calls.colors).toEqual(['pink', 'pink'])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PICKER })

    expect((await ui.find({ type: 'Button', key: 'pink' }))?.props.autoFocus).toBe(true)
    const checks = await ui.findAll({ type: 'Text', text: '✓' })
    expect(checks).toHaveLength(1)
    expect(checks[0]?.props.backgroundColor).toBe(surface === 'terminal' ? 'pink_FOR_SUBAGENTS_ONLY' : '#c46686')
    await ui.unmount()
  }
})

test('a click on a swatch picks its color', async ($, on) => {
  const calls = beneath(on)
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PICKER })
  await ui.resize({ columns: 5, rows: 3, in: 'hit-orange' })
  await ui.pointer({ type: 'down', x: 2, y: 1, button: 'left', in: 'hit-orange' })
  // Released outside the swatch: no pick
  await ui.pointer({ type: 'up', x: 9, y: 1, button: 'left', in: 'hit-orange' })
  expect(calls.colors).toEqual([])

  await ui.pointer({ type: 'down', x: 2, y: 1, button: 'left', in: 'hit-orange' })
  await ui.pointer({ type: 'up', x: 3, y: 2, button: 'left', in: 'hit-orange' })

  expect(calls.closed).toEqual([PLUGIN])
  expect(calls.colors).toEqual(['orange'])
})

test('a color the picker does not offer is never set from a click', async ($, on) => {
  const calls = beneath(on, COLORS_16)
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PICKER })
  await ui.post({ pick: 'orange' }, { in: 'hit-red' })

  expect(calls.colors).toEqual([])
})

test('a typed /color moves the mark', async ($, on) => {
  beneath(on)
  await $.session.start(START)
  await $.command.run({ ...TYPED, command: 'color', args: 'cyan' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PICKER })

    expect((await ui.find({ type: 'Button', key: 'cyan' }))?.props.autoFocus).toBe(true)
    expect((await ui.find({ type: 'Button', key: 'red' }))?.props.autoFocus).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Current: cyan/ })).toBeDefined()
    await ui.unmount()
  }
})
