# beast-dash

A live dashboard that runs Claude sessions and terminals all day. People use it from a laptop and a phone; breaking it breaks their work.

- Zero dependencies: plain Node (`server.js`, `lib/*.js`) and a vanilla frontend in `public/`. Don't add npm packages.
- Features live in `public/f-<name>.js|css` and register `FEAT.<name>` hooks that `app.js` calls through `feat()`.
- Process table, listening ports and GPU (NVML via dlopen) come from `probe/` (Rust, no crates, `beast-probe` child process); `lib/probe.js` falls back to the Node code per call and for good after 3 failures in a row. Containers come from the Docker socket, falling back to `docker ps`. `BD_PROBE=node` turns all of these back to the old path. Keep the fallbacks (`readProcs`, `listeningPorts`, hogs `readStat`, `nvidia-smi`, `dockerCli`) working.
- Terminal layer: edit `term/mobile.html`, then `bin/build-term-index.sh` → `term/index.html`.
- Never kill tmux sessions (`claude-*`, `sh-N`, `bd_*`) and never `tmux kill-server`; test terminals in a throwaway session on your own socket.
- Keep the security guards in `server.js` (Host allow-list, same-origin Origin check, `Sec-Fetch-Site: cross-site` block on /api) and `ttyd -O`. Never send `access-control-allow-origin: *`.
- Anthropic endpoints (`lib/limits.js`): poll at most every 15 min, back off on 429.
- Session order in the UI is fixed (alphabetical by tmux name) — never sort by state.
- `state/` and `state-backups/` are runtime state; don't edit by hand. Claude hooks post to `/api/hook` — keep that endpoint stable.
- Plans for multi-step work live outside the repo in the plan store (`bin/plan`, format in `docs/guide/plans.md`), in English, and are never committed. Change task status only through `plan` (start / done / fail / ask). Legacy `docs/<topic>/PLAN.md` + `PROGRESS.md` stay gitignored: the dashboard shows any committed plan as a plan card to everyone who clones the repo.

## Checks

- `node --test test/*.test.js` (the `test/` form fails on Node 24)
- `bin/gate.sh <port>` boots an isolated copy (`BD_TEST=1`, own state, loopback) on a free port and checks every route and guard. Never use the live dashboard's port.
