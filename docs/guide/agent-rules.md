# Agent rules

The dashboard shows what your agents do. It does not tell them how to work. Those rules belong in Claude Code's
personal memory file, `~/.claude/CLAUDE.md`, which every session on every project reads. The `CLAUDE.md` in this repo
does not do that job: it applies only when an agent works on Beast Dash itself.

The block at the bottom of this page is a ready starting point. It covers uploads, which model does what, plans,
what "done" means and when to stop and ask. Nothing is added unless you say yes.

## Adding them

`./install.sh` asks, for each Claude login, whether to add the rules. The answer defaults to no. It asks on each run
until the block is in, and again when an update changes the block. Without a terminal, for example under an agent, it
only prints a hint.

```bash
node bin/agent-rules.js --status    # is the block in each CLAUDE.md, and is it current?
node bin/agent-rules.js --install   # add it, or update it, without asking
node bin/agent-rules.js --remove    # take it out again
node bin/agent-rules.js --print     # print the block
```

It works on `~/.claude/CLAUDE.md` and, if that login exists, `~/.claude-company/CLAUDE.md`. The block goes at the end of
the file, between two markers. Your own text outside the markers stays; only blank lines next to the block and the
last line ending can change. A file that isn't UTF-8 is skipped. An update replaces what is between the markers, so keep
your own rules outside. If a marker is missing or doubled, the file is left alone and you are told.

You can also copy the block by hand and change it. Keep the two marker lines so the tool can find it. `./install.sh`
then offers to replace your version on each run; answer no to keep it.

## What backs them up

- **Uploads:** `bin/install-hooks.js` installs `bin/pasted-guard.sh`, which refuses a search of the whole `.pasted`
  folder or of another project's folder. It stops most accidents, not all. See [Uploaded files](claude-code.md#uploaded-files).
- **Plans:** turn on ⚙ Settings → Plans. That links the `plan` command and adds the hook that tells a session about its
  plan. See [Plans](plans.md).
- **New sessions:** `./install.sh` links the `bd-chat` and `bd-ask` commands. See [From an agent or a script](claude-code.md#from-an-agent-or-a-script).
- **Models:** nothing enforces the table. It is guidance the agent follows.

## The block

```markdown
<!-- beast-dash agent rules -->
## Working with Beast Dash

### Uploaded files
- Files the user uploads land in `.pasted` inside the dev folder, one subfolder per project.
- Never search, list or open `.pasted` as a whole. When searching across the dev folder, exclude it.
- Use only the current project's subfolder (`.pasted/<project>/`), plus any file the user names explicitly.
- Never open `_unsorted` or another project's folder unless the user asks.
- A file's location says nothing about whether it is relevant. Do not read a file to find out; ask.

### Which model does what
The main session coordinates: it splits the work, hands out tasks, merges results and decides when to ask the user. Always pass `model` when spawning an agent, because built-in agent types otherwise inherit the main session's model.

| Model | Use it for |
|---|---|
| Opus | Foundations everything builds on: schema, API types, data formats. Code where a subtle bug means a security hole or lost money: auth, permissions, data isolation, payments. Reviews. |
| Sonnet | Work that follows a fixed design or an existing example: routine endpoints, screens against frozen types, integration tests, mechanical refactors, explaining how code works. |
| Haiku | Running checks, locating files and symbols, digging through long logs. Treat a "not found" as a lead, not as proof. |

- No subagent for a single search or a file you already know.
- A fresh subagent knows only its prompt, so give it a complete task card.

### Plans
Use a plan for work with more than about 3 tasks or with parallel agents. If the `plan` command is missing, plans are off: ask the user to turn on Settings → Plans, or keep the list in the conversation.
- Create it from inside the repo: `plan new <topic> --title "<title>"`. It lives outside the repo and is never committed. Edit the file at `plan path`; `plan help` shows the format.
- Show the plan and wait for the user's go before starting.
- Freeze contracts first (schema, API types, formats) as task 1. After that, an agent that thinks a contract is wrong stops and reports.
- Each task card stands alone: goal, files it owns, files it must not touch, model, the exact command that must pass.
- Change status only through the CLI, when it happens: `plan start T3`, `plan done T3 --gate "<result>"`, `plan fail T3 --gate "<what failed>"`, `plan next "<one line>"`.
- A question for the user also goes in as `plan ask "<question>" --blocks T5`, and `plan answer q1 "<answer>"` once answered.
- A session works on the plan it picked. If several are open, ask which one, then `plan use <topic>`.
- One phase per conversation: when a phase is done, report and wait for the user's go.
- Parallel agents work in separate git worktrees.
- Never finish or archive a plan without the user's yes.

### Starting another session
- To hand work to a new session (another repo, a fresh context), run `bd-chat new --cwd <folder> "<first message>"`. It starts a chat in the dashboard and prints its name. `bd-chat new --help` shows the rest.
- Never start one yourself: no `tmux new-session` for Claude, no `claude` in a background shell, no loading the dashboard's `lib/` code. The dashboard does not see such a session as a chat.
- If `bd-chat` is missing, ask the user to open the chat from the dashboard.

### Specialists
- When the user asks for a specialist by name, or a task clearly matches one in `bd-ask --list` (for example drafting a message in the user's voice), run `bd-ask <name> "<task>"` instead of doing it in this session. It prints only the specialist's answer; pass it on and paste back only what is needed. `bd-ask --help` shows the rest.

### Before calling work done
- The project's checks pass.
- A fresh agent that did not write the code has reviewed the change, and its correctness, security and contract findings are fixed.

### Stop and ask
Anything touching production, any contract change, the same check failing twice on one task, anything touching `.env*` or secrets.
<!-- /beast-dash agent rules -->
```
