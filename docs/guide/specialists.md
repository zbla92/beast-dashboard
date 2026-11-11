# Specialists

A specialist is a named, reusable Claude agent that does not belong to any project: a writer, a
reviewer, a researcher. Each one has its own profile folder with its instructions, settings, skills
and memory. You ask it from the dashboard or from any agent (`bd-ask <name> "task"`) and get back only
its final answer.

This page is the contract the store ([`lib/specialists.js`](../../lib/specialists.js)), the server,
the runner, the `bd-ask` command and the UI share. Change it only on purpose, and all of them with it.

## 1. Profile folder

```
~/.beast/specialists/                 store root; BD_SPECIALISTS_DIR overrides it (tests, BD_TEST runs)
  writer/                             one specialist = one folder; the folder name is its name
    specialist.json                   dashboard metadata (section 2)
    CLAUDE.md                         its instructions
    .claude/settings.json             optional: permissions, hooks
    .claude/skills/, .claude/agents/  optional: its skills and subagents
    .mcp.json                         optional: its MCP servers
    .bd/                              owned by the dashboard: runs/<runId>.json, thread.json
    …                                 anything else (style.md, examples/, notes) is its own business
  _archive/<name>-<YYYYMMDD-HHMMSS>/  archived profiles (section 5)
```

- The profile folder **is the working directory** every run starts in, so Claude Code reads it as a
  project: `CLAUDE.md` is project memory, `.claude/settings.json` project settings, `.claude/skills`
  project skills, `.mcp.json` project MCP servers (approved by Claude Code's own rules for project
  servers). `@file` imports in `CLAUDE.md` work, which is how the writer template pulls in `style.md`.
- Transcripts land in `<config dir>/projects/<cwd with every non-alphanumeric as ->/` and auto-memory
  is kept per working directory, so each specialist has its own history and memory under the account
  it runs on. The user-level `CLAUDE.md`, settings and hooks of that account still apply.
- A folder counts as a specialist when its name is valid (section 2) and it holds a regular file
  `specialist.json`. Folders starting with `.` or `_`, symlinked folders, and folders without
  `specialist.json` are ignored by the list and refused by every call. `specialist.json`, `CLAUDE.md`
  and `.bd/` must not be symlinks; the store refuses them (409) instead of following them.
- Writes are atomic (temporary file in the same folder, then rename). Creating a profile builds it in
  `.new-<name>-*` and renames it into place.

## 2. `specialist.json`

```json
{
  "name": "writer",
  "title": "Writer",
  "description": "Drafts messages in the owner's voice; returns only the message text.",
  "icon": "✎",
  "color": null,
  "provider": "claude",
  "model": "sonnet",
  "effort": null,
  "account": "personal",
  "mode": "run",
  "permissionMode": "dontAsk",
  "createdAt": "2026-11-11T08:30:05.123Z",
  "updatedAt": "2026-11-11T08:30:05.123Z"
}
```

| Field | Type | Default | Rule | API-editable |
|---|---|---|---|---|
| `name` | string | — | `^[a-z0-9][a-z0-9-]{0,31}$`, not ending in `-` or `-company`, no `-DDDDDD-DDDD` date segment, not `run`. Always the folder name: a different value in the file is ignored | no (set on create) |
| `title` | string | the name | one line, 1–60 chars, trimmed | yes |
| `description` | string | `""` | one line, 0–300 chars, trimmed. Shown in the list and to agents choosing a specialist | yes |
| `icon` | string | `◆` | one emoji or short text, 1–16 UTF-16 units, one line | yes |
| `color` | string \| null | `null` | `#rgb` or `#rrggbb`, stored lowercase | yes |
| `provider` | string | `claude` | only `claude` works in Phase 1; `api`, `codex`, `grok` are reserved and refused with "not available yet" | yes |
| `model` | string \| null | `null` | `null` = the account default; `opus`, `sonnet`, `haiku`, `fable` (each optionally `[1m]`) or a full id `claude-…`. `"default"` is stored as `null` | yes |
| `effort` | string \| null | `null` | `low`, `medium`, `high`, `xhigh`, `max`; `null` = default | yes |
| `account` | string | `personal` | `personal` (`~/.claude`) or `company` (`~/.claude-company`) | yes |
| `mode` | string | `run` | `run` or `thread` (section 4) | yes |
| `permissionMode` | string | `bypassPermissions` | a `claude --permission-mode` value: `bypassPermissions`, `acceptEdits`, `auto`, `manual`, `dontAsk`, `plan` | yes |
| `createdAt` | string | — | ISO 8601 UTC, set by the store | no |
| `updatedAt` | string | — | ISO 8601 UTC, bumped by every update (metadata or instructions) | no |

- Unknown keys in the file are kept on update and not returned by the API.
- A file that is not a JSON object, or has an invalid field, makes the specialist **invalid**: the list
  shows it as `{ name, dir, error }`, `GET` and `ask` answer 409 with that error, and an update that
  sets the bad field to a valid value repairs it.
- `CLAUDE.md` (the "instructions") is at most 256 KiB. `specialist.json` at most 64 KiB.
- Renaming is not supported: transcripts and memory are keyed by the folder path.

### Templates

`create` takes an optional template. Its fields are defaults; fields in the request win.

| id | What it creates |
|---|---|
| `blank` (default) | `CLAUDE.md` with the title and description |
| `writer` | `CLAUDE.md` for drafting messages in the owner's voice (asks nothing back, returns only the message text, never invents facts), `style.md` (an empty style guide imported by `CLAUDE.md`), an empty `examples/` folder for messages the owner really sent; `icon: ✎`, `permissionMode: dontAsk` |

## 3. HTTP API

Every response is JSON. Errors are `{ "ok": false, "error": "<text>" }` with the status below.
All `/api/*` guards of the server apply (Host allow-list, same-origin, no cross-site).

| Status | When |
|---|---|
| 400 | bad JSON, unknown or non-editable field, invalid value, bad name or runId |
| 404 | no such specialist or run |
| 409 | name already exists, profile invalid, `ifUpdatedAt` mismatch, thread busy, archive while runs are active |
| 413 | instructions over 256 KiB, task text over 100 000 chars |
| 429 | 4 runs of this specialist are already active |
| 500 | the run could not be started (tmux or runner failed) |

**Profile object** (`P`): every field of section 2 plus

```json
{ "dir": "/abs/path/to/specialists/writer",
  "files": { "instructions": true, "settings": false, "mcp": false, "skills": ["tone-check"], "agents": [] } }
```

**Run object** (`R`):

```json
{ "runId": "claude-spec-writer-261111-0930", "specialist": "writer", "mode": "run",
  "tmux": "claude-spec-writer-261111-0930", "account": "personal",
  "sessionId": "0b8f7a2c-1111-4222-8333-444455556666", "cwd": "/abs/…/writer", "transcriptPath": "/abs/…/<sessionId>.jsonl",
  "state": "done", "task": "Reply to …", "text": "Hi …", "truncated": false, "error": null,
  "startedAt": 1762850000000, "endedAt": 1762850042000, "turns": 1 }
```

Times in run objects are epoch milliseconds (like session records); `endedAt` is `null` until a final
state. `text` is `null` until the turn has a result. `truncated` is `true` when the text was cut at
200 KiB. A **run summary** (`RS`, used in lists) is `R` without `text`, with `task` cut to 200 chars
and `preview` (the first 200 chars of `text`, or `null`).

### `GET /api/specialists`

```json
{ "ok": true, "root": "/abs/…/specialists",
  "specialists": [ { …P, "active": 1, "lastRun": RS | null, "thread": { "tmux": "claude-spec-x", "live": true, "state": "idle" } | null } ],
  "templates": [ { "id": "writer", "title": "Writer", "description": "…", "meta": { "icon": "✎", … } } ] }
```

Sorted by name. An invalid profile appears as `{ "name", "dir", "error" }` only. `active` counts runs
not in a final state (checked against live tmux sessions). `thread` is set for `mode: thread` when a
thread was ever started; `state` is the runner state (`idle`, `working`, …) or `null` when not live.

### `GET /api/specialist/<name>?runs=50`

`{ "ok": true, "specialist": { …P, "instructions": "<CLAUDE.md text>" }, "runs": [RS…], "thread": … }`
— runs newest first, `runs` 1–500 (default 50).

### `POST /api/specialist` — create

Request: `{ "name": "writer", "template": "writer", "title"?, "description"?, "icon"?, "color"?, "provider"?, "model"?, "effort"?, "account"?, "mode"?, "permissionMode"?, "instructions"? }`
Response 201: `{ "ok": true, "specialist": P }`.

### `POST /api/specialist/<name>` — update

Request: any editable field, `"instructions"` (replaces `CLAUDE.md`) and optional
`"ifUpdatedAt": "<updatedAt the client loaded>"` (409 when the profile changed since).
Response: `{ "ok": true, "specialist": P }`. Changes apply to the next run; a live thread keeps its
model and effort until it is restarted.

### `POST /api/specialist/<name>/archive`

No body. Moves the folder to `_archive/<name>-<YYYYMMDD-HHMMSS>` (UTC; `-2`, `-3`… when taken).
Nothing is deleted and no tmux session is killed: with an active run or a live thread it answers 409.
Response: `{ "ok": true, "name": "writer", "archivedAs": "_archive/writer-20261111-083005" }`.
Restoring is moving the folder back by hand. A new specialist with the same name shares the old one's
transcript folder and auto-memory (same working directory).

### `POST /api/specialist/<name>/ask`

Request: `{ "text": "…", "files"?: ["/abs/file", …], "wait"?: false, "timeoutSec"?: 300 }`

- `text`: required, not blank; with the file list at most 100 000 chars.
- `files`: up to 20 absolute paths of existing regular files. They are appended to the message as
  `\n\nFiles for this task:\n- /abs/file` and their folders are passed to Claude as `--add-dir`, so a
  non-bypass permission mode can read them. Contents are never inlined.
- `wait`: `true` holds the request until the run reaches a final state or `timeoutSec` (1–1800,
  default 300) passes.
- Response: `{ "ok": true, …R }`, plus `"timedOut": true` when the wait ended first (poll with the
  run endpoint). Without `wait` it answers as soon as the run is started (`state` `starting` or
  `working`).
- `run` mode: 429 when 4 runs are active. `thread` mode: 409 `thread is busy` while its previous ask
  has no result.

### `GET /api/specialist/run/<runId>?wait=1&timeoutSec=300`

`{ "ok": true, …R }`; with `wait=1` the same hold as `ask` (returns at once if already final), plus
`"timedOut": true` when it ran out. 404 for an unknown run.

### `POST /api/specialist/run/<runId>/send` — continue a run

Request: `{ "text": "…", "wait"?: false, "timeoutSec"?: 300 }`. Run mode only (400 for a thread
runId: ask the thread instead). Resumes the run's conversation in the same tmux name (relaunching it
with `--resume <sessionId>` if it ended), sets `state` back to `working`, `turns + 1`, and replaces
`text` with the new turn's result. 409 while the run is not in a final state. Response as `ask`.

## 4. Runs

### Names and ids

| What | tmux name = runId |
|---|---|
| run mode | `claude-spec-<name>-<YYMMDD-HHMM>[-n]` + `-company` on the company account (local time like `claude-chat-*`; `-2`…`-99` when taken by a tmux session, session record or run record) |
| thread session | `claude-spec-<name>` + `-company` |
| thread ask | runId `<thread tmux>_<seq>` (seq 1, 2, … per thread, kept in `.bd/thread.json`); its `tmux` is the thread session |

All match `^[A-Za-z0-9_.-]+$` and start with `claude-`, so hooks, session state and the chat view
treat them as dashboard chats. The name rules of section 2 make every id parse back to one
specialist (`parseRunId`, `specialistOfTmux` in the store). The session record in `lib/claude.js`
carries `specialist: "<name>"`; the UI uses it to show these sessions under Specialists, not under
Sessions, and the restore list skips them.

### Launch

A run is a normal dashboard headless chat (`bin/headless-runner.js` in tmux) started in the profile
folder on the profile's account, with `--model` / `--effort` when set. `permissionMode`
`bypassPermissions` keeps today's `--dangerously-skip-permissions`; any other value passes
`--permission-mode <value>` and keeps `--permission-prompt-tool stdio`, so prompts reach the
dashboard's permission UI.

### States

| state | meaning |
|---|---|
| `starting` | tmux launched, the message not yet accepted by the runner |
| `working` | the turn is running |
| `waiting` | the turn waits for a permission answer in the dashboard |
| `done` | final: the turn ended with a success result |
| `error` | final: an error result, Claude exited, or the launch failed; `error` says why |
| `stopped` | final: interrupted, or its runner disappeared without a result (also set when the dashboard finds a non-final run whose tmux session is gone) |

Waiting (`wait`) ends only on a final state; a run stuck in `waiting` returns on timeout with
`state: "waiting"`, which `bd-ask` reports as "needs an answer in the dashboard".

### Result text

`text` is the full final assistant text of the turn: the `result` string of Claude Code's
stream-json `result` message, which the runner forwards with its `result` event. When that is missing
or empty (error, interrupt), it is the text blocks of the last main-thread assistant message in the
transcript after the turn's prompt. Never the 400-char `lastMessage` of the session record. Capped at
200 KiB (`truncated: true`).

### Lifecycle

- **run**: every ask starts a fresh conversation. When the result is stored in
  `.bd/runs/<runId>.json`, the runner exits and the tmux session ends. The run stays readable
  through the API and resumable with `send`.
- **thread**: one tmux session `claude-spec-<name>` that asks are sent into, one at a time. It stays
  up after a result. When it is gone, the next ask relaunches it resuming the conversation stored in
  `.bd/thread.json` (or a new one when that conversation no longer exists). Changing `account` starts
  a new thread session; the old one is left alone.
- Run records are never pruned in Phase 1; lists read the newest 500 at most.

## 5. What Phase 1 does not isolate

Specialists run as the same Unix user, on the same Claude login, as every other dashboard session.
A profile folder separates instructions, settings, history and memory, not access: with
`bypassPermissions` a specialist can read and write whatever your user can, and any session can read
a profile. Do not put secrets (API keys, passwords, tokens) in a profile or its `.mcp.json`; real
separation (own Unix user, a broker for credentials) is a later phase.
