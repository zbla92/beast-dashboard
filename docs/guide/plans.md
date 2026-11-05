# Plans

A plan is a multi-step piece of work an agent runs across sessions: phases, tasks, what is next and
what waits on you. Beast Dash keeps plans **outside your repos** and shows them live on every
session. This page is the contract the CLI (`bin/plan`), the SessionStart hook, the server and the
UI share. Parser, serializer and validator: [`lib/planfile.js`](../../lib/planfile.js). Examples:
[`test/fixtures/plans/`](../../test/fixtures/plans/).

- `plan.md` is the only source of current state. Checkbox markers are the progress.
- `events.jsonl` next to it is an append-only log (the timeline). It never decides state.
- Agents change status only through `plan` (it validates and logs each change). Content
  (task cards, notes, new tasks and phases) may be edited by hand; run `plan validate` afterwards.
- The feature is opt-in: ⚙ Settings → Plans, setting `plans` (default `false`). With it off, no hook is installed and
  the UI hides plans.
- This page says how plans work. When an agent should make one is in the [agent rules](agent-rules.md).

## 1. `plan.md`

```markdown
---
topic: search-v2
title: Search v2
repo: /srv/demo-app
status: active
created: 2026-11-03T07:58:00Z
---

Goal: replace the LIKE-based search with a ranked full-text index.

## Next

T6 Query endpoint: finish cursor pagination, then run the gate.

## Waiting on you

- q1 Re-index the legacy synonym lists, or only copy them? · blocks T9 · asked 2026-11-03T10:41:00Z
  Re-indexing changes ranking for existing queries; copying keeps them as they are.

## Phase 1 — Index

- [x] T1 Index schema · Opus · gate ✓ 12 tests
  Goal: freeze the search_documents table.
  Owns: db/migrations/0042_search.sql
- [!] T2 Contract tests · Sonnet · gate ✗ lint · 2 errors
- [~] T3 Query endpoint · Sonnet
- [?] T4 Import legacy synonyms · Opus
- [ ] T5 Runbook
```

### Frontmatter

Between two `---` lines, one `key: value` per line (no YAML quoting; the value is the rest of the
line). Unknown keys are kept as they are.

| Key | Required | Value |
|---|---|---|
| `topic` | yes | `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; equals the plan's folder name in the store |
| `title` | yes | one line, not empty |
| `repo` | yes | absolute path of the repo's **main** worktree |
| `status` | yes | `active`, `finished` or `done`, table below; anything else is a validation error |
| `created` | yes | ISO time, UTC, `2026-11-03T07:58:00Z` |
| `archived` | no | ISO time, set by `plan archive` |

| Status | Meaning | Set by |
|---|---|---|
| `active` | work is going on | `plan new`, a reopen, `plan restore` of an incomplete plan |
| `finished` | every task is done, or someone called it finished. Still a live plan: resolved, claimable, changeable, in `plan context` of a session that claimed it, mapped to the sessions that claimed it. Nothing archives it by itself | the `plan done` of the last task, `plan finish`, `plan restore` of a complete plan |
| `done` | archived: lives in `_archive/`, refuses changes until restored | `plan archive` |

### Sections

Level-2 headings (`## `, outside fenced code) split the file. The text before the first one is the
**preamble** (free text, e.g. the goal). Section order is free; `plan new` writes preamble, Next,
Waiting on you, then you add phases.

- `## Phase N — Name` — a phase. `N` runs 1, 2, 3… in file order. Em dash with a space on each
  side. Free intro text may come before the first task.
- `## Next` — required, once, may be empty. Free text: the handoff note an agent reads after
  `/clear` ("what exactly to do next"). Replaced with `plan next`.
- `## Waiting on you` — required, once, may be empty. Open questions for the user.
- Any other `## Heading` (Decisions, Notes, Gate…) is kept verbatim and shown as a text section.

### Task line

```
- [<marker>] <id> <title>[ · <model>][ · gate ✓|✗[ <text>]]
```

| Marker | Status | Meaning |
|---|---|---|
| `[ ]` | `todo` | not started |
| `[~]` | `doing` | in progress |
| `[x]` | `done` | finished |
| `[?]` | `blocked` | needs you (usually blocked by an open question) |
| `[!]` | `failed` | the gate failed; the task is still open |

- `id`: `T` + number, optional lowercase letter for an insert (`T3`, `T3a`); unique in the plan.
- Fields are separated by ` · ` (space, U+00B7 middle dot, space). Segments after the title are
  read from the left: a model name starts the fields; until then, ` · ` is part of the title.
- `model`: `Opus`, `Sonnet`, `Haiku`, `Fable` or `main` (the main session). Optional.
- `gate`: optional and always last; everything after `gate ✓ ` / `gate ✗ ` to the end of the
  line is the gate text, so it may contain ` · ` (`gate ✗ lint · 2 errors`). `gate ✓` alone is fine.
- **Task card**: the lines under a task indented by two spaces (blank lines inside are allowed)
  are its body, free markdown: goal, plan sections to read, files it owns, files it must not
  touch, the command that must pass. Tabs are an error.

### Question line (in `## Waiting on you`)

```
- <qid> <question>[ · blocks <T5>, <T6>] · asked <ISO time>
  <optional detail, indented two spaces>
```

`qid` is `q` + number and is never reused within a plan (numbering continues past answered
questions, which leave the file; the answer goes to `events.jsonl`). `blocks` names tasks that
can't start until it is answered. `asked` is required.

### Canonical form and validation

- `parse(serialize(parse(x)))` is stable and `serialize(parse(x)) === x` for every canonical file
  (no warnings). The parser keeps blank lines between blocks.
- Accepted with a **warning** and written back canonical: `[X]`, model in another case, `## Phase
  1 - Name` (`-`, `–`, `:`), `## next`, `blocks T2,T3`, CRLF, a missing final newline,
  whitespace-only lines (written back empty).
- **Errors** (`plan.md:<line>: <message>`): missing/invalid frontmatter keys, phases not numbered
  1…N, unknown marker, task without id or title, duplicate task or question ids, unknown task
  field, bad gate syntax, text between tasks that is not indented, tab-indented card lines,
  question without `asked`, `blocks` naming a task that does not exist, `## Next` or
  `## Waiting on you` missing or repeated. The CLI refuses to change a plan with errors and prints
  them; the server still serves it (best effort) with the errors attached.

## 2. `events.jsonl`

One JSON object per line, appended with `O_APPEND` after `plan.md` has been written. Keys appear in
this order and are omitted when empty:

```json
{"ts":"2026-11-03T10:21:00.000Z","type":"fail","task":"T5","session":"claude-search","gate":{"ok":false,"text":"lint · 2 errors"}}
```

| Key | Type | |
|---|---|---|
| `ts` | ISO time with ms (`Date#toISOString`) | required |
| `type` | see below | required |
| `task` | task id | start, done, undo, fail; optional on note |
| `q` | question id | ask, answer |
| `phase` | phase number | phase |
| `session` | tmux session name of the writer, if any | optional |
| `text` | string | create: title · ask: question · answer: the answer · note: the note · phase: phase name · finish: `all tasks done` or `marked finished` |
| `gate` | `{ ok: boolean, text: string }` | done (optional), fail (required, `ok: false`) |

Types: `create` (plan made or imported), `start`, `done`, `undo` (a task went back to open), `fail`, `ask`, `answer`, `note`, `phase`
(every task of phase N is done; written by `plan done` when it completes a phase), `finish`
(the plan became finished), `reopen` (a finished plan went back to active), `archive`, `restore`.
`plan next` and hand edits write no event. Readers skip lines that are not valid JSON or fail
validation and report how many they skipped.

Derived from events (not stored in `plan.md`): a task's `started` (last `start`), `finished` (last
`done`, cancelled by a later `undo`), the plan's `lastGate` (last event with `gate` whose task was not
undone after it) and `updated` (last event).

## 3. Store layout

```
$BEAST_PLANS_DIR                      default ~/.beast/plans
  .claims/<urlencoded tmux name>.json  {"plan":"<repoDir>/<topic>","at":"<ISO>"}
  <repoDir>/
    .repo                             absolute path of the main worktree + "\n"
    <topic>/plan.md
    <topic>/events.jsonl
    <topic>/.lock                     present while a plan command writes
    <topic>/legacy-PLAN.md            only for imported plans (copies)
    _archive/<YYYY-MM-DD>-<topic>[-N]/plan.md, events.jsonl
```

- **Repo resolution** from any directory: `git rev-parse --path-format=absolute --git-common-dir`;
  if it ends in `/.git`, the main worktree is its parent, otherwise (submodule, bare repo) the
  first entry of `git worktree list --porcelain`. Paths are realpaths. So a linked worktree
  (`.claude/worktrees/x`, `git worktree add …`) maps to the same plans as the repo. Not in a git
  repo: commands that need a repo fail unless `--repo <path>` is given.
- **repoDir** = basename of the main worktree, characters outside `[A-Za-z0-9._-]` replaced by
  `-`, leading `.`, `_`, `-` dropped, max 48 chars (empty → `repo`).
- **Collisions**: the folder belongs to the repo written in its `.repo`. Another repo with the same
  basename takes `<name>-2`, `<name>-3`, … (first free slot, created with an exclusive write).
  Moving a repo does not move its plans: rename the folder or edit `.repo` by hand.
- **Archive**: `plan archive` sets `status: done` and `archived:`, logs `archive`, and moves the
  folder to `<repoDir>/_archive/<date>-<topic>` (`-2`… if taken). The topic is then free again.
  A failed move puts `plan.md` and `events.jsonl` back, so the plan stays live as it was.
- **Restore**: `plan restore <folder>` moves `<repoDir>/_archive/<folder>` back to
  `<repoDir>/<topic>` (topic from the frontmatter), drops `archived:`, sets `status: finished` if
  the plan has tasks and all are done, else `active`, and logs `restore`.
- Plan **ids** (API and SSE): `<repoDir>/<topic>`, archived: `<repoDir>/_archive/<folder>`.
- Folders and files are only read when they are real directories/files (symlinks are skipped).

## 4. CLI: `bin/plan`

`plan <command> [args] [flags]`. Global flags: `--plan <topic>` (pick the plan), `--repo <path>`
(resolve the repo from this path instead of the cwd), `--session <name>` (default: the tmux
session of `$TMUX_PANE`, found the way `bin/claude-hook.sh` does; none outside tmux). A bare `--`
ends the flags: every argument after it is text, even one that starts with `--`
(`plan answer --plan search-v2 -- q1 "--plan=x copy them"`).

**Which plan** a command acts on:
1. `--plan <topic>` in the current repo;
2. else the session's claim (`plan use`), if it points to an active plan of this repo;
3. else the repo's only live plan (`status` is not `done`, so `finished` counts);
4. else exit 3 with the candidates listed.

A session that has no live claim also claims the plan it acted on with a command that changes it
(`start`, `done`, `fail`, `ask`, `answer`, `next`, `note`, `finish`), so a chat that works on a plan
keeps it. A live claim is never taken away this way, not even with `--plan` on another plan.
Read-only commands claim nothing.

| Command | Does | Event |
|---|---|---|
| `new <topic> --title "<t>" [--goal "<g>"]` | creates the plan skeleton (and `.repo`), claims it for the session, prints the `plan.md` path | create |
| `list [--all] [--json]` | plans of this repo (`--all`: every repo, archived too) | |
| `show [--json]` | status overview; `--json` = the detail shape of §5 | |
| `path` | prints the absolute `plan.md` path (for hand edits) | |
| `validate [file]` | parses the plan (or a file) and prints errors and warnings | |
| `context` | SessionStart hook mode, below | |
| `use <topic>` / `use --clear` | the session claims a plan of this repo / drops its claim | |
| `start <T>` | → doing. Refused if done or blocked by an open question | start |
| `done <T> [--gate "<text>"]` | → done, gate `✓ <text>` (no `--gate` clears the gate). Refused if blocked. The last open task adds ` · plan finished. Ask the user whether to archive it; do not archive without asking.` to the output | done (+ phase, finish) |
| `undo <T>` | → open (`[ ]`, gate gone; `[?]` when an open question still blocks it). On a finished plan also → active. Already open or blocked: exit 0, `already open`, nothing written | undo (+ reopen) |
| `fail <T> --gate "<text>"` | → failed, gate `✗ <text>` | fail |
| `ask "<question>" [--blocks T5,T6] [--detail "<text>"]` | adds the next `qN` to Waiting on you; named tasks → blocked (done tasks refused) | ask |
| `answer <qN> "<answer>"` | removes the question; tasks it blocked go back to todo unless another question still blocks them | answer |
| `next "<text>"` | replaces the `## Next` text (`""` empties it) | |
| `note "<text>" [--task T]` | logs a note only | note |
| `finish` | active → finished, also with open tasks, and prints `<topic> · plan finished. Ask the user whether to archive it; do not archive without asking.` Already finished: exit 0, `already finished`, nothing written | finish |
| `archive` | archives the plan, active or finished (see §3) | archive |
| `restore <folder>` | brings an archived plan of this repo back (see §3). Topic taken: exit 1, `plan <topic> already exists for <repo>` | restore |
| `import <dir> [--topic <name>]` | copies a legacy `docs/<topic>/` (PLAN.md + PROGRESS.md) into the store, below | create |
| `help` | usage | |

- Every mutation takes `<dir>/.lock` (exclusive create, waits up to 3 s, a lock older than 15 s is
  stale), re-reads and validates `plan.md`, applies the change, writes `plan.md` atomically (temp
  file + fsync + rename), then appends the events.
- **Finish and reopen** happen inside the lock of the command that causes them:
  - `done` leaving every task done on an `active` plan → `finished`, event `finish` with text
    `all tasks done`. `plan finish` writes the text `marked finished`.
  - `start`, `fail`, `ask --blocks`, `undo`, or a `done` that leaves a task open, on a `finished` plan →
    `active`, event `reopen`. A task added by hand does not reopen the plan; its `start` does.
    `ask` without `--blocks`, `answer`, `next` and `note` leave the status alone.
- **Archiving is never automatic.** When a plan becomes finished, Claude asks the user whether to
  archive it: the output of `plan done` and `plan finish` says so, and so does `plan context`.
- Output: one short line on success (`T6 doing · Query endpoint`), errors on stderr as
  `plan: <message>`. `--json` output is the API shape.
- **Exit codes**: `0` ok · `1` refused (bad state change, unknown task or question, plan has
  validation errors, plan exists, lock busy) · `2` usage (unknown command or flag, missing
  argument, bad id, topic or folder) · `3` no plan (not in a repo, no active plan, several and none
  picked, `--plan` not found, no such archived folder).
- **import**: title = first `# ` heading of PLAN.md (else the topic); each `##`-section of
  PROGRESS.md with checkboxes becomes a phase (a `Phase N — ` prefix is stripped); top-level
  checkboxes become tasks, `[x]` → done, others → todo; a leading `T3` keeps its id when unique,
  others get the next free `T<n>`; a trailing `(Opus)`-style model becomes the model field;
  indented checkboxes go into the task card. `## Next` = the first open task. PLAN.md and
  PROGRESS.md are copied as `legacy-PLAN.md` / `legacy-PROGRESS.md`. The repo is never written to.

### `plan context` (SessionStart hook)

Installed (only when `plans` is on) as a SessionStart command hook. It reads the hook input JSON on
stdin — `session_id`, `transcript_path`, `cwd`, `hook_event_name: "SessionStart"`, `source`
(`startup`, `resume`, `clear`, `compact`, `fork`) — and resolves the plan from `cwd` and the tmux
session. Only a claim or `--plan` picks a plan here; the repo's only live plan is not enough. Claude Code adds a SessionStart hook's plain stdout (exit 0) to the
agent's context; it caps it at 10,000 characters, our budget is ≈ 400 tokens (≤ 1,600 chars).

- No claim and no unfinished live plan for the repo, `plans` off, or any error: **prints nothing**,
  exit 0. It never fails the session start. With no claim, finished plans are never offered.
- `cwd` not inside a git repo (e.g. a folder of projects): the unfinished live plans whose `repo` is
  that folder or below it, most recently changed first, max 5; nothing when there are none:

```
Not a git repository. Active plans in repos under /home/u/dev:
demo-app/search-v2 "Search v2" 4/10, now T6 (/home/u/dev/demo-app)
Continue one by working in its repo, or pass --repo <path> to the plan CLI.
```
- No claim and one unfinished live plan:

```
Open plan in this repo, not picked by this session: search-v2 "Search v2" 4/10. If the user wants to continue it: plan use search-v2. Do not work on it otherwise.
```
- The claimed plan (or `--plan`), facts, no instructions in imperative system style:

```
Plan search-v2 "Search v2" (demo-app): 4/10 tasks done, phase 2/3 API. File: /home/u/.beast/plans/demo-app/search-v2/plan.md
Status changes go through the plan CLI: plan start|done|fail|ask|answer|next|note (plan help).
Now: T6 Query endpoint (Sonnet), doing since 10:34 UTC.
Failed: T5 Contract tests, gate ✗ lint · 2 errors.
Waiting on the user: q1 Re-index the legacy synonym lists, or only copy them? (blocks T9)
Answered: q2 "Keep the old /search route during the rollout?" → Yes, until the app ships v4.
Next: T6 Query endpoint: finish cursor pagination (`after` param), then run the gate. …
Then: T7 Rate limits (Sonnet), T8 Feature flag (Haiku).
```

  A finished plan gains the line `This plan is finished. Ask the user whether to archive it; do not
  archive without asking.` after the second line.
  Lines without content are left out; `Next:` is clipped to 600 chars, `Then:` lists up to 3 todo
  tasks after `now`. `Answered:` lists up to 3 `answer` events newer than the plan's last `start`
  event, oldest first, as `qN "<question, clipped to 80>" → <answer, clipped to 160>`, joined
  with `; `.
- Several unfinished live plans and no claim: one line per plan (`search-v2 4/10, now T6`, max 5) plus
  `Pick one with: plan use <topic>`.

## 5. Server API

Plans are read from the store (`BEAST_PLANS_DIR`, default `~/.beast/plans`); legacy
`docs/<topic>/PLAN.md` + `PROGRESS.md` keep working unchanged.

- `GET /api/plans` — unchanged legacy map `{ <projectId>: [{ topic, done, total, next, mtime }] }`.
- `GET /api/plans?v=2` — `{ plans: [PlanSummary], legacy: <the legacy map> }`. Live plans plus
  plans archived in the last 14 days (`&archived=1`: all).
- `GET /api/plan/<projectId>?topic=<t>[&file=<rel>]` — unchanged legacy detail / file.
- `GET /api/plan/<repoDir>/<topic>` and `GET /api/plan/<repoDir>/_archive/<folder>` — `PlanDetail`,
  `404 {error:"no such plan"}`. (Legacy has one path segment after `/plan`, the store two or three.)

`PlanSummary` = `summarize()` in `lib/planfile.js` plus server fields:

```js
{ id: 'demo-app/search-v2', repoDir: 'demo-app', projectId: 'demo-app' /* project whose path is repo, or null */,
  sessions: ['claude-search'] /* tmux sessions that claimed this plan */,
  offered: ['claude-other'] /* sessions in this repo with no claim, when this is its only unfinished live plan */,
  mtime: 1762166460000 /* plan.md, ms */,
  topic, title, repo, status: 'active', created, archived: null, updated,
  done: 4, total: 10, pct: 40, complete: false,
  finished: false /* status finished, or active with every task done */,
  finishedAt: null /* status finished: last finish event; else, when finished: latest task finish; else null */,
  phase: { n: 2, of: 3, name: 'API', done: 1, total: 4 },
  now: { id: 'T6', title, status: 'doing', model: 'Sonnet', gate: null, since: '<ISO>' },   // first doing, else first failed
  next: { id: 'T7', title, status: 'todo', model: 'Sonnet', gate: null },                  // first todo
  nextNote: '<## Next, max 300 chars>',
  waiting: [{ id: 'q1', q: '…?', blocks: ['T9'], asked: '<ISO>' }],
  lastGate: { ok: false, text: 'lint · 2 errors', task: 'T5', at: '<ISO>' },
  errors: 0 }
```

`PlanDetail` = `detail()` plus the same server fields: the summary, with `nextNote` in full and

```js
{ preamble: '…',
  phases: [{ n, name, intro, done, total,
    tasks: [{ id, title, status, model, gate: { ok, text } | null, body, by: ['q1'], started, finished }] }],
  waiting: [{ id, q, detail, blocks, asked }],
  sections: [{ heading: 'Decisions', text: '…' }],
  timeline: [/* last 200 events, oldest first */],
  errors: [{ line, msg }] }
```

The task in `now` may carry `steps: [{ c, s }]` — the mapped session's latest TodoWrite list
(`c` = text, `s` = `pending` | `in_progress` | `completed`), added by the server (phase 3).

- `POST /api/plan-answer` `{ id, q, text }` — answers an open question of a live plan, the same
  as `plan answer` (the dashboard's Save to plan, used when no live session runs the plan). It runs
  this checkout's `bin/plan` (`answer --repo <repo> --plan <topic> -- <q> <text>`) with no shell,
  cwd = the store root, `TMUX`/`TMUX_PANE` removed, 10 s timeout, one at a time. Checks first:
  unknown `id` → `404 no such plan`; archived → `400`; no `.repo` marker → `409`; `q` not like
  `q1` → `409`; `text` not a string, empty or over 2,000 chars after trimming, or with control
  characters → `400`; `q` not an open question → `409 no open question qN`. Then the exit code
  decides: `0` → `200 { ok: true, id }`, `1` → `409`, `2` → `400`, `3` → `404`, no start or timeout
  → `500`; the error is the first line of stderr without `plan: `, max 300 chars. It is an `/api`
  POST, so the Host, same-origin and `Sec-Fetch-Site` guards apply.
- `POST /api/plan-finish` `{ id }` — `plan finish` on a live plan: `200 { ok: true, id }` with the
  same id, also when it was already finished.
- `POST /api/plan-archive` `{ id }` — `plan archive` on a live plan: `200 { ok: true, id }` with the
  new id `<repoDir>/_archive/<folder>`.
- `POST /api/plan-restore` `{ id }` — `plan restore` on an archived plan:
  `200 { ok: true, id }` with the new id `<repoDir>/<topic>`; topic taken → `409`.
- `POST /api/plan-step` `{ id, task, done }` — the tick box of a step: `plan done` (`done: true`) or
  `plan undo` (`done: false`) on a live plan, `200 { ok: true, id }` with the same id. `task` not a
  task of that plan → `409 no task T`; `done` not a boolean → `400`. Ticking a task that is already
  done answers `200` and writes nothing, so its gate stays. A blocked task refuses with `409`.
- `POST /api/plan-complete` `{ id }` — the Complete press: `plan finish`, then `plan archive`, one
  after the other in one queue slot. `200 { ok: true, id }` with the new archived id. If archive fails
  after finish the plan stays finished and the error comes back.

  These run `bin/plan` the way `plan-answer` does, in the same queue, with the same exit code
  mapping and guards. Unknown or malformed `id` → `404 no such plan`; an archived id for finish,
  archive, step or complete, or a live id for restore → `400`; no `.repo` marker → `409`. Errors are
  `{ ok: false, error }`. Agents use the CLI; the panel only presses `plan-step`, `plan-complete`,
  `plan-restore` and `plan-answer`.

**No auto-archive**: no timer and no sweep. A plan is archived only when the user presses Archive or
says so. A plan with `status: active` and every task done stays as it is; `summarize` reports it as
`finished`.

With `BD_TEST=1` all these endpoints answer `403 test copy has no plan store` unless `BEAST_PLANS_DIR`
is set and is not the user's real store (`~/.beast/plans` or below it), so a test copy can never
change real plans.

**Session ↔ plan**: for a tmux session, its cwd is resolved to a repo as in §3; the plan is its
claim (`.claims/<name>.json`) if that names a live plan of the same repo, else none. The repo's only
plan is not mapped to a session that did not pick it; it is only offered (`offered` above). `/clear`
keeps the tmux session and so the claim.

In the dashboard a session with no plan shows `No plan · Make a plan…`, then
`{topic} {done}/{total} · Continue?` when it is offered one, which asks Claude to run `plan use`. The
⋯ menu of the session's own plan has `Leave this plan`, which asks Claude to run `plan use --clear`;
it is how a chat kept by `/clear` gets rid of an old plan. Both need a live session. On a phone there
is no strip at the top of a session: the same things are in the session Options menu, as
`Plan · {topic} {done}/{total}` with a plan, else `Make a plan…`, `Continue {topic}…` when offered and
`Archived plans…`.

**Live updates**: the server watches the store (`fs.watch`, recursive) and broadcasts on the
existing `/api/events` stream, debounced ~300 ms per plan:

```
event: plan
data: {"id":"demo-app/search-v2","mtime":1762166460000,"removed":false}
```

Clients refetch `GET /api/plan/<id>` (and the summary). An archive sends `removed: true` for the
old id and an event for the new one; a restore does the same in the other direction.
