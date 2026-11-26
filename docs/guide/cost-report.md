# Session waste report

`bin/cost-report` reads the Claude transcripts of the last few days and writes a Markdown report of avoidable token cost. It only reads transcripts and writes the one report file: no network, no dashboard state.

```
bin/cost-report --out <path> [--days 7] [--top 10] [--root <projects-dir>]... [--now <ISO>]
```

- `--out` is required. An existing path is never overwritten: the report goes to `<name>-2.<ext>`, then `-3`, and the final path is printed.
- Without `--root` it scans every `~/.claude*/projects` folder. Each `--root` replaces that default.
- `--days` sets the window, `--top` how many findings each section lists, `--now` fixes the clock (used by the tests).

Transcripts are the main `<root>/<slug>/<session>.jsonl` files and the subagent files under `<session>/subagents/`. Only requests inside the window count. Costs are API list prices from `lib/usage.js`, so they are what the work would cost on the API, not a bill.

## What it looks for

| Pattern | Finding | Fix |
| --- | --- | --- |
| `opus-subagent` | A subagent on Opus doing routine work (Explore, gate-runner, test-writer, cross-repo-impact, web-fetch, statusline-setup). General-purpose, claude and Plan agents are listed as "check": they may be legitimate Opus work. | Pass `model: sonnet` or `haiku` |
| `cache-expired` | A main-session request after the prompt cache expired (5 minutes, or 1 hour if the transcript ever wrote 1-hour cache) that wrote at least 20k tokens of cache. | `/clear` and continue from the plan instead of resuming |
| `big-tool-result` | A tool result of 20k characters or more, kept in context for every later request until the next compaction. | Redirect to a file and print a summary, limit the read, or hand it to a subagent |
| `big-start` | A first request that already carries 40k tokens (30k for a subagent). | Trim CLAUDE.md, memory, MCP servers and skills loaded at start |
| `repeat-call` | The same tool with the same input three or more times, with at least 2k tokens of repeated results. | Keep the first result or a summary instead of re-running |

The thresholds are the exported `LIMITS` object in `lib/cost-report.js`.

## Report

A summary table (findings, tokens by type, estimated avoidable dollars, fix) sorted by dollars, then one section per pattern with its top findings. A pattern without findings prints `none`. Sessions are labelled by the last two parts of the working directory and the first 8 characters of the session id; the report contains no prompt or tool output text beyond a short tool input summary (command, file path or pattern) on `big-tool-result` and `repeat-call` rows.
