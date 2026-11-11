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
    .bd/                              owned by the dashboard: runs/<runId>.json, thread.json,
                                      trainer.json, feedback.jsonl (section 7)
    style.md, knowledge/, examples/   what training writes besides CLAUDE.md (section 7)
    .git/, .gitignore                 training history, made on first training (section 7)
    .secrets/accesses.json            credentials the specialist gets as env vars (section 7)
    …                                 anything else (notes, scripts) is its own business
  .trainers/<name>/                   working folder of a specialist's trainer session (section 7)
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
| 400 | bad JSON, unknown or non-editable field, invalid value, bad name or runId, `files` for an `openai` / `xai` specialist, bad upload file name, bad access name, undoing the starting point |
| 404 | no such specialist, run, commit, feedback or access |
| 409 | name already exists, profile invalid, `ifUpdatedAt` mismatch, thread busy, archive while runs are active, no usable key for an `openai` / `xai` specialist, a run continued on another provider than it was made with, trainer busy, an undo that conflicts with later changes, a training path that is a symlink |
| 413 | instructions over 256 KiB, task text over 100 000 chars, upload over 20 MiB, `knowledge/files/` full, feedback or access value over its limit |
| 415 | upload of a file type training does not take |
| 429 | 4 runs of this specialist are already active, 50 feedback records pending |
| 500 | the run or trainer could not be started (tmux or runner failed), git failed |

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
model and effort until it is restarted. Once the profile has a training history (section 7),
changed instructions are committed to it with source `profile`; every training commit bumps
`updatedAt`, so an editor holding an older `ifUpdatedAt` gets 409 instead of overwriting the
trainer's work.

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
| trainer session | `claude-spec-<name>_train` + `-company` (section 7); not a run, has no runId |

All match `^[A-Za-z0-9_.-]+$` and start with `claude-`, so hooks, session state and the chat view
treat them as dashboard chats. The name rules of section 2 make every id parse back to one
specialist (`parseRunId`, `specialistOfTmux` in the store); names never contain `_`, so a trainer
name can't be taken for a run or thread of another specialist. The session record in `lib/claude.js`
carries `specialist: "<name>"` (and `trainer: true` for a trainer session); the UI uses it to show
these sessions under Specialists, not under Sessions, and the restore list skips them.

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
a profile. Do not put secrets (API keys, passwords, tokens) in `CLAUDE.md`, any other tracked
profile file or `.mcp.json`: credentials a specialist needs go in its **Accesses** (section 7.6),
which keeps them out of the instructions, the training history and every API response, but not
away from your user or from the specialist itself (it can print them). Real separation (own Unix
user, a broker for credentials) is a later phase. The OpenAI and xAI keys live in their own file
outside every profile (section 6).

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

## 7. Training

You train a specialist by talking to its **trainer**: a Claude session that edits the profile for you.
On create you tell it what the specialist is for and how it behaves and hand it text and files; while
using the specialist you send it better versions of answers ("say this sentence like that") and
procedures ("this is how we do a rollback"). Every change the trainer (or anyone) makes to the
profile becomes a commit you can look at and undo. Credentials go into **Accesses**, never into the
conversation or the instructions.

### 7.1 What the trainer may change

| Path in the profile | Trainer | Tracked in history |
|---|---|---|
| `CLAUDE.md` | read, write | yes |
| `style.md` | read, write | yes |
| `knowledge/**` (uploads land in `knowledge/files/`) | read, write | yes |
| `examples/**` | read, write | yes |
| `specialist.json`, `.claude/**`, `.mcp.json`, `.bd/**` (past answers in `.bd/runs/`), `.git/**`, `.gitignore` | read only | no |
| `.secrets/**` | no (not even read) | no |

- `style.md`, `knowledge/` and `examples/` must be a regular file and real folders when they exist;
  a symlink at any of these paths (or `CLAUDE.md`) makes every training call answer 409.
- `CLAUDE.md` stays the specialist's entry point. The trainer keeps it short (well under the 256 KiB
  limit) and puts long material in `knowledge/`: a Claude specialist is told in `CLAUDE.md` which
  file to read for what; an `openai` / `xai` specialist only ever sees `CLAUDE.md` with its `@`
  imports (section 4, 1 MiB in total, text only), so the trainer imports what it must know with
  `@knowledge/…` and turns PDFs and images into text files first.
- When a trainer turn leaves `CLAUDE.md` over 256 KiB, the dashboard sends the trainer one automatic
  follow-up ("CLAUDE.md is N KiB, the limit is 256 KiB: move details into knowledge/") before it
  commits. If it is still too big after that, the commit is made anyway and the profile shows the
  413 error until it is fixed or undone.

### 7.2 The trainer session

- **One trainer per specialist**, a dashboard headless chat (`bin/headless-runner.js` in tmux) named
  `claude-spec-<name>_train`, plus `-company` when the specialist's `account` is `company`. It is a
  Claude session for every provider: `openai` / `xai` specialists are trained by a Claude trainer on
  the `personal` account. Model and effort are the account defaults.
- **Working folder** `<store root>/.trainers/<name>/`, outside the profile, so the specialist's
  `CLAUDE.md`, settings, hooks and MCP servers never load into the trainer. The dashboard owns this
  folder and rewrites its files at every trainer launch:
  - `CLAUDE.md`: the trainer's instructions (below).
  - `context.md`: the specialist's name, title, description, provider, model, mode, the profile
    path and the names and notes (never values) of its accesses. Rewritten whenever the profile's
    metadata or accesses change; the trainer reads it at the start of every turn.
  - `settings.json`: the permission rules of 7.1 as `permissions.allow` (`Read`, `Glob`, `Grep` on
    the profile and the trainer folder; `Edit`, `Write` on the four trainable paths, as `//<abs path>`
    rules) and `permissions.deny` (`Read`, `Edit`, `Write` on `.secrets/**`; `Edit`, `Write` on
    `specialist.json`, `.claude/**`, `.mcp.json`, `.bd/**`, `.git/**`, `.gitignore`).
- **Launch flags**: `--restricted` (no Bash or other code-running tools, no WebFetch, user, project
  and local settings files ignored, file tools confined to the working folders), `--tools
  Read,Glob,Grep,Edit,Write`, `--strict-mcp-config` (no MCP servers), `--permission-mode dontAsk`
  (anything the rules don't allow is refused, nothing ever asks), `--settings <trainer
  folder>/settings.json`, `--add-dir <profile>`. Because user settings are ignored, user hooks don't
  run for the trainer; its state comes from the runner like any headless chat.
- **Instructions** (`CLAUDE.md` of the trainer folder) say: you shape the specialist described in
  `context.md`, you are not that specialist; ask the owner when what they want is unclear, one
  question at a time; write what the owner tells you into the right file (behaviour and rules →
  `CLAUDE.md`, voice and wording → `style.md`, facts and procedures → `knowledge/`, real samples →
  `examples/`); work in uploaded files by summarising or importing them, not by copying them into
  `CLAUDE.md`; never write a credential into any file: when the owner pastes one, tell them to add it
  under Accesses and refer to it by its variable name; after a turn that changed files, say in plain
  words what changed and end the reply with one line `Summary: <what changed, under 80 chars>`.
- **State** is kept in `.bd/trainer.json`:

  ```json
  { "tmux": "claude-spec-writer_train", "account": "personal",
    "sessionId": "…uuid…", "transcriptPath": "/abs/…/<sessionId>.jsonl",
    "startedAt": 1762850000000, "turns": 3, "lastTurnAt": 1762850300000 }
  ```

  The first message starts the trainer. When its tmux session is gone, the next message relaunches it
  resuming `sessionId` (a new conversation when that transcript no longer exists). `fresh: true` on
  a send starts a new conversation; the old one is left as it is. Changing `account` starts a new
  trainer session; the old one is left alone. The trainer stays up between turns, like a thread.
- **Turns**: one at a time. The dashboard watches the trainer's runner events; when a turn ends (its
  `result`), it commits (7.3), updates feedback (7.5) and sends the next pending feedback.
- Archiving a specialist with a live trainer answers 409, like a live thread. `.trainers/<name>/`
  stays where it is; a new specialist with the same name reuses the folder (so the trainer's
  auto-memory), but not the conversation, which is recorded in the archived `.bd/trainer.json`.

### 7.3 History (git)

- The profile becomes a git repository the first time anything in this section touches it (a send,
  an upload, feedback, an undo). The dashboard runs `git init -b main`, writes `.gitignore` and
  commits the trainable files as they are, source `start`, message `Starting point`. Before that,
  `history` is empty and nothing else changes on disk.
- `.gitignore` is a whitelist the dashboard rewrites before every commit, so only the trainable
  paths are ever tracked:

  ```
  /*
  !/CLAUDE.md
  !/style.md
  !/knowledge/
  !/examples/
  ```

- **When it commits**: after every trainer turn (source `trainer`, message = the reply's `Summary:`
  line, or `Training: <changed paths>` without one), after every upload (`upload`, `Added <file>`),
  after an instructions update from the Profile tab (`profile`, `Edited instructions`), on undo
  (`undo`, `Undo: <message of the undone commit>`). Before a send, an upload, an undo and an
  instructions update, any uncommitted change is committed first as `outside`, `Changes made outside
  training`; at server start, likewise. Changes made by hand while a trainer turn runs end up in that
  turn's commit. Nothing is committed when nothing changed.
- Every commit bumps the profile's `updatedAt`. The source and the undone commit are trailers in the
  commit message (`Bd-Source: trainer`, `Bd-Undo: <sha>`).
- git runs with the dashboard's own identity and no outside config: `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null`, `-c core.hooksPath=/dev/null -c core.fsmonitor=false
  -c commit.gpgsign=false -c user.name=beast-dash -c user.email=beast-dash@localhost`, `-C <profile>`,
  arguments as an argv array (never a shell string), a 30 s timeout.
- **Undo** is `git revert` of one commit: a new commit that takes that change back, so undo itself
  can be undone. When later commits changed the same lines it answers 409 (`later changes touch the
  same lines; undo those first`) and leaves the files as they were. The `start` commit can't be
  undone (400).

### 7.4 Uploads

- Files go to `knowledge/files/<file name>`, one file per request, at most 20 MiB each, at most 500
  files and 200 MiB in `knowledge/files/` (413 beyond that).
- File types (by extension, case-insensitive; anything else is 415 `.<ext> files can't be used for
  training: save it as PDF or text`): text `md markdown txt text csv tsv json jsonl yaml yml toml xml
  html htm eml log sql ini conf sh js ts py`, documents `pdf`, images `png jpg jpeg gif webp`. The
  content is not checked or converted; the trainer reads it with its Read tool.
- File name: the base name the client sends, NFC-normalised; every character that isn't a letter,
  digit, space, `.`, `_`, `(`, `)` or `-` becomes `-`, runs of `-` and spaces collapse, the result is
  trimmed to 100 chars with its extension kept. Empty, starting with `.` or `-`, or without an
  allowed extension is 400. When taken, `-2`, `-3`… is added before the extension. The response
  returns the name used.
- Written to a temporary file in `knowledge/files/` and renamed into place; the folder must resolve
  inside the profile and not be a symlink (409). Each upload is its own commit.
- An upload does not message the trainer. The Train tab uploads the files, then sends one message
  naming them (`files` in 7.7).

### 7.5 Feedback

Feedback is "this answer, but better": the answer a specialist gave, the version the owner wanted,
and/or a note. It is kept in `.bd/feedback.jsonl` (one JSON object per line, newest last; rewritten
atomically on change) and handed to the trainer as a message.

**Feedback object** (`F`):

```json
{ "id": "fb-mhv0k2a1-4f3a", "runId": "claude-spec-writer-261111-0930", "original": "Hi …",
  "better": "Hello …", "note": "Never open with Hi to a client.", "state": "applied",
  "createdAt": 1762850000000, "sentAt": 1762850001000, "appliedAt": 1762850040000,
  "commit": "3f1c…40 hex", "error": null }
```

- `id`: `fb-<base36 ms>-<4 hex>`. `runId`: a run of this specialist or `null`. `original`: the
  answer, up to 200 KiB (when absent and `runId` is set, the run's `text`). `better`: the improved
  answer, up to 200 KiB, or `null`. `note`: up to 10 000 chars, or `null`. At least one of `better`
  and `note` is required.
- **States**: `pending` (waiting for the trainer to be free) → `sent` (its message went to the
  trainer) → `applied` (that turn ended with success; `commit` is the turn's commit, or `null` when
  the trainer changed nothing) or `failed` (that turn ended in error or was stopped, or the trainer
  went away; `error` says why). A failed record can be sent again (7.7).
- Pending feedback goes out one record per turn, oldest first, as soon as the trainer is idle; a
  record makes the trainer start when it isn't live. At most 50 records can be pending (429).
- The message the trainer gets:

  ```
  Feedback on an answer from <title> (run <runId>):

  The answer it gave:
  <original as a quoted block>

  A better version:
  <better as a quoted block>

  Note from the owner: <note>

  Change the profile so future answers come out like the better version. Change only what this
  feedback is about.
  ```

  (sections without a value are left out).

### 7.6 Accesses

Credentials a specialist needs (a database URL, a token) are **accesses**: named values the
dashboard stores for that specialist and hands to its Claude runs as environment variables.

- Stored in `<profile>/.secrets/accesses.json`: folder 0700, file 0600, owned by you, at most 1 MiB,
  written atomically; refused (409) when either is a symlink or has wider permissions. Shape:
  `{ "DB_URL": { "value": "…", "note": "read replica", "updatedAt": "2026-11-11T08:30:05.123Z" } }`.
- `name`: `^[A-Z][A-Z0-9_]{1,63}$`, not `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `PWD`, `TERM`,
  `LANG`, `TMPDIR`, `TZ`, and not starting with `LC_`, `LD_`, `DYLD_`, `XDG_`, `NODE_`, `NPM_`,
  `GIT_`, `SSH_`, `TMUX`, `CLAUDE`, `ANTHROPIC`, `BD_`, `BEAST_`. `value`: a string of 1–65 536
  bytes without NUL (multi-line allowed). `note`: one line, 0–200 chars. At most 50 accesses.
- **Use**: when the runner starts or restarts Claude for a run or thread of a `claude` specialist,
  it reads the file and puts every access into the Claude process's environment (and so the
  commands it runs). The names and notes, never the values, are added with
  `--append-system-prompt` ("Accesses, as environment variables: DB_URL (read replica), …; use them
  by name, never print them"). A live thread keeps the accesses it started with until restarted.
  The trainer and `openai` / `xai` runs never get the values; the trainer sees names and notes in
  `context.md`.
- Values are never returned by the API, logged, put in argv, tmux options or run records, or
  committed. Typed into the trainer chat instead, a value stays in that chat's transcript; the
  trainer is told to refuse to write it anywhere.

**Access object** (`A`): `{ "name": "DB_URL", "note": "read replica", "bytes": 58, "updatedAt": "…" }`.

### 7.7 Endpoints

All under `/api/specialist/<name>/`, with the errors of section 3. The specialist must be valid
(409 otherwise). Times are epoch ms except `updatedAt` of accesses (ISO, like `specialist.json`).

**Trainer object** (`T`): `.bd/trainer.json` plus `"live": true|false` and `"state": "idle" |
"working" | "waiting" | null` (runner state, `null` when not live). `null` before the first message.

**Commit object** (`C`):

```json
{ "id": "3f1c…40 hex", "short": "3f1c2ab", "message": "Shorter greetings for clients",
  "source": "trainer", "at": 1762850040000, "undoOf": null, "undone": false,
  "files": [ { "path": "style.md", "change": "modified" } ] }
```

`source`: `start`, `trainer`, `upload`, `profile`, `outside`, `undo`. `change`: `added`,
`modified`, `deleted`. `undoOf`: the sha this commit undid, or `null`. `undone`: a later commit
undid this one (and that undo was not itself undone).

| Method and path | Request | Response |
|---|---|---|
| `GET train` | — | `{ ok, trainer: T \| null, history: { ready, head: sha \| null, commits: [C…newest 20] }, feedback: [F…newest 20], accesses: [A…], uploads: { files, bytes, maxFiles: 500, maxBytes: 209715200 } }` |
| `POST train/send` | `{ text, files?: ["knowledge/files/a.pdf", …], fresh?: false }` | `{ ok, trainer: T }`. Starts or resumes the trainer and sends `text`, with `\n\nFiles the owner added:\n- knowledge/files/a.pdf` when `files` (up to 50 paths, each an existing file under `knowledge/files/`) is given. `text` 1–100 000 chars. 409 `trainer is busy` while a turn runs or feedback is being sent |
| `GET train/history?limit=50&before=<sha>` | — | `{ ok, commits: [C…], more: bool }`, newest first, `limit` 1–200; `commits: []` before the first training |
| `GET train/commit/<sha>` | — | `{ ok, commit: C, diff: "<unified diff>", truncated: bool }`, diff capped at 512 KiB, binary files as git prints them. `sha`: 7–40 hex, must name a commit in this profile's history (404) |
| `POST train/undo` | `{ commit: "<sha>" }` | 201 `{ ok, commit: C }` (the new undo commit); 409 while a trainer turn runs or on conflict, 400 for the `start` commit |
| `POST train/upload?filename=<url-encoded name>` | the raw file bytes as the body (any `Content-Type`) | 201 `{ ok, file: { path: "knowledge/files/a.pdf", bytes }, commit: C }`; 413 as soon as the body passes 20 MiB |
| `GET train/feedback?limit=50` or `?ids=fb-…,fb-…` | — | `{ ok, feedback: [F…] }`, newest first, `limit` 1–500, `ids` up to 50 |
| `POST train/feedback` | `{ runId?, original?, better?, note? }` | 201 `{ ok, feedback: F, trainer: T \| null }`; sent at once when the trainer is idle or not live |
| `POST train/feedback/<id>/retry` | — | `{ ok, feedback: F }`; only for `failed` (409 otherwise), back to `pending` |
| `GET accesses` | — | `{ ok, accesses: [A…] sorted by name, usedByRuns: provider === "claude" }` |
| `POST accesses` | `{ name, value, note? }` | `{ ok, access: A }`; creates or replaces |
| `POST accesses/<NAME>/delete` | — | `{ ok, name }`; 404 when there is no such access |

The trainer's conversation is shown through the chat endpoints every headless chat uses (its tmux
name and `transcriptPath` are in `T`); messages to it go through `train/send`, so the outside-change
commit and the busy check apply. `GET /api/specialists` and `GET /api/specialist/<name>` add
`"trainer": { "live", "state", "pendingFeedback" } | null` to each profile.
