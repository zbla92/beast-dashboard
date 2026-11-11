# Specialists

A specialist is a named, reusable agent that does not belong to any project: a writer, a
reviewer, a researcher. It runs on Claude Code by default, or as a text-only chat with an OpenAI or
xAI model once you add a key (section 6). Each one has its own profile folder with its instructions, settings, skills
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
| `provider` | string | `claude` | `claude` (Claude Code), `openai` or `xai` (text-only chat, section 4); `api`, `codex`, `grok` are reserved and refused with "not available yet" | yes |
| `model` | string \| null | `null` | `claude`: `null` = the account default; `opus`, `sonnet`, `haiku`, `fable` (each optionally `[1m]`) or a full id `claude-…`. `openai` / `xai`: required, the provider's model id as one line of 1–128 chars (e.g. `gpt-5`, `grok-4`), not checked against the provider. `"default"` is stored as `null` | yes |
| `effort` | string \| null | `null` | `low`, `medium`, `high`, `xhigh`, `max`; `null` = default. Ignored by `openai` / `xai` (kept as stored) | yes |
| `account` | string | `personal` | `personal` (`~/.claude`) or `company` (`~/.claude-company`). Ignored by `openai` / `xai`: their runs are named and recorded as `personal` (kept as stored) | yes |
| `mode` | string | `run` | `run` or `thread` (section 4) | yes |
| `permissionMode` | string | `bypassPermissions` | a `claude --permission-mode` value: `bypassPermissions`, `acceptEdits`, `auto`, `manual`, `dontAsk`, `plan`. Ignored by `openai` / `xai` (kept as stored) | yes |
| `createdAt` | string | — | ISO 8601 UTC, set by the store | no |
| `updatedAt` | string | — | ISO 8601 UTC, bumped by every update (metadata or instructions) | no |

- An update that changes `provider` must leave a valid `model` for the new provider: switching to
  `openai` or `xai` needs a model id in the same request (or already stored), and a model id that
  is not a Claude model is refused when switching back to `claude` (send `"model": null`).
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
| 400 | bad JSON, unknown or non-editable field, invalid value, bad name or runId, `files` for an `openai` / `xai` specialist |
| 404 | no such specialist or run |
| 409 | name already exists, profile invalid, `ifUpdatedAt` mismatch, thread busy, archive while runs are active, no usable key for an `openai` / `xai` specialist, a run continued on another provider than it was made with |
| 413 | instructions over 256 KiB, task text over 100 000 chars |
| 429 | 4 runs of this specialist are already active |
| 500 | the run could not be started (tmux or runner failed) |

**Profile object** (`P`): every field of section 2 plus

```json
{ "dir": "/abs/path/to/specialists/writer",
  "files": { "instructions": true, "settings": false, "mcp": false, "skills": ["tone-check"], "agents": [] } }
```

For `openai` / `xai` specialists the list and `GET` add `"keyError": null` when the key file has a
usable key for that provider, or the message `ask` would answer with (`"no key for xai: <what is
wrong>; see docs/guide/specialists.md"`). The key itself is never part of any response.

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
- `openai` / `xai`: `files` must be absent or empty (400; these specialists only get the task text),
  and without a usable key the answer is 409 `no key for <provider>: <what is wrong>; see
  docs/guide/specialists.md`. Nothing is started in either case.
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
`text` with the new turn's result. 409 while the run is not in a final state, and when the profile's
provider changed between Claude and `openai` / `xai` since the run was made (ask again instead). The
no-key 409 of `ask` applies too. Response as `ask`.

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

### OpenAI and xAI runs

An `openai` / `xai` run is a plain chat with the provider's `/chat/completions` endpoint, run by
`bin/api-runner.js` in the same tmux layout and over the same runner socket as a Claude run, so
runs, records, `wait`, `bd-ask`, the chat view and the states below behave the same.

- **Text only**: no tools, no files, no MCP servers, no skills, no permission prompts. The model
  sees the system prompt and the conversation, nothing else on the machine.
- **System prompt**: the profile's `CLAUDE.md`, with `@file` imports resolved the way Claude Code
  does it for text: relative to the importing file, up to 5 levels deep, not inside code fences or
  inline code. An import is only read when it stays inside the profile folder (by path and after
  resolving links), is a regular file and not a symlink; at most 256 KiB per file and 1 MiB in
  total. Anything else stays in the text as the literal `@…`.
- **Conversation**: the user message is the task. Every turn is one request. The conversation is
  kept in `.bd/conversations/<sessionId>.jsonl` (mode 0600, Claude Code's transcript format, which
  the chat view reads); a thread or a `send` replays it, keeping the newest 500 KiB of messages.
  This file is the run's `transcriptPath`. It only grows; the runner reads its last 4 MiB, so a
  long thread keeps working and simply forgets its oldest turns. When the task cannot be read back
  from it, the turn ends in `error` and nothing is sent.
- **Restart**: restarting the session during a turn drops the pending request and sends the same
  task again; the run waits for that answer.
- **Errors**: a request ends after 300 s. An answer over 8 MiB is refused as an error. A refused key (401/403), a wrong model or base URL (404),
  a rate limit or quota (429), a server error (5xx) and an unreachable host each end the run in
  `error` with a message that says which; interrupting it ends it in `stopped`. Error texts never
  contain the key.
- The key file is read again for every request, so a fixed key works on the next ask without a
  restart. Changing the provider of a live thread answers 409 until that thread session is ended.

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
separation (own Unix user, a broker for credentials) is a later phase. The OpenAI and xAI keys live
in their own file outside every profile (section 6).

## 6. Adding an xAI or OpenAI key

The dashboard never asks for a key and never writes one. You add it by hand:

1. Create the key file, readable only by you:

   ```sh
   mkdir -p ~/.config/beast-dash
   touch ~/.config/beast-dash/providers.json
   chmod 600 ~/.config/beast-dash/providers.json
   ```

2. Put your keys in it (only the providers you use):

   ```json
   {
     "openai": { "apiKey": "sk-your-openai-key" },
     "xai": { "apiKey": "xai-your-xai-key" }
   }
   ```

   `baseUrl` is optional and overrides the default endpoint (`https://api.openai.com/v1`,
   `https://api.x.ai/v1`), e.g. `"baseUrl": "https://gateway.example.com/v1"`. It must be `https://`
   (`http://` only for `127.0.0.1`, `localhost` or `[::1]`) and have no user, query or fragment.

3. In the dashboard, open the specialist, go to **Profile**, pick **OpenAI** or **xAI** as the
   provider, type the model id (e.g. `gpt-5`, `grok-4`) and save. A new specialist can pick its
   provider in the create dialog.

Rules the dashboard checks before every ask (the message says what to fix):

- The file is `~/.config/beast-dash/providers.json`; `BD_PROVIDERS_FILE` points it elsewhere.
- It must be a regular file, not a symlink, owned by you, with no group or other permissions
  (`chmod 600`), at most 64 KiB, and a JSON object.
- Each `apiKey` is one line of printable ASCII without spaces, at most 4096 chars.
- The server reads the file to check it, and the runner reads it for each request; neither keeps
  it. The key is never returned by the API,
  logged, passed on a command line or in a child's environment, or written into run records,
  transcripts or error messages.
