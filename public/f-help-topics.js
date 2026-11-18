'use strict';
const HELP = [
  {
    id: 'plans',
    title: 'Plans',
    icon: 'checkSquare',
    short: 'A plan is multi-step work Claude keeps outside the repo: phases, tasks, what is next and what waits on you. The chat working on it shows it live.',
    docs: 'docs/guide/plans.md',
    sections: [
      {
        h: 'What a plan is',
        md: [
          'A plan is a piece of work too big for one chat: phases, tasks with a task card each, a **Next** note and the questions **waiting on you**. Claude writes it, works through it across sessions and `/clear`s, and Beast Dash shows its progress live.',
          '',
          '- Plans are off until you turn on **Settings → Plans**. That links the `plan` command into `~/.local/bin` and adds a SessionStart hook to Claude Code\'s settings. Turning it off removes both and hides plans in the UI.',
          '- When an agent should make a plan (more than about 3 tasks, parallel agents) is up to your agent rules in `CLAUDE.md`, not to Beast Dash.',
        ].join('\n'),
      },
      {
        h: 'Where plans live',
        md: [
          'Plans are kept in a store **outside your repos**, so they are never committed and every worktree of a repo sees the same plans:',
          '',
          '```',
          '~/.beast/plans/<repo>/<topic>/plan.md',
          '~/.beast/plans/<repo>/<topic>/events.jsonl',
          '~/.beast/plans/<repo>/_archive/<date>-<topic>/',
          '```',
          '',
          '- `plan.md` is the only source of the current state. The checkbox markers are the progress.',
          '- `events.jsonl` is an append-only log (the timeline in the panel). It never decides state.',
          '- `<repo>` is the folder name of the repo\'s main worktree; a linked worktree maps to the same folder.',
          '- `BEAST_PLANS_DIR` moves the whole store somewhere else.',
          '',
          '| Marker | Status |',
          '|---|---|',
          '| `[ ]` | not started |',
          '| `[~]` | in progress |',
          '| `[x]` | done |',
          '| `[?]` | blocked by an open question |',
          '| `[!]` | the gate failed, still open |',
        ].join('\n'),
      },
      {
        h: 'The plan command',
        md: [
          'Claude changes status only through `plan`, never by editing the markers: each command validates the file, writes it safely and logs an event. Task cards, notes and new tasks may be edited by hand in the file `plan path` prints.',
          '',
          '| Command | Does |',
          '|---|---|',
          '| `plan new <topic> --title "<t>"` | makes the plan skeleton and picks it for this session |',
          '| `plan show` | status overview |',
          '| `plan use <topic>` | this session works on that plan (`--clear` drops it) |',
          '| `plan start T3` | task → in progress |',
          '| `plan done T3 --gate "<result>"` | task → done, with the gate result |',
          '| `plan fail T3 --gate "<what failed>"` | task → failed |',
          '| `plan ask "<question>" --blocks T5` | a question for you; the named tasks wait for it |',
          '| `plan answer q1 "<answer>"` | records your answer and unblocks its tasks |',
          '| `plan next "<one line>"` | the handoff note for the next session |',
          '| `plan context` | what the session-start hook prints |',
          '| `plan finish` / `archive` / `restore` | close, archive or bring back a plan |',
          '',
          'Which plan a command acts on: `--plan <topic>`, else the plan this session picked (`plan use`), else the repo\'s only live plan. With several and none picked it stops and lists them.',
        ].join('\n'),
      },
      {
        h: 'Plans in the dashboard',
        md: [
          '- A chat that works on a plan gets a **Plan** button in its bar with a progress ring. It opens the panel beside the conversation: phases, tasks ticking off, Next, the last gate and open questions.',
          '- **Answer** a question in the panel. In a chat the answer joins the stack above the message box and goes out with your next Send, asking Claude to record it with `plan answer`. With no live session it is saved to the plan directly.',
          '- The tick box of a step marks it done or open again. **Edit plan** asks Claude in the chat to change the plan. **Complete plan** finishes and archives it.',
          '- A chat with no plan offers **Make a plan…**; when the repo has one open plan nobody picked, it offers to continue it. The ⋯ menu has **Leave this plan**.',
          '- Project cards show a chip with the latest plan of that project. Archived plans can be opened read-only and restored.',
          '- On a phone the same things are in the session\'s Options menu.',
          '- The panel updates live: the server watches the store and pushes every change.',
        ].join('\n'),
      },
      {
        h: 'How Claude learns about its plan',
        md: [
          'With Plans on, every Claude session start (new, resume, `/clear`, compact) runs `plan context` as a SessionStart hook. What it prints goes into Claude\'s context, about 400 tokens at most:',
          '',
          '- The picked plan: topic, progress, the plan file, the task in progress, failed gates, questions waiting on you, recent answers, the Next note and the next tasks.',
          '- One open plan in the repo that this session did not pick: one line offering `plan use <topic>`, and an instruction not to work on it otherwise.',
          '- Several open plans and none picked: a short list and `plan use <topic>`.',
          '- Nothing to say, Plans off or any error: it prints nothing and never blocks the start.',
          '',
          'The pick is stored per tmux session, so it survives `/clear`: the next session reads the Next note and carries on.',
        ].join('\n'),
      },
      {
        h: 'Good to know',
        md: [
          '- Archiving is never automatic. When the last task is done the plan becomes finished, and Claude asks you before archiving it.',
          '- A task blocked by a question can\'t be started or ticked until the question is answered.',
          '- Moving a repo does not move its plans: rename the folder in the store or edit its `.repo` file.',
          '- A plan file with errors is still shown, with the errors, but `plan` refuses to change it until `plan validate` passes.',
          '- Repos with an old `docs/<topic>/PLAN.md` + `PROGRESS.md` keep their Plan tab; `plan import <dir>` copies them into the store.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'queue',
    title: 'Queue and schedule',
    icon: 'sched',
    short: 'Busy chat? Send now puts your message into the running turn, After the turn queues it. The clock button sends a message, or a chain of them, at a time you pick.',
    docs: 'docs/guide/claude-code.md#scheduling',
    sections: [
      {
        h: 'Messages while Claude works',
        md: [
          'When Claude is in a turn, a message can go two ways:',
          '',
          '- **Send now**: it goes into the running turn and Claude reads it at its next step, after the tool it is running. It shows as *Waiting for Claude* and can no longer be cancelled.',
          '- **After the turn**: it waits in a queue above the message box and goes out by itself when the turn is over.',
          '',
          'Pick the default in **Settings → Sessions → Messages while Claude works**. Enter does the default, Alt+Enter the other. On a phone the send button does the default and a second button the other. The choice is kept per device.',
        ].join('\n'),
      },
      {
        h: 'The queue',
        md: [
          '- Each queued message has **Send now** (into the running turn), **Edit** (back into the box) and **Cancel**.',
          '- Three rows show at a time; the rest are behind *N more*.',
          '- Esc in the message box stops Claude while it works.',
          '- Unsent text in the box is kept per chat.',
        ].join('\n'),
      },
      {
        h: 'Scheduling a message',
        md: [
          'The clock button next to the box opens **Schedule a message**: quick times (+15 min to tomorrow 09:00) or a date and time, and one box per message.',
          '',
          '- Extra messages are follow-ups. They go out one by one, each after Claude has finished the previous one.',
          '- If the chat is busy at the set time, the message waits until it is idle.',
          '- A time in the past is refused.',
          '- Scheduled messages of a chat show above the box.',
          '- **Settings → Sessions → Continue after a usage limit** sends a "continue" a minute after the limit resets, if nothing was sent since.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'shell',
    title: 'Shell commands with !',
    icon: 'terminal',
    short: 'Start a message with ! to run it as a shell command in the chat\'s folder. The output shows in the chat and goes to Claude with your next message.',
    docs: 'docs/guide/claude-code.md#chat-sessions',
    sections: [
      {
        h: 'How it works',
        md: [
          'Type `!` followed by a command, for example `!git status`. The box switches to shell mode and Enter runs the command with your login shell in the chat\'s folder.',
          '',
          '- A card in the chat shows the output live, with **Stop** while it runs and × to remove it afterwards.',
          '- Claude does not answer it. The command and its output are sent along with your next message, in the same form the terminal uses.',
          '- Removing the card means Claude never sees that output.',
          '- A command that runs too long is stopped after 10 minutes (`BD_HL_SHELL_MS` changes it).',
        ].join('\n'),
      },
      {
        h: 'Good to know',
        md: [
          '- When a command waits for a line of input, the card shows a **Waiting for input** field with Send and End input (^D).',
          '- Programs that need a real terminal (password prompts, `sudo`, full-screen tools) do not work. Use a terminal session for those.',
          '- Signing in to Claude with `claude auth login` has its own Authenticate button on the card, which keeps the login alive until you paste the code.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'quotes',
    title: 'Quote and ask',
    icon: 'comment',
    short: 'Select text in a chat and press Ask Claude to attach it as a quote to your next message, with a short question of its own.',
    sections: [
      {
        h: 'Using it',
        md: [
          '- Select text in the conversation. An **Ask Claude** button appears next to the selection; press it.',
          '- A quote chip appears above the message box with an **Ask about this…** field. Write what you want to know, or leave it empty.',
          '- You can add several quotes. A tray label counts them, and a chip can be opened to read the whole quote or removed with ×.',
          '- On Send, each quote goes out as a Markdown blockquote followed by its question, then your message.',
        ].join('\n'),
      },
      {
        h: 'Good to know',
        md: [
          '- A quote is cut at 4000 characters.',
          '- Quotes are kept per chat in this browser, so a reload does not lose them, but another device does not see them.',
          '- In a sent message the quote is shown folded; click it to open.',
          '- Open questions of a plan use the same chips, as **Your answer…** (see Plans).',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'pins',
    title: 'Pinned question',
    icon: 'pin',
    short: 'While you scroll through a long reply, the question it answers stays pinned at the top. Tap it to jump back to its start.',
    sections: [
      {
        h: 'What it does',
        md: [
          'A bar at the top of the chat shows your question (two lines at most) as long as its start has scrolled out of view and you are reading the reply to it. It follows you from question to question as you scroll.',
          '',
          '- Click or tap the bar to scroll back to the start of that question.',
          '- It hides when the question itself is on screen.',
          '- Messages still queued or waiting, and shell commands, are not pinned.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'preview',
    title: 'File preview',
    icon: 'fileText',
    short: 'A file path in a chat is a link. Click it to see the file: image, PDF, video, HTML, Markdown or text, at the line the path names.',
    sections: [
      {
        h: 'What opens',
        md: [
          'Paths that Claude prints, in a project, in Downloads or in an upload folder, become links. Click one to open a preview:',
          '',
          '| File | Shown as |',
          '|---|---|',
          '| image, video | the picture or a player |',
          '| PDF | the browser PDF viewer |',
          '| HTML | a sandboxed frame: scripts do not run |',
          '| Markdown | rendered, unless the path names a line |',
          '| text and code | highlighted, scrolled to the line in `path:12` |',
          '| anything else | no preview, use download |',
        ].join('\n'),
      },
      {
        h: 'In the preview',
        md: [
          '- Buttons copy the whole file, open it in a new tab and download it. Esc closes it.',
          '- Text over 2 MB is cut; download it for the whole file.',
          '- Code blocks in chat messages have their own copy button.',
          '- A path outside your projects, Downloads and uploads is not served: the preview says so.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'files',
    title: 'Files and Code view',
    icon: 'folderOpen',
    short: 'Browse and edit project files, read diffs and see which Claude touched what: in a project, in a chat side panel and in the Code view.',
    docs: 'docs/guide/features.md#terminals-git-and-files',
    sections: [
      {
        h: 'Where to find files',
        md: [
          '- **Project drawer**: Overview, Changes (stage, commit, push, diffs), Files (tree, diffs, editor in place), Logs, Branches, Docker, History.',
          '- **Chat side panel**: the Files button beside a chat opens the repos that session edited, their pending changes and a file or diff viewer. **Files edited** lists what the session touched.',
          '- **Code**: every repo with pending work, grouped by org, with a diff and file viewer. See Work in progress.',
        ].join('\n'),
      },
      {
        h: 'Good to know',
        md: [
          '- The Files tab of a project reads and edits files; it does not delete them. Only Downloads has delete.',
          '- A path in a chat opens in the preview instead; see File preview.',
          '- Git worktrees of a repo are not projects of their own: a session in one counts for its repo.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'checkpoints',
    title: 'Checkpoints',
    icon: 'undo',
    short: 'Every turn that edits files gets a checkpoint: what changed, with a diff and an Undo that puts back only that turn\'s files.',
    docs: 'docs/guide/claude-code.md#what-changed',
    sections: [
      {
        h: 'What a checkpoint is',
        md: [
          'When a turn edits files, Beast Dash snapshots the working tree of the repos the session was editing, up to six. The snapshot is made of git objects and creates no branch, tag or ref in your repos.',
          '',
          'Under the turn the chat shows a line like *3 files changed +42 −7* with **Diff** and **Undo**. *Changes by turn…* in the session menu lists every checkpoint of the session.',
        ].join('\n'),
      },
      {
        h: 'Undo and Redo',
        md: [
          '- **Undo** puts back only the files that turn changed. **Redo** brings the changes back.',
          '- It is refused while Claude is working in that session.',
          '- A file edited again after the turn is rewound too, so those later edits are lost. The button says so.',
          '- A file too large for the snapshot is left alone and reported.',
          '- Checkpoints are kept for 14 days.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'review',
    title: 'Review tray',
    icon: 'diff',
    short: 'Click a line in a diff to comment on it. The comments pile up in a tray and go to a session as one message.',
    docs: 'docs/guide/claude-code.md#what-changed',
    sections: [
      {
        h: 'How to review',
        md: [
          '- Click a line in a diff and write the comment (Ctrl or ⌘ + Enter adds it). The comment names the file and line.',
          '- Comments collect in the **review tray**, a pill at the bottom of the screen, also in the command palette.',
          '- In the tray pick a session and press **Send** to deliver all comments as one message, or **To chat box** to edit them first.',
          '- **Clear** drops every comment. A × removes one.',
        ].join('\n'),
      },
      {
        h: 'Good to know',
        md: [
          '- A session that waits on a permission prompt does not take a review: answer the prompt first.',
          '- The tray is kept in this browser, so it survives a reload but is not shared between devices.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'wip',
    title: 'Work in progress',
    icon: 'code',
    short: 'One line on Home shows every repo with uncommitted changes or unpushed commits, and opens the Code view. Add a brief of it to a message with ± WIP.',
    docs: 'docs/guide/claude-code.md#work-in-progress',
    sections: [
      {
        h: 'What counts',
        md: [
          'Code lists every repo under your dev folder, worktrees included, that has staged, modified or untracked files, a merge or rebase in progress, or commits that are not pushed. They are grouped by org.',
          '',
          '- A folder that holds two or more git repos is a **set**. The same branch checked out as a worktree in several repos is a **group**.',
          '- Pick a scope (everything, a set, a group, a repo, one session\'s repos) to see its changes, recent commits and a diff and file viewer.',
          '- Each file shows which Claude sessions have edited it, read from their transcripts and subagents.',
          '- Filters: All, Personal, Company, Live.',
        ].join('\n'),
      },
      {
        h: 'Using it with Claude',
        md: [
          '- **± WIP** in a chat adds a brief of the pending work of a scope to the message you are writing, so Claude knows what is in flight.',
          '- The Home line shows how many repos have a live session in them.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'worktrees',
    title: 'Worktrees',
    icon: 'branch',
    short: 'A chat in a git worktree gets its own branch and folder, so two agents never edit the same files. The Worktrees tab merges or removes them.',
    docs: 'docs/guide/claude-code.md#starting-one',
    sections: [
      {
        h: 'Starting one',
        md: [
          'On a project card, **✦ Claude ▾ → Chat in a git worktree…** makes a new branch and folder under `.claude/worktrees` and starts a chat there. Use it when several agents work on one repo.',
          '',
          '- Worktrees are not listed as projects. A session in one counts for its repo, and the card shows a branch chip with the number of extra worktrees.',
          '- The repo has to be inside your dev folder for its worktrees to show.',
        ].join('\n'),
      },
      {
        h: 'The Worktrees tab',
        md: [
          'The chip opens the project drawer on **Worktrees**: every worktree with ahead and behind against the base branch, uncommitted changes and the Claude sessions working in it.',
          '',
          '- **Merge into base** runs `git merge --no-edit <branch>` in the main checkout. On a conflict it is aborted. Nothing is pushed.',
          '- **Remove** deletes the worktree. It asks about discarding uncommitted changes and about deleting the branch; git keeps an unmerged branch unless you force it.',
          '- **Prune** drops records of worktrees whose folder is gone.',
          '- Labels: *merged*, *N to merge*, *active* (files changed in the last minutes), *stale* (merged and nothing running, safe to remove), *folder missing*.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'subagents',
    title: 'Subagents and cost',
    icon: 'diamond',
    short: 'See the agents a session started, with model, prompt, steps and cost, and what each model cost today and this week.',
    sections: [
      {
        h: 'In a chat',
        md: [
          'When Claude hands work to subagents, a chip in the chat bar shows how many are running or finished. Open it for each agent: type, model, prompt, steps and cost.',
          '',
          '- The cost is the API-equivalent price of the tokens. On a subscription nothing is billed per token; it measures how much work was done.',
          '- Open a tool row in the chat to see an agent\'s prompt and answer.',
        ].join('\n'),
      },
      {
        h: 'On Home',
        md: [
          'A Home card shows today and the week per model and a 7-day line, for all models and for subagents. It is useful for checking that routine work runs on a cheaper model.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'activity',
    title: 'Activity strip',
    icon: 'diamond',
    short: 'A slim line above the message box shows what a chat is still doing after its turn: background agents and background commands.',
    sections: [
      {
        h: 'What it shows',
        md: [
          'When Claude has finished its turn but still waits on something running in the background, a strip with a spinner appears above the message box and disappears when nothing runs.',
          '',
          '- **Agents** lists the background agents Claude is waiting on. Click it to open the subagents sheet.',
          '- **Silent** in amber means that agent has written nothing for more than 10 minutes, for example `silent 7h`. It may be stuck.',
          '- **Commands running** counts background shell commands started by Claude.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'inbox',
    title: 'Inbox',
    icon: 'bell',
    short: 'Every chat that waits for you in one place: finished, asking permission, failed or out of usage. Reply or answer from there.',
    docs: 'docs/guide/features.md',
    sections: [
      {
        h: 'What lands in it',
        md: [
          'A chat shows up when it is **done and waiting**, **needs permission**, hit an **error** or hit a **usage limit**. Each row has the last message and a reply box (Enter sends, Shift+Enter is a new line) and the mic.',
          '',
          '- A permission prompt has **Allow** and **Deny** buttons. Deny asks Claude to do something else.',
          '- **Seen** hides a row until its state changes.',
          '- Calls to bots that finished or failed appear here too until you open them.',
        ].join('\n'),
      },
      {
        h: 'Quiet a chat',
        md: [
          '- **Settle** (session menu) dims a chat until it needs you again and removes it from the inbox meanwhile.',
          '- **Snooze** mutes the done push and the inbox entry for an hour or until 8:00 tomorrow.',
          '- Home leads with how many agents need you; the same numbers feed push notifications.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'push',
    title: 'Push notifications',
    icon: 'bellOff',
    short: 'A message on your phone or laptop when an agent finishes or needs you. Tapping it opens that chat.',
    docs: 'docs/guide/access.md#https-push-notifications-and-the-phone',
    sections: [
      {
        h: 'Turning it on',
        md: [
          'Push needs a secure origin (HTTPS). Set that up once with `bin/enable-https.sh`, open the HTTPS address on each device and press **Settings → Notifications → Push → Enable**. A test button sends one notification to check it.',
          '',
          '- Each device subscribes on its own; Settings shows how many are subscribed.',
          '- On an iPhone add the page to the Home Screen first.',
        ].join('\n'),
      },
      {
        h: 'What sends one',
        md: [
          'In **Settings → Notifications** you choose: session finished, needs permission, session error, usage limit hit, dev server died, machine trouble (too hot, out of memory, runaway process, low battery), a Monday digest and a morning summary.',
          '',
          '- **Quiet hours** hold back pushes between two times.',
          '- **Sound** plays a ding on the device you are using.',
          '- Muting a chat (bell in its bar) silences its pushes.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'bots',
    title: 'Bots',
    icon: 'sparkle',
    short: 'A bot is a named helper with its own chat, memory and credentials. Teach it by talking, and call it from any chat or terminal.',
    docs: 'docs/guide/bots.md',
    sections: [
      {
        h: 'What a bot is',
        md: [
          'A bot belongs to no project. It has its own instructions, memory, history and credentials in a folder under `~/.beast/specialists`, and its own long-lived chat. Think of a `db` bot that knows a database, or a `writer` that drafts replies in your voice.',
          '',
          '- Open the bot to talk to it. Say "remember that we always use UTC" and it writes that into its memory; the change is committed in the bot\'s own git history and can be undone in its settings.',
          '- Each bot has an icon and a colour, picked from its name and changeable in settings.',
        ].join('\n'),
      },
      {
        h: 'Calling a bot',
        md: [
          'From any chat, ask Claude to use the bot ("ask the db bot how many people signed up today"). From a terminal:',
          '',
          '```',
          'bd-bot --list',
          'bd-bot db "how many signups today?"',
          'bd-bot --continue <runId> "shorter, please"',
          '```',
          '',
          '- Only the final answer is printed, so the bot\'s work stays out of your context.',
          '- Every call is its own chat under the bot. You can open it and continue it.',
          '- A call that takes longer than the timeout (900 s) keeps running; `bd-bot --wait <runId>` picks it up.',
          '- A bot can also be set to be used as a skill: the agent loads the bot\'s instructions and does the work itself instead of asking.',
        ].join('\n'),
      },
      {
        h: 'Credentials and limits',
        md: [
          '- Keys and passwords go only in the bot\'s settings, never in chat. They are stored in a private folder of that bot, never committed, and only that bot gets them as environment variables.',
          '- A message that contains one of the bot\'s known credentials is refused.',
          '- Four calls of one bot can run at a time.',
          '- A bot chat stays with its bot: it cannot be forked, moved or handed off.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'accounts',
    title: 'Claude accounts',
    icon: 'layers',
    short: 'Beast Dash can run chats on two Claude logins, for example personal and work. You name them; a badge shows which one a chat uses.',
    docs: 'docs/guide/claude-code.md#starting-one',
    sections: [
      {
        h: 'Two logins',
        md: [
          'The default login lives in `~/.claude`. A second one lives in `~/.claude-company`, or in the folder `BD_COMPANY_DIR` names. The second one is optional: without the folder, nothing mentions it.',
          '',
          '- **Settings → Claude accounts** sets the names shown on cards and badges, for example "Me" and "Work".',
          '- Both logins get the hook that reports what Claude is doing. Re-run `node bin/install-hooks.js` after moving the second folder.',
        ].join('\n'),
      },
      {
        h: 'Which account a chat uses',
        md: [
          '- **New chat** guesses the project from your words and uses the account that project usually runs on. Change it in the dialog if needed.',
          '- Resume lists past conversations of both accounts.',
          '- Usage limits and the 5-hour window are shown per account.',
          '- **Start the 5-hour window** (per account, in the same section) sends one tiny message at a time you set, so the window is already running when your work starts.',
          '- Code filters: All, Personal, Company, Live.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'hidden-projects',
    title: 'Hidden projects',
    icon: 'eyeOff',
    short: 'Hide a project to take it off your lists without deleting anything. Unhide it in Settings.',
    sections: [
      {
        h: 'Hide and unhide',
        md: [
          '- On a project card open the ⋯ menu and choose **Hide project**.',
          '- Hidden projects are listed in **Settings → Hidden projects**, each with an **Unhide** button. That section only appears while something is hidden.',
          '- Hiding changes only what Beast Dash shows. The folder, its git repo and its sessions are untouched.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'downloads',
    title: 'Downloads',
    icon: 'download',
    short: 'The Downloads folder of the server, in a file explorer. Ask Claude to drop a file there and grab it from your phone.',
    docs: 'docs/guide/features.md',
    sections: [
      {
        h: 'Using it',
        md: [
          'Downloads is `~/Downloads` on the server. Inside it:',
          '',
          '- Click a file to preview it (image, PDF, text).',
          '- Tick files and download one, or several and folders together as one zip.',
          '- Ask Claude to "put the report in Downloads", then fetch it from any device.',
        ].join('\n'),
      },
      {
        h: 'Good to know',
        md: [
          '- Downloads is the one place where you can delete files from the dashboard. The Files tab of a project cannot.',
          '- A path to a Downloads file in a chat opens the same preview.',
          '- The folder is created if the server has none.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'emulator',
    title: 'Android emulator',
    icon: 'phone',
    short: 'Start an Android emulator on the server and use it from the browser: tap, swipe, type, back, home and recents.',
    docs: 'docs/guide/configuration.md#android-emulator-optional',
    sections: [
      {
        h: 'Using it',
        md: [
          'The Android card appears on Home once `adb` sees a device or an AVD exists. It shows a live thumbnail; open it for the full sheet.',
          '',
          '- **Start** runs the AVD headless on the GPU. It takes about a minute to boot.',
          '- Tap and swipe on the screen. Buttons send back, home and recents; a field types text (ASCII only).',
          '- **Stop emulator** asks first; unsaved state in apps is lost.',
        ].join('\n'),
      },
      {
        h: 'Good to know',
        md: [
          '- The SDK comes from `ANDROID_HOME` or `ANDROID_SDK_ROOT`, else `~/Android/Sdk`.',
          '- Set `EMULATOR_LAUNCHER` to your own start script; it gets the AVD name.',
          '- Software rendering burns a CPU core even when idle, which is why the GPU start is the default.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'connection',
    title: 'Connection and ports',
    icon: 'link',
    short: 'What the connection bar means, and how project ports reach your laptop or phone: tunnels, port links and the SSH settings.',
    docs: 'docs/guide/everyday-use.md',
    sections: [
      {
        h: 'The connection bar',
        md: [
          'A bar appears when the page loses the server:',
          '',
          '- **Connecting** and **Reconnecting** with a timer: normal after a restart or a sleeping phone.',
          '- After about 8 seconds it says it cannot reach the server and asks whether Tailscale is on, with a **Retry** button.',
          '- **You are offline** means this device has no network.',
          '- *Showing last known state* means what you see is saved data, not live.',
        ].join('\n'),
      },
      {
        h: 'Tunnels and port links',
        md: [
          'Ports that projects bind on `127.0.0.1` are forwarded onto the Tailscale IP with `socat`, so `http://<tailscale-ip>:5173` opens from any of your devices.',
          '',
          '- **Settings → Tools → Tunnels** lists them. **Rebuild all** after a resume; expose any other port by hand.',
          '- **Auto-expose** forwards every loopback port by itself. Switching it on asks you to confirm.',
          '- **Settings → Connection**: *Public host for port links* is the address put into links (empty means the Tailscale IP). *SSH host alias* and *SSH user* are used for editor links and copied ssh commands.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'fullscreen',
    title: 'Full screen and Esc',
    icon: 'full',
    short: 'In a full screen browser window, a short Esc closes dialogs and previews. A second Esc within a few seconds leaves full screen.',
    docs: 'docs/guide/everyday-use.md',
    sections: [
      {
        h: 'How Esc behaves',
        md: [
          'Browsers normally leave full screen on the first Esc. On desktop Chrome or Edge over HTTPS, once the window is full screen the first click or key hands Esc to the page:',
          '',
          '- A short Esc closes dialogs, Downloads and previews, and shows *Press Esc again to leave full screen*.',
          '- A second Esc within a few seconds leaves full screen.',
          '- Holding Esc also leaves.',
          '- In a terminal, Esc goes to the terminal as usual (hold it to leave).',
        ].join('\n'),
      },
      {
        h: 'Good to know',
        md: [
          '- It only applies to desktop browsers with a mouse and keyboard lock support. Phones are not affected.',
          '- After you leave, it does not grab Esc again until the window leaves full screen and enters it again.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'power',
    title: 'Sleep and wake',
    icon: 'power',
    short: 'An optional button that suspends the server and sets an alarm so it wakes itself on the next weekday morning.',
    docs: 'docs/guide/configuration.md#sleep-button-optional',
    sections: [
      {
        h: 'What it does',
        md: [
          'With `sleepButton: true` in the config, **Settings → Power → Sleep** suspends the machine and sets an RTC alarm for the next weekday (Mon to Fri) at 07:00. The dashboard shows when it will wake.',
          '',
          '- While the machine sleeps nothing runs on it, and the dashboard cannot be reached.',
          '- It needs passwordless sudo for exactly two commands: `rtcwake` and `systemd-run`.',
          '- Meant for a desktop that does not need to run all night. A server you want 24/7 should not use it.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'hooks',
    title: 'Claude hooks',
    icon: 'zap',
    short: 'Beast Dash installs a small hook into Claude Code that reports what each session is doing, so a card knows within milliseconds.',
    docs: 'docs/guide/claude-code.md#knowing-what-its-doing',
    sections: [
      {
        h: 'What the hook does',
        md: [
          '`bin/install-hooks.js` registers `bin/claude-hook.sh` in the Claude Code settings of both accounts for: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, Notification, Stop, StopFailure and SessionEnd.',
          '',
          '- Each event is posted to `/api/hook` on the dashboard with the tmux session name and the account.',
          '- That is how a card knows its agent is running `npm test`, waiting for permission or done.',
          '- Every event except SessionEnd runs asynchronously and never blocks Claude. SessionEnd runs synchronously with a 3 second timeout, so it is not lost when a session closes. If the dashboard is down, it fails silently.',
        ].join('\n'),
      },
      {
        h: 'Good to know',
        md: [
          '- Only sessions inside tmux report in. Anything else is invisible to the cards.',
          '- Long strings in the event are clipped to 400 characters.',
          '- Do not remove the hook or change the endpoint: states, the inbox and push depend on it.',
          '- Two other hooks may be installed: a guard against searching other projects\' uploads (`--no-pasted-guard` turns it off) and, with Plans on, the plan context at session start.',
        ].join('\n'),
      },
    ],
  },
];
