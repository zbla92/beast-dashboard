# What's new

## 3.8

- **Plans.** Agents keep multi-step work in a plan outside your repos, through the `plan` command. Sessions show it
  live: phases, tasks, what is next, questions you answer from the panel. Off by default, turn it on in ⚙ Settings →
  Plans. See [Plans](plans.md).
- **Uploads by project.** A file you attach goes to `.pasted/<project>/`, so one project's files don't turn up in
  another project's session. Project folders are kept for 30 days and `_unsorted` for 7. Files already there stay where
  they are and are removed after 7 days. A new hook refuses a search of the whole folder or of another project's folder.
  See [Uploaded files](claude-code.md#uploaded-files).
- **Agent rules.** The dashboard doesn't tell agents how to work, so there is now a ready block for your `CLAUDE.md`:
  uploads, which model does what, plans, when to stop and ask. `./install.sh` offers it, and nothing is added without
  your yes. See [Agent rules](agent-rules.md).
- **Mic without Whisper.** The mic uses the browser's speech recognition right away when `bin/setup-whisper.sh` hasn't
  been run. It used to hold the recording screen for about 90 seconds on Stop and then lose the recording, while the
  service restarted every 5 seconds in the background. If an installed Whisper can't start, the recording stays and you
  can try again, say it again or discard it.
- **New look.** Dark glass over an Earth wallpaper, one line icon set, full-screen on the desktop.
- **Code tab.** One repo at a time, stage, commit, push and branches, stacked diffs.
- **Chat.** `!` runs a shell command, New chat takes attachments and can open empty, a file path in a message opens a
  preview, code blocks have a copy button, Ask Claude on selected text.
- **Phone.** In a chat, Back, the title and the buttons float over the conversation instead of a blurred bar, and the
  gaps between them show the text. A file preview also closes with the round button at the bottom or a tap next to the
  image.
- **Fast open.** The app and the last known state come from the device while it connects.
- **Claude Code stays up to date.** An hourly check, automatic install and an Update button on Home.

Upgrading from 3.x: `git pull && ./install.sh`, then reload the page. Nothing in `state/` needs migrating. A plain
`git pull` leaves out the new hook and the offer of the agent rules.

## 3.0

- **Chat sessions.** A session is a *chat*: a headless `claude -p` that the dashboard drives itself
  and renders as a conversation. Same account, same transcript files, same cards, inbox and push.
  A past conversation can be reopened as a chat (**Continue in chat**, same conversation).
- **New chat** — type the prompt and the project is picked from what you wrote (no tokens spent on
  that); change it with one click. **Resume** searches every past conversation of both accounts.
  The mic works in the dialog.
- **Code view and work in progress.** Every repo with uncommitted changes or unpushed commits, across
  all projects, in one place: per repo, per group of repos, per git worktree branch, or per session.
  Home shows it as one line that opens Code.
- **Checkpoints.** Each Claude turn that edits files gets a snapshot; see what the turn changed and
  undo (or redo) only the files that turn touched.
- **Review tray.** Comment on single diff lines, collect the comments, send them to a session as one message.
- **Fork, settle, snooze.** Fork a chat from where it is; dim a finished session until it needs you
  again; snooze one for an hour or until tomorrow morning.
- **Claude Code version check.** A new Claude Code build is started once as a test before chats
  use it; a broken one is skipped (chats stay on the last good build), and you can pin a version.
  Chats move to a new version on their own, one by one.
- **Project icons.** Found in the project (favicon, app icon, Expo icon, Android / iOS launcher
  icons), a tech glyph otherwise; set your own or have Claude draw one.
- **Chat header and rail.** A context meter, a session menu (new chat, compact, rename, move to
  another folder, kill), a files panel beside the chat, rename from the rail.
- **A new look.** One SVG icon set instead of glyphs, tonal buttons, an indigo primary action.
- **Smaller things.** Battery tile and push, an update button for Claude Code installed with mise,
  an optional Sleep button with a wake alarm, big pastes become a file, links that open New chat
  with a prompt, more settings (see [Configuration](configuration.md)).

Upgrading from 2.x: `git pull && ./install.sh`. Nothing in `state/` needs migrating.
