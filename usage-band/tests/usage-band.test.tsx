import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-05T12:00:00Z')
const HOUR = 3_600_000
const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}

// 5h: 60% used one hour into the window; week: 19% used four days in
const LIMITS = [
  { kind: 'seven_day', percentUsed: 19, resetsAt: new Date(NOW + 3 * 24 * HOUR).toISOString() },
  { kind: 'five_hour', percentUsed: 60, resetsAt: new Date(NOW + 4 * HOUR).toISOString() },
]

// What the engine answers beneath the plugin: the session events, and the band of its own (`below` stands for another plugin's)
function beneath(on: On, below?: string) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return below === undefined ? <Box /> : <Box><Text>{below}</Text></Box>
  })
}

test('draws both windows with countdown and forecast after a measurement', async ($, on) => {
  mock.clock(on, { now: NOW })
  beneath(on)
  mock.store(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS, changed: ['rateLimits'] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: BAND })
    const labels = (await ui.findAll({ type: 'Text', text: /^ ?(5-hour|Weekly) ?$/ })).map(found => found.text.trim())

    expect(labels).toEqual(['5-hour', 'Weekly'])
    expect(await ui.find({ text: /^ *60%$/ })).toBeDefined()
    expect(await ui.find({ text: /^ *19%$/ })).toBeDefined()
    expect(await ui.find({ text: /↻ 4h 00m/ })).toBeDefined()
    expect(await ui.find({ text: /↻ 3d 0h/ })).toBeDefined()
    expect(await ui.find({ text: '▲ full in 40m' })).toBeDefined()
    expect(await ui.find({ text: '→ ~33% at reset' })).toBeDefined()
    expect(await ui.find({ text: /As of/ })).toBeUndefined()

    const raster = await ui.find({ type: 'Raster', key: 'bar-five_hour' })
    const bars = await ui.findAll({ type: 'Svg' })
    if (surface === 'terminal') {
      expect(raster?.props.columns).toBe(48)
      expect(bars).toHaveLength(0)
    } else {
      expect(raster).toBeUndefined()
      // Both bars equally wide, so the columns after them line up
      expect(bars.map(found => found.props.width)).toEqual([336, 336])
      expect(bars[0]?.props.alt).toBe('5-hour: 60% used, 20% of the window elapsed')
      // 60% of 336 px filled, the pace marker's white line at 20%
      expect(String(bars[0]?.props.source)).toContain('<rect width="201.6"')
      expect(String(bars[0]?.props.source)).toContain('<rect x="66.7" y="1" width="1"')
    }
  }
})

test('keeps what other plugins draw in the band beside the bars', async ($, on) => {
  mock.clock(on, { now: NOW })
  beneath(on, 'palette button')
  mock.store(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS, changed: ['rateLimits'] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: BAND })

    expect(await ui.find({ text: /^ ?5-hour ?$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'palette button' })).toBeDefined()
    await ui.unmount()
  }
})

test('starts from the reading another session stored and says how old it is', async ($, on) => {
  mock.clock(on, { now: NOW })
  beneath(on)
  mock.store(on, { reading: { at: NOW - 2 * HOUR, windows: LIMITS } })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  expect(await ui.find({ text: / 60%/ })).toBeDefined()
  expect(await ui.find({ text: /As of 2h 00m ago/ })).toBeDefined()
})

test('shows a window whose reset has passed as fresh', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  beneath(on)
  mock.store(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS, changed: ['rateLimits'] })
  await clock.advance(4 * HOUR + 60_000)

  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  expect(await ui.find({ text: /↻ reset/ })).toBeDefined()
  expect(await ui.find({ text: /^ +0%$/ })).toBeDefined()
})

test('narrow band drops the forecast and shrinks the bar', async ($, on) => {
  mock.clock(on, { now: NOW })
  beneath(on)
  mock.store(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS, changed: ['rateLimits'] })

  const ui = await $.ui.mount({
    plugin: 'usage-band',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND, bodyColumns: 50 },
  })

  expect(await ui.find({ text: /full in/ })).toBeUndefined()
  expect((await ui.find({ type: 'Raster', key: 'bar-five_hour' }))?.props.columns).toBe(27)
})

test('draws nothing without a reading or while a survey holds the band', async ($, on) => {
  mock.clock(on, { now: NOW })
  beneath(on)
  mock.store(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const empty = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await empty.find({ text: /Weekly/ })).toBeUndefined()

  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS, changed: ['rateLimits'] })
  const survey = await $.ui.mount({
    plugin: 'usage-band',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND, hasSurvey: true },
  })
  expect(await survey.find({ text: /Weekly/ })).toBeUndefined()
})

test('a light runs along the bars while a turn runs and stops when it ends', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  beneath(on)
  mock.store(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  const blits: { key: string; cells: string }[] = []
  on('ui.blit', (_$, e) => {
    if ('cells' in e) {
      blits.push({ key: e.key, cells: e.cells })
    }

    return { value: {} }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS, changed: ['rateLimits'] })
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(400)
  const keys = blits.map(blit => blit.key)
  expect(keys).toContain('bar-five_hour')
  expect(keys).toContain('bar-seven_day')

  await $.turn.complete({ answer: 'done', durationMs: 400, isAborted: false, turnId: 't1', reason: 'answer' })
  const count = blits.length
  await clock.advance(400)
  expect(blits).toHaveLength(count)

  // A redraw with unchanged cells keeps the last blitted frame, so the plain bars must be blitted back
  for (const key of ['bar-five_hour', 'bar-seven_day']) {
    const drawn = await ui.find({ type: 'Raster', key })
    const last = blits.filter(blit => blit.key === key).at(-1)
    expect(last?.cells).toBe(drawn?.props.cells)
  }
})

test('the desktop bars have no Raster for the light to paint', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  beneath(on)
  mock.store(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const blits: string[] = []
  on('ui.blit', (_$, e) => {
    blits.push(e.key)

    return { value: {} }
  })

  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS, changed: ['rateLimits'] })
  await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'AbovePrompt', props: BAND })

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(400)
  expect(blits).toHaveLength(0)
})
