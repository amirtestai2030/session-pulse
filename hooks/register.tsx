import { atom, read, update } from 'claude-code'
import type { Register, SessionRateLimit, SessionUsage } from 'claude-code'

import type { Ledger, Limit, Pulse } from '../types'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const TITLE = 'Session Pulse'
const COMMAND = 'pulse'
const LEDGER_KEY = 'ledger'
const COMPACT_KEY = 'isCompact'

const EMPTY: Pulse = {
  limits: [],
  costUsd: null,
  ctxTokens: null,
  ctxWindow: 0,
  ctxPercent: null,
  isRunning: false,
  turnStartedAt: 0,
  turnSeconds: 0,
  totalSeconds: 0,
  turns: 0,
  nudgedSoft: false,
  nudgedHard: false,
  isCompact: true,
  showHelp: false,
  dayUsd: 0,
  weekUsd: 0,
}

// The shape tag declines what an older version of this file stored.
const pulse = atom({ plugin: 'session-pulse', key: 'pulse' } as const, EMPTY, { shape: 'pulse-2' })

// ---------------------------------------------------------------------------
// Settings (from plugin.json userConfig, defaults filled in by the engine)
// ---------------------------------------------------------------------------

type Settings = {
  softTokens: number
  hardTokens: number
  warnPercent: number
  alertPercent: number
  longTurnSeconds: number
  playSound: boolean
}

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const settingsOf = (options: Readonly<Record<string, unknown>>): Settings => {
  const warn = num(options.warnPercent, 60)
  const alert = Math.max(warn, num(options.alertPercent, 85))
  const soft = num(options.compactSoftK, 300) * 1000
  const hard = Math.max(soft, num(options.compactHardK, 400) * 1000)
  return {
    softTokens: soft,
    hardTokens: hard,
    warnPercent: warn,
    alertPercent: alert,
    longTurnSeconds: num(options.longTurnSeconds, 120),
    playSound: options.playSound !== false,
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const clock = (s: number): string => {
  const hrs = Math.floor(s / 3600)
  const min = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return hrs > 0 ? `${hrs}:${String(min).padStart(2, '0')}:${sec}` : `${min}:${sec}`
}

const short = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
    : n >= 1_000
      ? `${Math.round(n / 1_000)}K`
      : String(n)

const usd = (n: number | null): string => (n === null ? '—' : `$${n.toFixed(2)}`)

/** "2h 10m", "35m", "3d 4h", or "now" once the window has reset. */
const untilReset = (iso: string | null, now: number): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!(ms > 0)) return 'now'
  const m = Math.round(ms / 60000)
  const d = Math.floor(m / 1440)
  const hr = Math.floor((m % 1440) / 60)
  return d > 0 ? `${d}d ${hr}h` : hr > 0 ? `${hr}h ${m % 60}m` : `${m}m`
}

/** The local calendar day of a moment, as YYYY-MM-DD. */
const dayOf = (ms: number): string => {
  const d = new Date(ms)
  const local = new Date(ms - d.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

const daysBetween = (fromDay: string, toDay: string): number =>
  Math.round((Date.parse(toDay) - Date.parse(fromDay)) / 86_400_000)

// Compact thresholds: the configured token counts, capped for a smaller window.
const compactAt = (s: Settings, win: number): number => (win > 0 ? Math.min(s.softTokens, Math.round(win * 0.5)) : s.softTokens)
const compactHard = (s: Settings, win: number): number => (win > 0 ? Math.min(s.hardTokens, Math.round(win * 0.7)) : s.hardTokens)

// Guards against a stale value: a prompt over a day, or a total over 30 days, is not work.
const MAX_TURN = 24 * 3600
const cleanTotal = (n: number | undefined): number => (n !== undefined && n >= 0 && n <= 30 * 24 * 3600 ? n : 0)

// ---------------------------------------------------------------------------
// Reading the engine's figures
// ---------------------------------------------------------------------------

type Figures = Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>

const limitsOf = (rows: readonly SessionRateLimit[]): Limit[] =>
  rows.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt ?? null }))

/** Writes the engine's figures into state and raises the /compact nudges. */
async function absorb($: any, s: Settings, u: Figures): Promise<void> {
  const c = u.context ?? { window: 0 }
  await update($, pulse, st => ({
    ...st,
    limits: limitsOf(u.rateLimits ?? []),
    costUsd: u.cost?.usd ?? st.costUsd,
    ctxTokens: c.tokens ?? st.ctxTokens,
    ctxWindow: c.window > 0 ? c.window : st.ctxWindow,
    ctxPercent: c.percent ?? st.ctxPercent,
  }))

  const st = await read($, pulse)
  if (st.ctxTokens === null || st.ctxWindow <= 0) return
  const soft = compactAt(s, st.ctxWindow)
  const hard = compactHard(s, st.ctxWindow)
  const overSoft = st.ctxTokens >= soft
  const overHard = st.ctxTokens >= hard

  // One nudge per crossing, re-armed once a compaction brings the window back under.
  if (overHard && !st.nudgedHard) {
    $.ui.toast(`⚠ Context passed ${short(hard)} tokens. Type /compact now.`, { timeoutMs: 8000 })
    await update($, pulse, x => ({ ...x, nudgedSoft: true, nudgedHard: true }))
  } else if (overSoft && !st.nudgedSoft) {
    $.ui.toast(`💡 Context passed ${short(soft)} tokens. Compact recommended: type /compact.`, { timeoutMs: 6000 })
    await update($, pulse, x => ({ ...x, nudgedSoft: true }))
  } else if (!overSoft && (st.nudgedSoft || st.nudgedHard)) {
    await update($, pulse, x => ({ ...x, nudgedSoft: false, nudgedHard: false }))
  }
}

async function pull($: any, s: Settings): Promise<void> {
  const u: SessionUsage = await $.session.usage()
  await absorb($, s, u)
}

// ---------------------------------------------------------------------------
// The cross-session cost ledger
// ---------------------------------------------------------------------------

const KEEP_DAYS = 30

const readLedger = async ($: any): Promise<Ledger> => {
  const raw = (await $.store.get(LEDGER_KEY)) as Partial<Ledger> | undefined
  const sessions = raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {}
  return { sessions }
}

/** Records this session's cost under its id and refreshes the day and week totals. */
async function settleLedger($: any): Promise<void> {
  const st = await read($, pulse)
  if (st.costUsd === null) return
  const now = await $.clock.now()
  const today = dayOf(now)
  const id: string = await $.session.id()
  const ledger = await readLedger($)

  const sessions: Ledger['sessions'] = {}
  for (const [key, row] of Object.entries(ledger.sessions)) {
    if (!row || typeof row.usd !== 'number' || typeof row.day !== 'string') continue
    const age = daysBetween(row.day, today)
    if (Number.isFinite(age) && age >= 0 && age <= KEEP_DAYS) sessions[key] = row
  }
  const mine = sessions[id]
  // A resumed session keeps the day it first ran on so it is not counted twice.
  sessions[id] = { usd: st.costUsd, day: mine?.day ?? today }

  let dayUsd = 0
  let weekUsd = 0
  for (const row of Object.values(sessions)) {
    const age = daysBetween(row.day, today)
    if (age === 0) dayUsd += row.usd
    if (age >= 0 && age < 7) weekUsd += row.usd
  }

  await $.store.set(LEDGER_KEY, { sessions })
  await update($, pulse, x => ({ ...x, dayUsd, weekUsd }))
}

// ---------------------------------------------------------------------------
// The two band controls
// ---------------------------------------------------------------------------

/** Flips between one line and the cards, and remembers the choice across sessions. */
async function toggleCompact($: any): Promise<boolean> {
  const isCompact = !(await read($, pulse)).isCompact
  await update($, pulse, x => ({ ...x, isCompact }))
  await $.store.set(COMPACT_KEY, isCompact)
  return isCompact
}

/** Opens or closes the learn rows under the band. */
async function toggleHelp($: any): Promise<void> {
  await update($, pulse, x => ({ ...x, showHelp: !x.showHelp }))
}

// ---------------------------------------------------------------------------
// Prompt clocks
// ---------------------------------------------------------------------------

async function elapsed($: any, startedAt: number): Promise<number> {
  if (!(startedAt > 0)) return 0
  const s = Math.round(((await $.clock.now()) - startedAt) / 1000)
  return s >= 0 && s <= MAX_TURN ? s : 0
}

// ---------------------------------------------------------------------------
// The /pulse command
// ---------------------------------------------------------------------------

const HELP = [
  '/pulse            this summary',
  '/pulse toggle     switch between the cards and one thin line',
  '/pulse context    what fills the context window, by category',
  '/pulse reset      restart the prompt clocks and the turn count',
].join('\n')

async function summary($: any, s: Settings): Promise<string> {
  await pull($, s)
  const st = await read($, pulse)
  const now = await $.clock.now()
  const five = st.limits.find(l => l.kind === 'five_hour')
  const week = st.limits.find(l => l.kind === 'seven_day')
  const limitLine = (label: string, l: Limit | undefined) =>
    l ? `${label}: ${Math.round(l.percent)}% used, resets in ${untilReset(l.resetsAt, now)}` : `${label}: no reading yet`
  const ctx =
    st.ctxTokens === null
      ? 'Context: no reading yet'
      : `Context: ${short(st.ctxTokens)} of ${short(st.ctxWindow)} (${st.ctxPercent ?? 0}%), ${short(Math.max(0, st.ctxWindow - st.ctxTokens))} left`
  return [
    `${TITLE}`,
    ctx,
    limitLine('5-hour limit', five),
    limitLine('Weekly limit', week),
    `Prompts: ${st.turns} finished, ${clock(cleanTotal(st.totalSeconds))} of work in all, last ${clock(st.turnSeconds)}`,
    `Cost: ${usd(st.costUsd)} this session, ${usd(st.dayUsd)} today, ${usd(st.weekUsd)} over 7 days`,
    '',
    HELP,
  ].join('\n')
}

async function contextReport($: any): Promise<string> {
  const u: SessionUsage = await $.session.usage({ breakdown: 'summary' })
  const b = u.context.breakdown
  if (!b) return 'No context breakdown is available right now (no session bound, or no response yet).'
  const rows = [...b.categories].filter(c => c.kind !== 'free').sort((x, y) => y.tokens - x.tokens)
  const width = Math.max(...rows.map(r => r.name.length), 8)
  const lines = rows.map(r => {
    const share = b.rawMaxTokens > 0 ? Math.round((r.tokens / b.rawMaxTokens) * 100) : 0
    const tag = r.kind === 'buffer' ? '  (compaction reserve)' : r.kind === 'deferred' ? '  (loaded on demand, outside the window)' : ''
    return `${r.name.padEnd(width)}  ${short(r.tokens).padStart(6)}  ${String(share).padStart(3)}%${tag}`
  })
  const free = b.categories.find(c => c.kind === 'free')
  return [
    `Context window: ${short(b.totalTokens)} of ${short(b.rawMaxTokens)} in use (${Math.round(b.percentage)}%), model ${b.model}`,
    '',
    ...lines,
    free ? `${'Free space'.padEnd(width)}  ${short(free.tokens).padStart(6)}` : '',
    '',
    'Estimated locally, as /context does. Type /compact to shrink the Messages row.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const s = settingsOf(options)
  let tick: { cancel: () => void } | null = null
  let lastPullAt = 0

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Session Pulse: summary, toggle the band, context breakdown, reset clocks',
      argumentHint: '[toggle|context|reset]',
    })
    const stored = await $.store.get(COMPACT_KEY)
    const isCompact = stored === undefined ? true : stored === true
    await update($, pulse, st => ({ ...st, isCompact, showHelp: false, isRunning: false, turnStartedAt: 0, totalSeconds: cleanTotal(st.totalSeconds) }))
    await pull($, s)
    await settleLedger($)
    return r
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'toggle') {
      const isCompact = await toggleCompact($)
      return { text: isCompact ? `${TITLE}: one-line mode.` : `${TITLE}: cards mode.` }
    }
    if (arg === 'context') return { text: await contextReport($) }
    if (arg === 'reset') {
      await update($, pulse, x => ({ ...x, turnSeconds: 0, totalSeconds: 0, turns: 0 }))
      return { text: `${TITLE}: prompt clocks and turn count reset.` }
    }
    if (arg === '' || arg === 'help') return { text: await summary($, s) }
    return { text: `Unknown argument "${e.args.trim()}".\n${HELP}` }
  })

  on('prompt.submit', async ($, e, next) => {
    // A slash command runs no model turn, so it starts no clock.
    if (e.command) return next(e)
    const now = await $.clock.now()
    await update($, pulse, st => ({
      ...st,
      isRunning: true,
      turnSeconds: 0,
      turnStartedAt: now,
      totalSeconds: cleanTotal(st.totalSeconds),
    }))
    tick?.cancel()
    tick = $.clock.every(1000, async () => {
      const seconds = await elapsed($, (await read($, pulse)).turnStartedAt)
      await update($, pulse, st => (st.isRunning ? { ...st, turnSeconds: seconds } : st))
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    // A subagent's turn is not one of this session's prompts.
    if (e.agentId) return r
    tick?.cancel()
    tick = null
    const before = await read($, pulse)
    if (!before.isRunning) return r
    const seconds = await elapsed($, before.turnStartedAt)
    await update($, pulse, st => ({
      ...st,
      isRunning: false,
      turnSeconds: seconds,
      turnStartedAt: 0,
      totalSeconds: cleanTotal(st.totalSeconds) + seconds,
      turns: st.turns + 1,
    }))
    await pull($, s)
    await settleLedger($)

    if (seconds >= s.longTurnSeconds && !e.isAborted) {
      const text = `✅ Prompt finished in ${clock(seconds)}`
      $.ui.toast(text, { timeoutMs: 6000 })
      // A terminal that notifies gets a notification; the desktop app has no channel and keeps the toast.
      void $.ui.notify(text, { title: TITLE }).catch(() => undefined)
      if (s.playSound) void $.audio.play({ asset: 'sounds/done.wav' }).catch(() => undefined)
    }
    return r
  })

  // The engine pushes its figures after each turn and whenever a limit moves a whole point.
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await absorb($, s, e)
    if (e.changed.includes('cost')) await settleLedger($)
    return r
  })

  // Keeps the context bar live during a long turn, at most once every 15 seconds.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      const now = await $.clock.now()
      if (now - lastPullAt >= 15_000) {
        lastPullAt = now
        await pull($, s)
      }
    }
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    await pull($, s)
    return r
  })

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const st = await read($, pulse)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const W = Math.max(20, e.props.bodyColumns ?? 80)

    const tone = (p: number): string => (p >= s.alertPercent ? 'error' : p >= s.warnPercent ? 'warning' : 'success')
    const label = (t: string) => <Text weight="semibold" color="claude">{t}</Text>

    const five = st.limits.find(l => l.kind === 'five_hour')
    const week = st.limits.find(l => l.kind === 'seven_day')
    const ctxLeft = st.ctxTokens === null ? st.ctxWindow : Math.max(0, st.ctxWindow - st.ctxTokens)
    const total = cleanTotal(st.totalSeconds) + (st.isRunning ? st.turnSeconds : 0)
    const soft = compactAt(s, st.ctxWindow)
    const hard = compactHard(s, st.ctxWindow)
    const isOver = st.ctxTokens !== null && st.ctxWindow > 0 && st.ctxTokens >= soft
    const isHard = isOver && st.ctxTokens !== null && st.ctxTokens >= hard
    const reset5 = five ? untilReset(five.resetsAt, now) : ''
    const resetW = week ? untilReset(week.resetsAt, now) : ''

    const bar = (cells: number, pct: number | null) => {
      const p = pct ?? 0
      const filled = Math.max(pct === null ? 0 : 1, Math.min(cells, Math.round((p / 100) * cells)))
      return [
        <Text color={tone(p)}>{'█'.repeat(filled)}</Text>,
        <Text dimColor>{'░'.repeat(Math.max(0, cells - filled))}</Text>,
        <Text weight="semibold" color={tone(p)} tabular>{pct === null ? ' —' : ` ${Math.round(p)}%`}</Text>,
      ]
    }

    const pct = (l: Limit | undefined) => (l ? `${Math.round(l.percent)}%` : '—')
    const pctColor = (l: Limit | undefined) => (l ? tone(l.percent) : undefined)

    // The two controls at the band's trailing edge: expand or collapse, and learn.
    const controls = (
      <Box flexDirection="row" columnGap={1}>
        <Button key="expand" plain dimColor hotkey="e" label={st.isCompact ? '▸ cards' : '▾ line'} onPress={() => toggleCompact($)} />
        <Button key="learn" plain dimColor hotkey="h" label={st.showHelp ? '✕ learn' : '? learn'} onPress={() => toggleHelp($)} />
      </Box>
    )

    // What each part means, opened by the learn button.
    const helpRows = st.showHelp
      ? [
          <Text wrap="wrap" dimColor>{`🧠 Context: how much of the model's working memory this chat fills. Past ${short(soft)} tokens answers get worse; type /compact to summarize the chat and shrink it. Red past ${short(hard)}.`}</Text>,
          <Text wrap="wrap" dimColor>{`⚡ 5-hour limit: your plan's rolling 5-hour usage window, and when it resets.`}</Text>,
          <Text wrap="wrap" dimColor>{`📅 Weekly limit: the same for the rolling 7-day window. Hitting it pauses you until it resets.`}</Text>,
          <Text wrap="wrap" dimColor>{`⏱ Prompt time: the running (or last) prompt end to end, then every prompt of this session added up, idle time excluded. Long prompts (${s.longTurnSeconds}s+) end with a toast${s.playSound ? ' and a chime' : ''}.`}</Text>,
          <Text wrap="wrap" dimColor>{`💵 Cost: API-price estimate for this session, today and the last 7 days across all sessions. On a subscription nothing is billed; it shows how heavy the work is.`}</Text>,
          <Text wrap="wrap" dimColor>{`Colors: green under ${s.warnPercent}%, yellow from ${s.warnPercent}%, red from ${s.alertPercent}%. Commands: /pulse (summary), /pulse context (what fills the window), /pulse reset (clocks). Settings live in /config.`}</Text>,
        ]
      : []

    // ---- one-line mode -----------------------------------------------------
    if (st.isCompact) {
      const sep = <Text dimColor>{'  ·  '}</Text>
      const ctxColor = st.ctxPercent === null ? undefined : isHard ? 'error' : isOver ? 'warning' : tone(st.ctxPercent)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Text wrap="truncate">
            {label('🧠 ')}
            <Text weight="semibold" color={ctxColor} tabular>{st.ctxPercent === null ? '—' : `${Math.round(st.ctxPercent)}%`}</Text>
            {isOver ? <Text color={isHard ? 'error' : 'warning'}>{' /compact'}</Text> : null}
            {sep}
            {label('⚡ ')}
            <Text weight="semibold" color={pctColor(five)} tabular>{pct(five)}</Text>
            {reset5 ? <Text dimColor>{` ↻${reset5}`}</Text> : null}
            {sep}
            {label('📅 ')}
            <Text weight="semibold" color={pctColor(week)} tabular>{pct(week)}</Text>
            {sep}
            {label('⏱ ')}
            <Text weight="semibold" color={st.isRunning ? 'claude' : undefined} tabular>{clock(st.turnSeconds)}</Text>
            <Text dimColor>{` / ${clock(total)}`}</Text>
            {sep}
            {label('💵 ')}
            <Text weight="semibold" color="success" tabular>{usd(st.costUsd)}</Text>
            <Text dimColor>{` · ${usd(st.dayUsd)} today`}</Text>
          </Text>
          {controls}
          </Box>
          {helpRows}
          {below}
        </Box>
      )
    }

    // ---- cards ---------------------------------------------------------------
    const header = (
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Text wrap="truncate">
          <Text weight="semibold" color="claude">{`⚡ ${TITLE}`}</Text>
          <Text dimColor>{'   /pulse for details'}</Text>
        </Text>
        {controls}
      </Box>
    )

    const card = (width: number, ...rows: any[][]) => (
      <Box flexDirection="column" width={width}>
        {rows.map(spans => <Text wrap="truncate">{spans}</Text>)}
      </Box>
    )

    const ctxNote =
      st.ctxTokens === null
        ? <Text dimColor>no reading yet</Text>
        : isHard
          ? <Text weight="semibold" color="error">{`⚠ ${short(st.ctxTokens)} used · type /compact now`}</Text>
          : isOver
            ? <Text color="warning">{`💡 ${short(st.ctxTokens)} used · /compact recommended`}</Text>
            : <Text dimColor>{`${short(ctxLeft)} left of ${short(st.ctxWindow)}`}</Text>

    const ctxCard = (w: number) => card(w, [label('🧠 Context')], bar(Math.max(4, w - 6), st.ctxPercent), [ctxNote])
    const fiveCard = (w: number) =>
      card(
        w,
        [label('⚡ 5-hour limit')],
        five ? bar(Math.max(4, w - 6), five.percent) : [<Text dimColor>after the first reply</Text>],
        [<Text dimColor>{reset5 ? `↻ resets in ${reset5}` : ''}</Text>],
      )
    const weekCard = (w: number) =>
      card(
        w,
        [label('📅 Weekly limit')],
        week ? bar(Math.max(4, w - 6), week.percent) : [<Text dimColor>after the first reply</Text>],
        [<Text dimColor>{resetW ? `↻ resets in ${resetW}` : ''}</Text>],
      )
    const timeCard = (w: number) =>
      card(
        w,
        [label('⏱ Prompt time')],
        [
          <Text dimColor>{st.isRunning ? 'now   ' : 'last  '}</Text>,
          <Text weight="semibold" color={st.isRunning ? 'claude' : undefined} tabular>{clock(st.turnSeconds)}</Text>,
        ],
        [<Text dimColor>{'all   '}</Text>, <Text weight="semibold" tabular>{clock(total)}</Text>, <Text dimColor>{`  ${st.turns} prompts`}</Text>],
      )
    const costCard = (w: number) =>
      card(
        w,
        [label('💵 Cost')],
        [<Text weight="semibold" color="success" tabular>{usd(st.costUsd)}</Text>, <Text dimColor>{'  this session'}</Text>],
        [<Text dimColor>{`${usd(st.dayUsd)} today · ${usd(st.weekUsd)} 7 days`}</Text>],
      )

    // One line for the clocks and the cost, used when only two cards fit across.
    const statsLine = (
      <Text wrap="truncate">
        {label('⏱ ')}
        <Text weight="semibold" color={st.isRunning ? 'claude' : undefined} tabular>{clock(st.turnSeconds)}</Text>
        <Text dimColor>{st.isRunning ? ' now' : ' last'}</Text>
        <Text dimColor>{'  ·  '}</Text>
        {label('⌛ ')}
        <Text weight="semibold" tabular>{clock(total)}</Text>
        <Text dimColor>{` all (${st.turns})`}</Text>
        <Text dimColor>{'  ·  '}</Text>
        {label('💵 ')}
        <Text weight="semibold" color="success" tabular>{usd(st.costUsd)}</Text>
        <Text dimColor>{` · ${usd(st.dayUsd)} today · ${usd(st.weekUsd)} 7d`}</Text>
      </Text>
    )

    const GAP = 3
    let rows: any[]
    if (W >= 120) {
      // Wide: five cards in one band.
      const w = Math.floor((W - GAP * 4) / 5)
      rows = [
        <Box flexDirection="row" columnGap={GAP}>
          {ctxCard(w)}
          {fiveCard(w)}
          {weekCard(w)}
          {timeCard(w)}
          {costCard(w)}
        </Box>,
      ]
    } else if (W >= 72) {
      // Medium and split view: the three gauges side by side, then one stats line.
      const w = Math.floor((W - GAP * 2) / 3)
      rows = [
        <Box flexDirection="row" columnGap={GAP}>
          {ctxCard(w)}
          {fiveCard(w)}
          {weekCard(w)}
        </Box>,
        statsLine,
      ]
    } else {
      // Narrow: one compact line per gauge, then the stats.
      const cells = Math.max(4, Math.min(20, W - 30))
      rows = [
        <Text wrap="truncate">
          {label('🧠 ')}
          {bar(cells, st.ctxPercent)}
          <Text dimColor>{st.ctxTokens === null ? '' : ` ${short(ctxLeft)} left`}</Text>
        </Text>,
        <Text wrap="truncate">
          {label('⚡ ')}
          {five ? bar(cells, five.percent) : <Text dimColor>—</Text>}
          <Text dimColor>{reset5 ? ` ↻ ${reset5}` : ''}</Text>
        </Text>,
        <Text wrap="truncate">
          {label('📅 ')}
          {week ? bar(cells, week.percent) : <Text dimColor>—</Text>}
          <Text dimColor>{resetW ? ` ↻ ${resetW}` : ''}</Text>
        </Text>,
        statsLine,
      ]
      if (isOver) {
        rows.push(
          <Text wrap="truncate" weight="semibold" color={isHard ? 'error' : 'warning'}>
            {isHard ? '⚠ Compact now · type /compact' : '💡 Compact recommended · type /compact'}
          </Text>,
        )
      }
    }

    return (
      <Box flexDirection="column">
        {header}
        {rows}
        {helpRows}
        {below}
      </Box>
    )
  })
}
