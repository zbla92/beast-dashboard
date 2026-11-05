# Features

Beast Dash is one Node process with **zero npm dependencies**. Point it at the folder that holds
your projects and it gives you:

- **Two layouts, one app** — on a desktop a rail keeps every live session one click away (state,
  what it is doing) and the session opens right beside it; on a phone a tab bar (Home · Inbox ·
  Sessions · Code · Tasks), agents as a list, sheets that slide up. Colour has one job: warm
  means *waiting on you*, cool means *the machine is working*.
- **Inbox** — every session that waits for you (done, permission prompt, error, usage limit) in one
  sheet, each with a reply box and the mic; permission prompts get Allow / Deny. Home leads with
  *"2 agents need you"* and their last message; click it to open it.

- **Every project on one screen** — discovered automatically (git repos, `package.json`,
  `pyproject`, `docker-compose`, Makefiles), grouped by the top-level folder they live in, with
  branch, uncommitted changes, last commit and the commands each one can run.
- **Every Claude session is a chat** — a headless Claude run, rendered from the transcript with no
  TUI in the way. The only terminal is a plain shell. **＋ Session → New chat** guesses the project
  from your prompt; **Resume** finds any past conversation and opens it as a chat.
- **Code view** — work in progress across all repos and git worktrees; checkpoints let you see and
  undo what a Claude turn changed.
- **Claude Code sessions as cards** — which project, what it is doing right now (`working: npm test`),
  whether it is *done and waiting for you*, *needs permission* or *hit an error*, its last message,
  and a reply box. Chats run on the server, so they keep working **24/7** without your laptop.
  Busy? **⏳ Send when free** queues your message and it goes out the moment Claude finishes.
  Unsent text is kept per chat.
- **Start / stop anything** — dev servers, tests, builds, docker compose — each in its own tmux
  session with live, colour-preserving logs. A dev server that dies raises a banner and a push.
- **A terminal in the browser** (ttyd + tmux) with a phone-friendly layer: Esc/Tab/arrows/Ctrl keys,
  paste, file upload, finger scrolling. Two devices can share the same session. The only
  terminal sessions are plain shells (**＋ Session → No project — just start a shell**).
- **Push notifications** to your phone and laptop when an agent finishes or needs you — tapping one
  opens that conversation, also when the app was in the background.
- **Voice input** — tap the mic, talk, Stop: transcribed on your own server with Whisper
  (optional, [setup](configuration.md#voice-input-whisper)); falls back to the browser's speech
  recognition. The mic is in the chat box and in the New session dialog.
- **Git without a terminal** — switch branches, stage, commit, push, read diffs, edit files.
- **Review tray** — click a line in any diff to comment on it; the comments pile up in a tray and
  go to a session as one message (or into its chat box to edit first).
- **Project icons** — every project, and every org folder, gets a tile: the icon found in the
  project, otherwise a glyph for its stack, or one you set yourself. They show in the rail, the
  session list, the palette and the chat header ([details](configuration.md#project-icons)).
- **Tasks** — a personal backlog of prompt-style tasks per project; "Run" hands one to a Claude
  session (or starts one).
- **Tunnels** — ports that projects bind on `127.0.0.1` are forwarded onto your Tailscale IP with
  `socat`, so `http://100.x.y.z:5173` just works from any of your devices.
- **Recap** — what happened today / yesterday / the day before, per project: your commits, the
  Claude sessions that ran (title, what you asked, files edited) and what they cost.
- **System** — CPU (per core + temperature), memory, GPU, disk, network and, on a laptop, the
  battery (charge, on AC or on battery, time left, health); each tile opens a 24-hour detail
  (usage + temperature charts, per-core bars, battery charge with the plugged-in stretches
  shaded). **Heavy processes** get their own card:
  what is keeping cores busy or holding GBs of memory, in words (`Android emulator · Pixel_8`,
  `vite · my-app`, `Gradle daemon`), with tips for known fixes and Stop / Kill. A push when the CPU
  runs hot, memory runs out, a process pins several cores for 10+ minutes or the battery drops to
  25 % and again to 10 % (once per discharge, quiet hours respected).
- **Downloads** — `~/Downloads` on the server in a file explorer: preview images / PDFs / text,
  tick files and download one, or several (and folders) as one zip. Ask Claude to "drop the
  report in Downloads" and grab it from your phone.
- **Files named in a chat** — a path Claude prints to Downloads, an upload or a project file is a link: click it for a
  preview (image, PDF, video, HTML, Markdown, text with the line it names). Code blocks have a copy button.
- **Uploads by project** — a file you attach goes to that project's own folder, so sessions of different projects
  don't see each other's uploads by accident. See [Uploaded files](claude-code.md#uploaded-files).
- **Plans** — turn on ⚙ Settings → Plans and agents keep multi-step work in a plan outside the repo, through the
  `plan` command. The session shows phases, tasks, what is next and what waits on you, live, and you answer from there.
  See [Plans](plans.md). A repo that still has `docs/<topic>/PLAN.md` + `PROGRESS.md` keeps its progress chip and Plan
  tab; `plan import` copies it into the store.
- **Agent rules** — a ready block for `CLAUDE.md`: uploads, which model does what, plans, when to stop and ask.
  `./install.sh` offers it. See [Agent rules](agent-rules.md).
- **Git worktrees** — every worktree of a repo with ahead/behind, changes, which Claude works in it;
  diff, merge into the base branch (aborts on conflict), remove, prune.
- **Subagents and cost by model** — the agents a session spawned (type, model, prompt, steps, cost)
  from the chat bar; a Home card with today's and the week's API-equivalent cost per model and a
  7-day line (all models, subagents).
- **Android emulator** — a live thumbnail on Home; a sheet with the screen (tap, swipe, back / home /
  recents, typing), start and stop per AVD (optional,
  [setup](configuration.md#android-emulator-optional)).
- **Sleep (optional)** — a button that suspends the server and sets an RTC alarm so it wakes
  itself on the next weekday morning ([setup](configuration.md#sleep-button-optional)).
- **Updates itself** — open pages reload into a new build on their own when idle.

It runs on a home server, a VPS or any Linux machine you can SSH into. No accounts, no cloud,
nothing leaves your tailnet.

## A tour

*Screenshots from a demo box: example projects, two Claude Code sessions, made-up usage numbers.*

![Home: the agent that needs you on top, every Claude Code session, the machine, the spend, what is running](../screenshots/home.png)

### Talk to Claude from anywhere

**Chat** renders the session from its transcript the way the Claude app does: your messages on the
right; Claude's turn on the left **in order** — what it said, the tools it ran in between, what it
said next — and while it works a live turn with what it is running right now and its own status line.

![Chat with a working session: your prompts, Claude's replies, the live turn with the running tool and Claude's status line](../screenshots/chat.png)

Consecutive tool calls fold into one quiet row (*ran a command · edited 3 files · read 2 files ›*);
open it, then open any call: Edit / Write as a real diff with `+6 −1`, Bash with its command and
output, an agent with its prompt and answer. Questions Claude asked you (and your answers) and its
to-do list stay inline. **Focus**, in the chat's Options menu, hides the tool rows and leaves the conversation.
While you scroll through a long reply, the question it answers stays pinned at the top of the chat; tap it to get back to its start.
Open it to see exactly what Claude changed: the Edit / Write diffs and the Bash commands with their results.

![A turn with its tool calls opened: Edit diffs in red and green, the new file, the test command](../screenshots/chat-tools.png)

**Done, waiting for you** — a finished session shows Claude's summary, and the inbox and push tell
you it is your turn.

![Chat of a finished session: Claude's summary with a list and a question](../screenshots/chat-done.png)

A file path in a reply opens a preview: image, PDF, Markdown, or code at the named line.

![A file named in a chat opened in the preview](../screenshots/chat-preview.png)

### Start anywhere, pick up anything

**New chat** — type what you want done. The project is guessed from the words (names, paths, the
folder you are in, what you used lately) and shown as a chip you can change; the account follows
the project's usual one. `＋ Session` is the same dialog with a **Resume** tab.

![New chat dialog: a prompt, the guessed project as a chip, the mic and Start chat](../screenshots/new-chat.png)

**Code** — every repo with pending changes or unpushed commits, grouped by org; repos that sit in
one folder form a set, worktrees of the same branch across repos form a group. Pick a scope to see
its changes, commits and files, with a diff or file viewer, and which live Claude is editing what.

![Code view: repos with staged, modified and untracked counts, unpushed commits, live session dots, and a diff on the right](../screenshots/code.png)

**Icons** — every project gets one: found in the project, a tech glyph otherwise, or your own.

![Set icon sheet: upload an image or ask Claude to draw an SVG](../screenshots/icons.png)

### Terminals, git and files

| A shell in tmux on the server | Changes: diff, stage, commit, push |
|---|---|
| ![bash in the browser terminal](../screenshots/shell.png) | ![Changes tab with an expanded diff](../screenshots/changes.png) |
| **Files: tree, preview, edit in place** | **Downloads: preview, tick, get one file or a zip** |
| ![Files tab in edit mode](../screenshots/files.png) | ![Downloads explorer with an image preview and two files selected](../screenshots/downloads.png) |

### Plan the work

**Plans** — with ⚙ Settings → Plans on, the chat that works on a plan shows it beside the conversation: phases, tasks ticking off, what is next and the questions waiting for you. See [Plans](plans.md).

![A chat with the Plans panel and an open question](../screenshots/plan-panel.png)

| Projects, grouped by folder | Tasks per project |
|---|---|
| ![Project cards with branch, changes and what runs in each](../screenshots/projects.png) | ![Task backlog: in progress and to do](../screenshots/tasks.png) |
| **Schedule a message (or a chain)** | **⌘K: jump anywhere** |
| ![Schedule dialog: when, the message, follow-ups](../screenshots/schedule.png) | ![Command palette with sessions, dev servers and projects](../screenshots/palette.png) |

**Recap** — what happened today, per project: your commits and the Claude sessions (what you
asked, files edited, cost).

![Recap of a project: commits and two Claude sessions](../screenshots/recap.png)

**Inbox** — everything that waits for you, answered from one place.

![Inbox: a finished session with its last message, a reply box, Open chat and Send](../screenshots/inbox.png)

### On the phone

![Phone: home, chat, the plan, a diff, Downloads](../screenshots/phone-strip.png)

<p align="center">
<img src="../screenshots/phone-sessions.png" width="19%" alt="Phone: session switcher">
<img src="../screenshots/phone-chat-done.png" width="19%" alt="Phone: a finished session">
<img src="../screenshots/phone-projects.png" width="19%" alt="Phone: projects">
<img src="../screenshots/phone-plan.png" width="19%" alt="Phone: the plan in session Options">
<img src="../screenshots/phone-tasks.png" width="19%" alt="Phone: tasks">
</p>
