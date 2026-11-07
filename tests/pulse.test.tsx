import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'session-pulse',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-11-07T10:00:00Z')

const USAGE = {
  startedAt: NOW - 60_000,
  context: { tokens: 120_000, window: 1_000_000, percent: 12 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 31, resetsAt: new Date(NOW + 2 * 3600_000 + 10 * 60_000).toISOString() },
    { kind: 'seven_day', percentUsed: 8.5, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
  ],
  cost: { usd: 1.25 },
}

type World = {
  clock: ReturnType<typeof mock.clock>
  toasts: string[]
  played: string[]
}

/** The engine beneath the plugin: usage figures, a session id, a clock, a store and the surfaces. */
function world(on: any, usage = USAGE, store: Record<string, unknown> = {}): World {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, store)
  const toasts: string[] = []
  const played: string[] = []
  on('session.usage', () => ({ value: usage }))
  on('session.id', () => ({ value: 'test-session' }))
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('tool.call', () => ({ result: {} }))
  on('ui.toast', (_: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  on('audio.play', (_: any, e: any) => {
    played.push(e.clip.asset)
    return { value: undefined }
  })
  // The engine's own drawing beneath the band.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return { clock, toasts, played }
}

test('the cards show context, both limits and the cost on every surface', async ($, on) => {
  world(on, USAGE, { isCompact: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Session Pulse/ }))?.text).toContain('Session Pulse')
    expect((await ui.find({ type: 'Text', text: /left of 1M/ }))?.text).toBe('880K left of 1M')
    expect((await ui.find({ type: 'Text', text: /resets in 2h 10m/ }))?.text).toBe('↻ resets in 2h 10m')
    expect((await ui.find({ type: 'Text', text: /resets in 3d 0h/ }))?.text).toBe('↻ resets in 3d 0h')
    expect((await ui.find({ type: 'Text', text: /^\$1\.25$/ }))?.text).toBe('$1.25')
    // The engine's own band still draws beneath ours.
    expect((await ui.find({ type: 'Text', text: /^engine$/ }))?.text).toBe('engine')
    await ui.unmount()
  }
})

test('today and 7-day totals add earlier sessions from the store', async ($, on) => {
  const today = '2026-11-07'
  world(on, USAGE, {
    isCompact: false,
    ledger: {
      sessions: {
        earlier: { usd: 2.0, day: today },
        yesterday: { usd: 4.0, day: '2026-11-06' },
        ancient: { usd: 100, day: '2026-09-01' },
      },
    },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // 1.25 (this session) + 2.00 (earlier today) = 3.25 today; + 4.00 yesterday = 7.25 over 7 days.
  expect((await ui.find({ type: 'Text', text: /today/ }))?.text).toBe('$3.25 today · $7.25 7 days')
  await ui.unmount()
})

test('a context past the soft threshold toasts once and shows the /compact hint', async ($, on) => {
  const { toasts } = world(on, { ...USAGE, context: { tokens: 320_000, window: 1_000_000, percent: 32 } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // A second measurement at the same level raises no second toast.
  await $.session.measure({
    context: { tokens: 330_000, window: 1_000_000, percent: 33 },
    rateLimits: USAGE.rateLimits,
    cost: USAGE.cost,
    changed: ['context'],
  })

  expect(toasts.filter(t => t.includes('300K')).length).toBe(1)

  // The one-line default shows a short hint; the cards show the full note.
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /\/compact/ }))?.text).toContain('🧠 33% /compact')
  await ui.unmount()
  await $.command.run({ command: 'pulse', args: 'toggle', origin: { kind: 'composer' } })
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /compact recommended/ }))?.text).toBe('💡 330K used · /compact recommended')
  await ui.unmount()
})

test('a finished prompt adds its time, and a long one chimes', async ($, on) => {
  const { clock, toasts, played } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' } })
  await clock.advance(150_000)
  await $.turn.complete({ answer: 'done', durationMs: 150_000, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(played).toEqual(['sounds/done.wav'])
  expect(toasts.some(t => t.includes('2:30'))).toBe(true)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^2:30$/ }))?.text).toBe('2:30')
  expect((await ui.find({ type: 'Text', text: /2:30 \/ 2:30/ }))?.text).toContain('⏱ 2:30 / 2:30')
  await ui.unmount()
})

test('a short prompt neither toasts nor chimes', async ($, on) => {
  const { clock, toasts, played } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' } })
  await clock.advance(20_000)
  await $.turn.complete({ answer: 'done', durationMs: 20_000, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(played).toEqual([])
  expect(toasts.some(t => t.includes('Prompt finished'))).toBe(false)
})

test('one line is the default; /pulse toggle switches to the cards and back', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Session Pulse/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /today/ }))?.text).toBe('🧠 12%  ·  ⚡ 31% ↻2h 10m  ·  📅 9%  ·  ⏱ 0:00 / 0:00  ·  💵 $1.25 · $1.25 today')
  await ui.unmount()

  const { text } = await $.command.run({ command: 'pulse', args: 'toggle', origin: { kind: 'composer' } })
  expect(text).toContain('cards')
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Session Pulse/ })).toBeDefined()
  await ui.unmount()

  await $.command.run({ command: 'pulse', args: 'toggle', origin: { kind: 'composer' } })
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Session Pulse/ })).toBeUndefined()
  await ui.unmount()
})

test('the expand button opens the cards and closes them, on every surface', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Button', key: 'expand' }))?.props.label).toBe('▸ cards')
    await ui.press({ key: 'expand' })
    expect(await ui.find({ type: 'Text', text: /Session Pulse/ })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'expand' }))?.props.label).toBe('▾ line')
    await ui.press({ key: 'expand' })
    expect(await ui.find({ type: 'Text', text: /Session Pulse/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the learn button opens the explanations and closes them', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /working memory/ })).toBeUndefined()
  await ui.press({ key: 'learn' })
  expect((await ui.find({ type: 'Text', text: /working memory/ }))?.text).toContain('Past 300K tokens')
  expect((await ui.find({ type: 'Text', text: /Colors:/ }))?.text).toContain('green under 60%, yellow from 60%, red from 85%')
  expect((await ui.find({ type: 'Button', key: 'learn' }))?.props.label).toBe('✕ learn')
  await ui.press({ key: 'learn' })
  expect(await ui.find({ type: 'Text', text: /working memory/ })).toBeUndefined()
  await ui.unmount()
})

test('/pulse prints a summary with every figure', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const { text } = await $.command.run({ command: 'pulse', args: '', origin: { kind: 'composer' } })
  expect(text).toContain('Context: 120K of 1M (12%), 880K left')
  expect(text).toContain('5-hour limit: 31% used, resets in 2h 10m')
  expect(text).toContain('Weekly limit: 9% used, resets in 3d 0h')
  expect(text).toContain('Cost: $1.25 this session')
})

test('the band yields to a survey', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Session Pulse/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})
