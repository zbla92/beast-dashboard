<div align="center">

# Beast Dash

**Your Linux box and your Claude Code agents, in one tab on your laptop and phone.**

Close the laptop. The agents keep working. Your phone tells you when one needs you.

![version](https://img.shields.io/badge/version-3.4.0-6366f1?style=flat-square)
![zero dependencies](https://img.shields.io/badge/npm%20dependencies-0-22d3ee?style=flat-square)
![self-hosted](https://img.shields.io/badge/self--hosted-no%20cloud-ff6b95?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)

<img src="docs/demo/demo.gif" alt="Demo: start a chat from a prompt, watch Claude work, see what it changed, then the same thing on the phone" width="100%">

</div>

<br>

<table>
<tr>
<td width="50%" valign="top">

### Know who needs you
Every session at a glance: *working*, *done*, *needs permission*. The ones waiting on you are warm and on top.

</td>
<td width="50%" valign="top">

### Talk to it like a chat
Claude's turn in order: what it said, what it ran, what it changed. Reply, steer or queue.

</td>
</tr>
<tr>
<td><img src="docs/screenshots/home.png" alt="Home"></td>
<td><img src="docs/screenshots/chat.png" alt="A chat with a working session"></td>
</tr>
<tr>
<td width="50%" valign="top">

### See exactly what changed
Real diffs for every edit, a checkpoint per turn, undo just that turn.

</td>
<td width="50%" valign="top">

### Start from a sentence
Type what you want. The project is guessed from your words.

</td>
</tr>
<tr>
<td><img src="docs/screenshots/chat-tools.png" alt="Tool calls opened: diffs and test output"></td>
<td><img src="docs/screenshots/new-chat.png" alt="New chat with the guessed project"></td>
</tr>
</table>

<div align="center">

### Made for the phone, too

<img src="docs/screenshots/phone-strip.png" alt="Phone: home, chat, a diff, Downloads" width="100%">

</div>

## Also in the box

<table>
<tr><td width="33%">📥 <b>Inbox</b><br><sub>everyone waiting on you, with Allow / Deny</sub></td><td width="33%">🔔 <b>Push</b><br><sub>tap it, land in that chat</sub></td><td width="33%">🎙 <b>Voice</b><br><sub>talk, transcribed on your own server</sub></td></tr>
<tr><td width="33%">🌿 <b>Git</b><br><sub>branches, diffs, commit, push, worktrees</sub></td><td width="33%">📝 <b>Review tray</b><br><sub>comment on diff lines, send as one message</sub></td><td width="33%">🗂 <b>Code view</b><br><sub>every repo with work in progress</sub></td></tr>
<tr><td width="33%">▶️ <b>Run anything</b><br><sub>dev servers, tests, docker compose, live logs</sub></td><td width="33%">⌨️ <b>Terminal</b><br><sub>a real shell in the browser, phone keys included</sub></td><td width="33%">🌐 <b>Tunnels</b><br><sub><code>localhost:5173</code> reachable from any of your devices</sub></td></tr>
<tr><td width="33%">📋 <b>Tasks</b><br><sub>a backlog that hands work to Claude</sub></td><td width="33%">⏰ <b>Schedule</b><br><sub>send a prompt later, or when Claude is free</sub></td><td width="33%">📊 <b>Recap & cost</b><br><sub>what happened today, per project, per model</sub></td></tr>
<tr><td width="33%">🔥 <b>System</b><br><sub>CPU, GPU, memory, the processes eating them</sub></td><td width="33%">📁 <b>Downloads</b><br><sub>grab what Claude made, from your phone</sub></td><td width="33%">🤖 <b>Android emulator</b><br><sub>screen and touch, in a sheet</sub></td></tr>
</table>

One Node process. **Zero npm dependencies.** No accounts, no cloud. Nothing leaves your tailnet.

## Try it

```bash
git clone https://github.com/zbla92/beast-dashboard.git ~/beast-dash
cd ~/beast-dash && ./install.sh
```

Open the URL it prints (`http://<tailscale-ip>:8787`), set your projects folder in ⚙ Settings. Done.

Needs Linux with systemd, Node 18+ and tmux; Tailscale to reach it from your devices.
**Read [Access](docs/guide/access.md) before you expose it.** Prefer to let an agent set it up? Hand it [AGENT-SETUP.md](AGENT-SETUP.md).

## Learn more

[**Features & tour**](docs/guide/features.md) ·
[Install](docs/guide/install.md) ·
[Access & phone](docs/guide/access.md) ·
[Claude Code](docs/guide/claude-code.md) ·
[Everyday use](docs/guide/everyday-use.md) ·
[Configuration](docs/guide/configuration.md) ·
[How it works](docs/guide/architecture.md) ·
[What's new](docs/guide/whats-new.md)

<sub>MIT licensed.</sub>
