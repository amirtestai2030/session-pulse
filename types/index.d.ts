/** One rate-limit window as the engine reports it. */
export type Limit = { kind: string; percent: number; resetsAt: string | null }

/** Everything the band draws, kept in session state so a reload loses nothing. */
export type Pulse = {
  limits: Limit[]
  costUsd: number | null
  ctxTokens: number | null
  ctxWindow: number
  ctxPercent: number | null
  isRunning: boolean
  /** Start of the running prompt in ms since the epoch; 0 while idle. */
  turnStartedAt: number
  /** Seconds of the running prompt, or of the last one once idle. */
  turnSeconds: number
  /** Seconds of every finished prompt in this session, idle time excluded. */
  totalSeconds: number
  /** Finished prompts in this session. */
  turns: number
  nudgedSoft: boolean
  nudgedHard: boolean
  /** One thin line instead of the cards (the default). */
  isCompact: boolean
  /** The learn rows under the band are open. */
  showHelp: boolean
  /** Dollars spent today across sessions, this one included. */
  dayUsd: number
  /** Dollars spent over the last seven days across sessions, this one included. */
  weekUsd: number
}

/** The cross-session cost ledger kept in `$.store` under `ledger`. */
export type Ledger = {
  /** Each session's latest cost and the local day (YYYY-MM-DD) it ran on. */
  sessions: Record<string, { usd: number; day: string }>
}

declare module 'claude-code' {
  interface PluginState {
    'session-pulse': { pulse: Shaped<Pulse> }
  }
}
