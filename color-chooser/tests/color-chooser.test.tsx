import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

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

// A turn of the main loop, and its end
const TURN = { text: 'Refactor the parser', turnId: 'turn-1' }
const DONE = { answer: 'Done.', durationMs: 60_000, isAborted: false, turnId: 'turn-1', reason: 'answer' } as const
// How long the queue holds a plugin's /color picked mid-turn: the test moves the clock past it once the turn has ended
const QUEUED = 1000

const HINT = { isDraft: true, isWorking: true, hint: 'esc to interrupt' }

type World = {
  env?: Record<string, string>
  // Another plugin's band
  below?: string
  // With it, a plugin's /color picked while a turn runs waits on this clock, as the session's queue holds it until idle
  queue?: MockClock
  // What the person has typed in the prompt box
  draft?: string
}

// What the engine answers beneath the plugin, each call recorded
function beneath(on: On, { env = TRUECOLOR, below, queue, draft = '' }: World = {}) {
  const calls = {
    registered: [] as string[],
    opened: [] as string[],
    closed: [] as string[],
    colors: [] as string[],
    toasts: [] as string[],
    fills: [] as string[],
    configs: [] as { key: string; value: unknown }[],
    prompt: { text: draft },
  }
  let isWorking = false

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
  on('command.run', { command: 'color' }, async (_$, e) => {
    if (queue !== undefined && isWorking && e.origin.kind === 'plugin') {
      await queue.sleep(QUEUED)
    }
    calls.colors.push(e.args)

    return { text: e.args === 'default' ? 'Session color reset to default' : `Session color set to: ${e.args}` }
  })
  on('ui.toast', (_$, e) => {
    calls.toasts.push(e.text)

    return { value: undefined }
  })
  on('turn.start', (_$, e) => {
    isWorking = true

    return { turnId: e.turnId }
  })
  on('turn.complete', (_$, e) => {
    isWorking = isWorking && e.agentId !== undefined

    return { text: e.answer }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return below === undefined ? <Box /> : <Box><Text>{below}</Text></Box>
  })
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.tail === undefined ? e.props.hint : `${e.props.hint} · ${e.props.tail}`}</Text>
  })
  on('prompt.read', () => ({ value: { text: calls.prompt.text, cursor: calls.prompt.text.length } }))
  on('prompt.fill', (_$, e) => {
    calls.fills.push(e.text)
    calls.prompt.text = e.text

    return { isFilled: true }
  })
  on('config.set', (_$, e) => {
    calls.configs.push({ key: e.key, value: e.value })

    return { value: e.value }
  })

  return calls
}

async function pick($: Engine, color: string) {
  const picker = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PICKER })
  await picker.press({ key: color })
  await picker.unmount()
}

async function checked($: Engine) {
  const picker = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PICKER })
  const marks = (await picker.findAll({ type: 'Text', text: '✓' })).map(found => found.props.backgroundColor)
  await picker.unmount()

  return marks
}

test('the palette button sits beside what the band holds and opens the picker', async ($, on) => {
  const calls = beneath(on, { below: 'usage bars' })
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ type: 'Text', text: 'usage bars' })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'open' }))?.props.label).toBe('🎨')

  await ui.press({ key: 'open' })
  expect(calls.opened).toEqual([PLUGIN])
})

test('surfaces without the prompt bar get no palette button, only what the band holds', async ($, on) => {
  beneath(on, { below: 'usage bars' })
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
    beneath(on, { env })
    await $.session.start(START)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PICKER })
      const buttons = (await ui.findAll({ type: 'Button' })).filter(found => found.key !== 'viaPrompt')
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
  expect(calls.toasts).toEqual([])

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
  const calls = beneath(on, { env: COLORS_16 })
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

test('a color picked while Claude works waits for the turn to end, and says so meanwhile', async ($, on) => {
  const queue = mock.clock(on)
  const calls = beneath(on, { queue })
  await $.session.start(START)
  await $.turn.start(TURN)

  const picker = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PICKER })
  await picker.press({ key: 'red' })
  await picker.unmount()

  expect(calls.closed).toEqual([PLUGIN])
  expect(calls.colors).toEqual([])
  expect(calls.toasts).toEqual(['The prompt bar turns red once Claude is done'])

  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.find({ type: 'Text', text: '●' }))?.props.color).toBe('red_FOR_SUBAGENTS_ONLY')
  expect(await band.find({ type: 'Text', text: 'red once Claude is done' })).toBeDefined()
  await band.unmount()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PICKER })
    const waits = await ui.findAll({ type: 'Text', text: /^…$/ })

    expect(waits).toHaveLength(1)
    expect(waits[0]?.props.backgroundColor).toBe(surface === 'terminal' ? 'red_FOR_SUBAGENTS_ONLY' : '#dc2626')
    expect(await ui.findAll({ type: 'Text', text: '✓' })).toHaveLength(0)
    expect(await ui.find({ type: 'Text', text: /set after this turn/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete(DONE)
  await queue.advance(QUEUED)
  expect(calls.colors).toEqual(['red'])

  const after = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await after.find({ type: 'Text', text: '●' })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /once Claude is done/ })).toBeUndefined()
  await after.unmount()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PICKER })

    expect(await ui.findAll({ type: 'Text', text: /^…$/ })).toHaveLength(0)
    expect((await ui.findAll({ type: 'Text', text: '✓' }))[0]?.props.backgroundColor).toBe(
      surface === 'terminal' ? 'red_FOR_SUBAGENTS_ONLY' : '#dc2626',
    )
    expect(await ui.find({ type: 'Text', text: /set after this turn/ })).toBeUndefined()
    await ui.unmount()
  }
})

test("a subagent's turn ending inside the main one leaves the pick waiting", async ($, on) => {
  const queue = mock.clock(on)
  const calls = beneath(on, { queue })
  await $.session.start(START)
  await $.turn.start(TURN)
  await $.turn.complete({ ...DONE, turnId: 'turn-2', agentId: 'agent-1' })

  const picker = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PICKER })
  await picker.press({ key: 'default' })
  await picker.unmount()

  expect(calls.colors).toEqual([])
  expect(calls.toasts).toEqual(['The prompt bar resets once Claude is done'])

  await $.turn.complete(DONE)
  await queue.advance(QUEUED)
  expect(calls.colors).toEqual(['default'])

  // Idle again: the next pick is set at once, with no toast
  const again = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PICKER })
  await again.press({ key: 'cyan' })

  expect(calls.colors).toEqual(['default', 'cyan'])
  expect(calls.toasts).toHaveLength(1)
})

test('two picks while Claude works: the queue runs both, so the later one stands', async ($, on) => {
  const queue = mock.clock(on)
  const calls = beneath(on, { queue })
  await $.session.start(START)
  await $.turn.start(TURN)

  await pick($, 'red')
  await pick($, 'blue')

  await $.turn.complete(DONE)
  await queue.advance(QUEUED)

  expect(calls.colors).toEqual(['red', 'blue'])
  expect(await checked($)).toEqual(['blue_FOR_SUBAGENTS_ONLY'])
})

test('the picker toggles the viaPrompt option in the settings and stays open', async ($, on) => {
  const calls = beneath(on)
  await $.session.start(START)

  for (const [value, label] of [
    [true, '[x] Via prompt'],
    [false, '[ ] Via prompt'],
  ] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PICKER })
    const toggle = await ui.find({ type: 'Button', key: 'viaPrompt' })

    expect(toggle?.props.hotkey).toBe('p')
    expect(toggle?.props.label).toBe(value ? '[ ] Via prompt' : '[x] Via prompt')
    expect(await ui.find({ type: 'Text', text: /Enter applies it/ })).toBeDefined()

    await ui.press({ key: 'viaPrompt' })
    await ui.unmount()

    expect(calls.configs.at(-1)).toEqual({ key: 'color-chooser.viaPrompt', value })
    const again = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PICKER })
    expect((await again.find({ type: 'Button', key: 'viaPrompt' }))?.props.label).toBe(label)
    await again.unmount()
  }

  expect(calls.closed).toEqual([])
})

test('the option as stored shows checked in the picker', { options: { viaPrompt: true } }, async ($, on) => {
  beneath(on)
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PICKER })
  expect((await ui.find({ type: 'Button', key: 'viaPrompt' }))?.props.label).toBe('[x] Via prompt')
})

test('via prompt, a color picked mid-turn goes into the empty prompt and Enter sets it at once', { options: { viaPrompt: true } }, async ($, on) => {
  const queue = mock.clock(on)
  const calls = beneath(on, { queue })
  await $.session.start(START)
  await $.turn.start(TURN)

  await pick($, 'red')

  expect(calls.closed).toEqual([PLUGIN])
  expect(calls.fills).toEqual(['/color red'])
  expect(calls.toasts).toEqual(['Press Enter to set red now'])
  expect(calls.colors).toEqual([])

  const hint = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'PromptHint', props: HINT })
  expect(await hint.find({ type: 'Text', text: 'esc to interrupt · enter to set red' })).toBeDefined()
  await hint.unmount()

  // The band says it too, where it stays until the line is sent
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.find({ type: 'Text', text: '●' }))?.props.color).toBe('red_FOR_SUBAGENTS_ONLY')
  expect(await band.find({ type: 'Text', text: 'Press Enter to set red' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /once Claude is done/ })).toBeUndefined()
  await band.unmount()

  // Enter sends the line: a typed /color runs at once, mid-turn
  await $.command.run({ ...TYPED, command: 'color', args: 'red' })
  expect(calls.colors).toEqual(['red'])
  expect(await checked($)).toEqual(['red_FOR_SUBAGENTS_ONLY'])

  const sent = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await sent.find({ type: 'Text', text: '●' })).toBeUndefined()
  expect(await sent.find({ type: 'Text', text: /Press Enter/ })).toBeUndefined()
  await sent.unmount()

  const after = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'PromptHint', props: HINT })
  expect(await after.find({ type: 'Text', text: /enter to set/ })).toBeUndefined()
  await after.unmount()

  // Idle again, a pick is set at once, never through the prompt
  await $.turn.complete(DONE)
  await pick($, 'green')
  expect(calls.colors).toEqual(['red', 'green'])
  expect(calls.fills).toEqual(['/color red'])
})

test('via prompt, a later pick replaces the line the picker put there, not a draft', { options: { viaPrompt: true } }, async ($, on) => {
  const calls = beneath(on)
  await $.session.start(START)
  await $.turn.start(TURN)

  await pick($, 'red')
  await pick($, 'default')
  expect(calls.fills).toEqual(['/color red', '/color default'])
  expect(calls.toasts.at(-1)).toBe('Press Enter to reset the prompt bar now')

  const hint = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'PromptHint', props: HINT })
  expect(await hint.find({ type: 'Text', text: /enter to reset the prompt bar/ })).toBeDefined()
  await hint.unmount()

  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: 'Press Enter to reset the color' })).toBeDefined()
  await band.unmount()

  // The person typed over the line: neither the hint nor the band speaks for it any more
  calls.prompt.text = '/color default and more'
  const edited = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'PromptHint', props: HINT })
  expect(await edited.find({ type: 'Text', text: /enter to/ })).toBeUndefined()
  const bandEdited = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await bandEdited.find({ type: 'Text', text: /Press Enter/ })).toBeUndefined()
})

test('via prompt, a draft in the prompt is never replaced: the color waits for the turn instead', { options: { viaPrompt: true } }, async ($, on) => {
  const queue = mock.clock(on)
  const calls = beneath(on, { queue, draft: 'fix the flaky test' })
  await $.session.start(START)
  await $.turn.start(TURN)

  await pick($, 'red')

  expect(calls.fills).toEqual([])
  expect(calls.toasts).toEqual(['Prompt not empty. The prompt bar turns red once Claude is done'])

  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.find({ type: 'Text', text: '●' }))?.props.color).toBe('red_FOR_SUBAGENTS_ONLY')
  expect(await band.find({ type: 'Text', text: 'red once Claude is done' })).toBeDefined()
  await band.unmount()

  // The draft sent, the next pick goes into the prompt and Enter sets it at once
  calls.prompt.text = ''
  await pick($, 'blue')
  expect(calls.fills).toEqual(['/color blue'])
  await $.command.run({ ...TYPED, command: 'color', args: 'blue' })
  expect(calls.colors).toEqual(['blue'])

  // Blue is the later choice: nothing waits any more, and once the queue has run red, blue is set again
  const band2 = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band2.find({ type: 'Text', text: '●' })).toBeUndefined()
  await band2.unmount()

  await $.turn.complete(DONE)
  await queue.advance(QUEUED)

  expect(calls.colors).toEqual(['blue', 'red', 'blue'])
  expect(await checked($)).toEqual(['blue_FOR_SUBAGENTS_ONLY'])
})

test('a /color typed while a pick waits in the queue is set again once the queue has run the pick', async ($, on) => {
  const queue = mock.clock(on)
  const calls = beneath(on, { queue })
  await $.session.start(START)
  await $.turn.start(TURN)

  await pick($, 'red')
  await $.command.run({ ...TYPED, command: 'color', args: 'green' })

  await $.turn.complete(DONE)
  await queue.advance(QUEUED)

  expect(calls.colors).toEqual(['green', 'red', 'green'])
  expect(await checked($)).toEqual(['green_FOR_SUBAGENTS_ONLY'])

  // Done: the next pick is set once, with nothing set again after it
  await pick($, 'cyan')
  expect(calls.colors).toEqual(['green', 'red', 'green', 'cyan'])
})
