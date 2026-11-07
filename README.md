# Session Pulse

A Claude Code mod that sits above the prompt box and shows, while you work, what you need to know about the session: how full the context window is, how much of the 5-hour and weekly limits is used and when they reset, how long the current and all prompts have run, and what the session, the day and the last seven days have cost.

Works in the desktop app (Code tab) and in the terminal, on Windows, macOS and Linux. Requires Claude Code 2.1.287 or later.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-pulse --marketplace amirtestai2030/session-pulse
```

Answer `y` to add the marketplace, then pick a scope (user is the usual one). From a shell instead:

```bash
claude plugin install session-pulse --marketplace amirtestai2030/session-pulse
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `amirtestai2030/session-pulse`, then **Add plugin**. Open a new session afterwards.

To uninstall: `/plugin uninstall session-pulse@session-pulse`.

## What you see

By default, one thin line: context percent, both limits, the prompt clocks and the cost. Two small controls sit at its end: **▸ cards** opens the full cards (and **▾ line** closes them again; the choice is remembered across sessions), and **? learn** opens a short explanation of every part and of the colors under the band.

The cards: five side by side on a wide window, three gauges plus one stats line on a medium window, and one short line per gauge on a narrow one:

| Card | What it shows |
|---|---|
| 🧠 Context | A fill bar, tokens left, and a `/compact` suggestion past 300K tokens (yellow) that turns red past 400K. One toast per crossing. |
| ⚡ 5-hour limit | A fill bar and the time until the window resets. |
| 📅 Weekly limit | A fill bar and the time until the weekly window resets. |
| ⏱ Prompt time | `now` or `last`: one prompt end to end. `all`: every prompt of this session added up, idle time excluded, plus the prompt count. |
| 💵 Cost | This session in USD, and the totals for today and the last seven days across all your sessions. |

Bars are green up to 60%, yellow up to 85%, red above. All thresholds are settings.

When a prompt that ran at least two minutes finishes, a toast appears, a terminal that supports notifications gets one, and the chime in `sounds/done.wav` plays where the host has an audio player.

## The /pulse command

- `/pulse`: a text summary of every figure.
- `/pulse toggle`: the same as the ▸ cards / ▾ line button.
- `/pulse context`: what fills the context window, by category, as `/context` estimates it.
- `/pulse reset`: restart the prompt clocks and the prompt count.

## Settings

Open `/config` and look for the Session Pulse rows: the compact thresholds in thousands of tokens, the yellow and red percentages, the long-turn threshold in seconds, and whether to play the chime.

## Privacy

The mod reads only what the session already holds: context fill, rate limits and cost. It keeps one small ledger of per-session cost in Claude Code's own plugin store so the daily and weekly totals work. It sends nothing anywhere.

## License

MIT
