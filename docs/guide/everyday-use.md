# Everyday use

- **Home** — who needs you, the machine and the spend, cost by model, heavy
  processes, the running table (dev servers, processes started by hand, containers) with ports,
  CPU, memory, logs, restart, stop — and the day's recap. On a phone Home also lists the agents
  (there is no rail).
- **Rail** (desktop) — every live session in a fixed order (alphabetical by tmux name — positions
  never jump), its state, what it is doing and which Claude account it runs on; a session opens beside it. The focus button in the
  session bar hides the rail for screen sharing.
- **Projects** — cards grouped by org. ▶ runs the primary command; ▾ lists every script /
  Makefile target / compose action / your own custom commands. *Open* → the drawer: Overview,
  Changes (stage · commit · push, diffs), Files (tree, diffs, editor), Logs, Branches, Docker,
  History.
- **Code** — work in progress across repos and worktrees (see [Claude Code](claude-code.md#work-in-progress)); is a tab next to Home, Projects and
  Tasks, and opens from the Home line and from the Files button in a session.
- **Tasks** — your backlog, per project, with attachments that survive restarts.
- **Typing in a session** — on an open session nothing needs a click first: start typing (or paste) and
  it goes into the message box. There are no single-key shortcuts.
- **Terminals** — the terminal panel with a session list. Inside a terminal: `Ctrl+Shift+←/→` switch,
  `Ctrl+Shift+↑` back.
- **⌘K / Ctrl+K** — jump to any session or project, start Claude, run actions, search conversations.

- **Tunnels** (⚙ → Tunnels) — loopback-only ports of running projects are forwarded onto the
  Tailscale IP automatically; *Rebuild all* after a resume; manual expose for anything else.
  `mac/beast-tunnel.sh` is the optional laptop-side `ssh -L` helper for the rare service that
  must be `localhost`.
- **Menubar** — `mac/beast-menubar.sh` is an xbar/SwiftBar plugin: how many agents need you,
  right in the macOS menubar.
