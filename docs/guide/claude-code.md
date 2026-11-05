# Claude Code

Beast Dash treats Claude Code sessions as first-class citizens. Every Claude session is a chat: a
headless `claude -p` that the dashboard drives itself and renders as a conversation.

## Starting one

On a project card, **✦ Claude ▾** has *New chat* (type the first message), the
chats already running there (click to open), *Resume last chat in this folder* and *Chat in a git
worktree…* (a new branch and folder under `.claude/worktrees`, so two agents never edit the same
files). Two Claude Code logins are supported: the default `~/.claude`, and a second one kept in
`~/.claude-company`. What they are called on the cards is
yours — ⚙ Settings → *Claude accounts* (e.g. "Me" / "Work"). The second one is optional; if the
folder doesn't exist, nothing mentions it. Sessions are listed in a fixed order (by org, then project)
that never changes with their state. Git worktrees are not listed as
projects of their own: a session running in one counts for its repo, and the picker shows a ⎇ chip
with each worktree's branch and status (the repo itself has to be inside `devRoot` for its
worktrees to show up). For a plain terminal use **No project — just start a shell** (or *+ Plain
shell*): a bash in tmux.

## Chat sessions

**＋ Session** opens *New session*: type a prompt and press **Start
chat**. The dashboard starts a small runner in tmux (`claude-chat-<date>-<time>`) that keeps one
headless `claude -p` process (stream-json) behind a unix socket, in the project it guessed, on the
account you picked. Messages, Stop, questions Claude asks and permission prompts all go through
that socket, so a chat needs no terminal at all, survives a dashboard restart like any other
session, and is restored after a reboot like the rest. It writes the same transcript files Claude
Code always writes,
so Recap, cost, search, the inbox and push work unchanged. The guess weighs project names in your
text (also with case endings), paths, the folder you are in, what you used lately and which account
a project usually runs on; it costs no tokens. Chats run with `--dangerously-skip-permissions`, like
the sessions the dashboard starts.

The chat header shows a **context meter** and a menu: *New chat here*,
*Compact context* (when idle), *Rename*, *Move to folder* (same conversation, Claude continues in
another project or folder), mute, copy the attach command, *Kill session*. A chat that is waiting
on a question or a permission prompt pushes to your phone.

A message that starts with **`!`** is a shell command, as in Claude Code's terminal: the box
turns into shell mode, Enter runs it with your login shell in the chat's folder, and a card in the
chat shows the output live, with Stop while it runs (10 min limit, `BD_HL_SHELL_MS`) and × to
drop it. Claude doesn't answer it; the command and its output go along with your next message, in
the same `<bash-input>` / `<bash-stdout>` form the terminal uses. There is no input to type into,
so commands that ask for something (logins, `sudo`, prompts) belong in a terminal.

**Resume** in New session lists every past conversation of both accounts (title, first and last
prompt, the projects it touched, grouped by day) and opens one as a chat.
**Fork chat** (session menu, when Claude is not in a turn) starts a new chat from the conversation
so far and leaves the original as it is.

## What changed

Every turn that edits files gets a **checkpoint**: a snapshot of the working
tree of the repos the session was editing (up to six), taken as git objects without creating any branch, tag or ref, with
the list of files, `+/−` and a diff. The chat shows *3 files changed +42 −7* under the turn with
**Diff** and **Undo**; Undo puts back only the files that turn changed (and **Redo** brings them
back), it is refused while Claude is working, and a file the snapshot could not hold (too large) is
left alone and reported. *Changes by turn…* in the session menu lists them all. Checkpoints are kept
for 14 days. The **Files** button beside the chat opens a side panel with the repos the session
edited, their pending changes and a file or diff viewer; **± WIP** adds a brief of the pending
work to the message you are writing. On the diffs, a click on a line opens a comment box; the
comments go to the **review tray** (a pill at the bottom, also in the palette), from which they are
sent to a session, or into its chat box.

## Settle and snooze

*Settle* in the session menu dims a session until it needs you again
(a question, a permission prompt, an error or a usage limit); it leaves the inbox meanwhile.
*Snooze* mutes the *done* push and the inbox entry for an hour or until 8:00 tomorrow.
*Unsettle* / *Unsnooze* brings it back.

## Work in progress

Home shows one line (repos, files, unpushed commits, live sessions) that
opens **Code**. Code lists every repo under `devRoot` — worktrees included — that has staged,
modified or untracked files, a merge or rebase in progress, or commits not pushed, grouped by org.
A folder that holds two or more git repos is a *set*; the same branch checked out as a worktree in
several repos is a *group*. Choose a scope (everything, a set, a group, a repo, or one session's
repos) to get its changes and recent commits, a diff and file viewer, and which Claude sessions have edited each file, read from their transcripts and
subagents. Filters: All · Personal · Company · Live.
The brief of any scope can be added to a session's message. `?view=code` opens it directly.

## Knowing what it's doing

`bin/install-hooks.js` registers `bin/claude-hook.sh` as a Claude Code
hook (SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, Notification, Stop,
StopFailure, SessionEnd). Every event is POSTed to the dashboard tagged with the tmux session, so a
card knows within milliseconds that its agent is running `npm test`, waiting for a permission, or done.
Permission prompts and questions Claude asks are shown in the chat and the inbox as buttons.

## Talking to it

Type in the reply box on the card (from the phone, without a terminal), or open
the session — the conversation rendered from the transcript: your messages on
the right, Claude's on the left in the order it happened, tool calls folded into rows between its
text (open one for the Edit / Write diff, the Bash command and output, an agent's answer — loaded
only when opened), *worked 3m 12s* at the end of each turn, and while Claude works a live turn with what it is running and its
own status line (`✻ Testing… 4m 08s · ↓ 7.5k tokens`) plus ■ Stop. *Files edited* links to the
diffs. Drop or paste files (or tap 📎) to attach them — they land in `<devRoot>/.pasted/<project>` and their paths go into
your message; a big paste (32 KB and more) is attached as a file instead of flooding the box. ■ Stop interrupts a turn. *Runner log* in the session's Options menu shows the runner's
terminal output.

## Uploaded files

Every upload goes to the folder of the project it was sent from: `<devRoot>/.pasted/<project>/`. The server finds
the project from the session's working directory (a worktree counts as its main repo), so a session only needs its
own folder. Anything without a project goes to `_unsorted`. A file is removed after 30 days in a project folder and
after 7 days in `_unsorted`; task attachments in `keep/<project>/` stay until you delete them.

`bin/install-hooks.js` installs `bin/pasted-guard.sh` as a `PreToolUse` hook for Bash, Grep and Glob. It refuses a search of the whole
`.pasted` folder or of another project's folder and still allows a file named by its full path. It catches the common
command forms, not all of them: sessions can read the whole disk, so this prevents accidents and is not a lock.
To turn it off, also for later installs, run `node bin/install-hooks.js --no-pasted-guard`; `--pasted-guard` turns it back on.

The hook only stops the search. To have agents follow the same rule from the start, add the [agent rules](agent-rules.md).

## Scheduling

⏰ on a session: send a prompt (or a chain of prompts — each waits for the previous
one to finish) at a given time. Combine with **Tasks**: write yourself prompt-style tasks with
attachments, then *Run* one — or *Run all* open tasks of a project, chained on one session — while
you're away. When Claude finishes, its closing summary lands on the task (*Needs your review →
Accept / Done*), and the push notification can be answered with a quick reply.

## Cost and limits

*Claude today* prices the tokens in the local transcripts at API list price
(on a subscription nothing is billed per token — it measures how much work the agents did). *Usage
limits* shows the same 5-hour / 7-day windows as `/usage` inside Claude Code. For that it reads the
OAuth token Claude Code keeps in `~/.claude/.credentials.json` and asks Anthropic's usage
endpoint — the token is never sent anywhere else and never refreshed by the dashboard.

## Claude Code versions

Chat sessions run Claude Code without its interactive screen, so with only chats running nothing
installs new releases on its own. The dashboard does it: every hour it asks which release is current
(your `autoUpdatesChannel`, default `latest`) and runs `claude update` when a newer one is out.
If that fails, Home shows the error with **Try again**; it also retries by itself after 6 hours.
Turn it off with *Update Claude Code automatically* in Settings, and Home then shows an **Update**
button instead. `DISABLE_AUTOUPDATER` has the same effect and `DISABLE_UPDATES` turns off the check too.

A broken build would break every chat.
So each new build is started once as a test (a quick start that sends no prompt); one that passes
is kept as the *last good build* (the two latest are copied into `state/claude-lkg/`), one that
fails raises a banner and chats keep running on the last good one. The banner offers **Check again**, **Use X anyway** (pin it) and **Unpin**.
When a new version passes, chat sessions move over one by one: idle ones at once, busy ones after
their turn (setting *Move chats to a new Claude Code*, `chatAutoUpgrade`).

## After a reboot

Sessions are remembered (`state/claude-sessions.json`); a banner offers
*Restore all* (each chat resumes its conversation in the folder where that conversation was saved), or set *auto-restore* in Settings.
The card also shows ↻ when a newer Claude Code is installed; one click restarts the session on it.
Installed with mise (Omarchy), Claude Code can't update itself, so ↻ shows the newer release instead:
one click runs `mise upgrade claude` and restarts the session (*Update Claude Code* in the palette just installs it).

## Search

`⌘K` then `? words` searches every past conversation on the machine; open one
read-only and use **Continue in chat** to pick it up (same conversation). *Copy prompt link* in the palette makes a URL that opens New chat with
a prompt (and optionally a project) filled in; nothing runs until you press Start chat.
