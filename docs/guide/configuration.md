# Configuration

Everything lives in `state/` (gitignored) and is edited through ⚙ Settings, which writes
`state/settings.json`. The keys and their defaults are in [`lib/settings.js`](../../lib/settings.js):

| Key | Default | What |
|---|---|---|
| `devRoot` | `~/dev` | folder to scan for projects |
| `scanDepth` | `4` | how deep to look |
| `port` | `8787` | HTTP port |
| `sshHost`, `sshUser` | `''` | your laptop's ssh alias for this server (VS Code links, copied commands) — see [the ssh config block](install.md#the-ssh-config-block) |
| `publicHost` | auto | host used in generated links (defaults to the Tailscale IPv4) |
| `allowedPrefixes` | `[]` | extra client IP prefixes to accept, e.g. `["10.8.0."]` |
| `allowedHosts` | `[]` | extra host names the dashboard answers to (besides localhost, IPs, `*.ts.net`, `publicHost`), e.g. `["devbox.lan"]` |
| `autoExpose` | `true` | forward loopback ports onto the tailnet with socat |
| `autoRestore` | `false` | bring Claude sessions back automatically after a reboot |
| `accountLabels` | `{personal: 'Personal', company: 'Company'}` | display names of the two Claude logins (`~/.claude`, `~/.claude-company`) |
| `pushContact` | `mailto:admin@example.com` | VAPID contact sent to push services — set it to yours |
| `orgColors` | `{}` | colour per org folder, e.g. `{"work": "#82a8f5"}` (hex or `var(--…)`); unset orgs get one from the palette |
| `orgAccounts` | `{}` | Claude account an org uses in Code filters, e.g. `{"work": "company"}` |
| `claudeAttach` | `''` | template for *Copy attach command* on Claude sessions, e.g. `cs {c}{name}` (`{c}` = `-c ` for company sessions, `{name}` = session name without `claude-`) |
| `attachVia` | `ssh` | `ssh` or `mosh` for the copied attach command of other sessions |
| `sleepButton` | `false` | show the Sleep button ([below](#sleep-button-optional)) |
| `notify` | all on | which events push, quiet hours |
| `serverName` | hostname | name in system push titles (*"myserver CPU 92 °C"*) |
| `voiceLangs` | `[]` | languages the mic toggles between, e.g. `["en", "de"]` (first = default); empty = auto |
| `deviceCache` | `true` | over HTTPS, phones and laptops keep the app files and open without waiting for the network; `false` clears that cache on every device (read on each request, no restart) |
| `plans` | `false` | agents keep plans outside your repos and sessions show them; turning it on links the `plan` command and adds its hook — see [Plans](plans.md) |
| `pastedGuard` | `true` | the hook that stops a search of the whole upload folder or another project's folder; change it with `node bin/install-hooks.js --no-pasted-guard` or `--pasted-guard` — see [Uploaded files](claude-code.md#uploaded-files) |

Per-project overrides (hide, rename, custom commands, pin) are set from the card's ⋯ menu.

**Cached app.** On HTTPS the service worker keeps the app shell, scripts, styles and fonts on the
device, so the page paints at once and a new version is fetched in the background (the page reloads
into it when idle, as before). If one device looks broken: ⚙ Settings → **Cached app on this device →
Clear**, or open `/?reset-cache`. Plain HTTP has no service worker and loads from the server as always.

Nightly, `state/` is tarred into `state-backups/` (also gitignored) — download from Settings.
**Keep both folders out of git**: `state/push.json` holds the VAPID private key and your push
subscriptions.

## Process probe (optional)

Every tick reads the process table, the listening ports and the GPU.
By default Node walks `/proc`, spawns `ss` and `nvidia-smi`; with a Rust toolchain a small helper
in `probe/` (no crates) does it in under half the time and without blocking the event loop:

```bash
bin/probe-mode.sh build    # cargo build --release
bin/probe-mode.sh rust     # use it (restarts the service)
bin/probe-mode.sh node     # back to the Node path
bin/probe-mode.sh status
```

If the helper fails three times in a row the dashboard falls back to Node on its own; `host.probe`
in `/api/state` says which path is live.

## Project icons

Every project and every org folder gets a tile. Beast looks for an icon in the project itself, in this
order: the `expo.icon` of `app.json`, `app/icon.(png|svg)` and `app/favicon.ico` (Next.js), a
`favicon*` / `icon*` / `apple-touch-icon*` / `logo*` file under `public/` or `static/`, `assets/icon.png`,
`src/assets/`, and finally the Android (`mipmap-xxxhdpi/ic_launcher.png`) or iOS (`AppIcon.appiconset`)
launcher icon. SVG wins over PNG, PNG over ICO; files over 512 KB are skipped. Nothing found → a glyph
for the stack (Next, React, Expo, Node, Python, Docker, …).

To set your own, open the card's ⋯ menu (or an org's ⋯) → **Set icon…**: upload an SVG, PNG, JPG,
WebP or ICO, reset to the found one — or **Ask Claude to draw one**. That starts a chat in the project
(or the org folder) that looks at the README and code and writes one SVG to
`state/icons/custom/<project-id>.svg` (orgs: `org-<name>.svg`); the tile updates as soon as the file
lands. When some projects have no icon, the Projects view shows a banner — *N projects have no icon —
Ask Claude to draw them* — which starts one chat for all of them. Uploaded and drawn SVGs are checked
(no scripts, event handlers, `javascript:` or external references) and served with a sandboxing CSP.

## Sleep button (optional)

For a desktop that should not run all night: set `sleepButton: true` and ⚙ Settings gets a **Power → Sleep** row.
It sets an RTC alarm for the next weekday (Mon–Fri 07:00) and suspends the machine; the dashboard shows when
it will wake. It needs passwordless sudo for exactly two commands, e.g. in `/etc/sudoers.d/beast-sleep`:

```
youruser ALL=(root) NOPASSWD: /usr/sbin/rtcwake, /usr/bin/systemd-run
```

## Android emulator (optional)

The Android card shows up once `adb` sees a device or an AVD exists. The SDK is taken from
`$ANDROID_HOME` / `$ANDROID_SDK_ROOT`, else `~/Android/Sdk`. *Start* runs
`emulator -avd <name> -no-window -gpu host` — headless on the real GPU (software rendering costs a
CPU core while idle). For your own start script set `EMULATOR_LAUNCHER=/path/to/script` in the
service environment; it is called with the AVD name. Input goes through `adb` with argument arrays
only (no shell).

## Voice input (Whisper)

Optional. `bin/setup-whisper.sh` makes `whisper/.venv` with [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
(plus the CUDA 12 libraries when there is an NVIDIA GPU) and installs the `beast-whisper` user unit. It is
**not** started at boot: pressing the mic starts it (the model loads in 1–3 s while you already talk — the
recording is buffered), and it exits a minute after the last use, so the GPU isn't held.

- Settings in `whisper/whisper.env` (from `whisper.env.example`): model, device (`auto` = GPU if there is one,
  else CPU int8 — use `small` there), the languages you speak (detection never picks a third one), a prompt
  with your jargon, regex fixes for words it keeps mishearing.
- On a GPU (`large-v3-turbo`) a 30 s recording transcribes in well under a second; idle, the loaded model
  costs a few hundred MB of RAM and ~2 GB of VRAM, nothing else.
- The recording sheet covers the page: *Starting mic…* until the microphone is really live, then a beep —
  iOS takes a moment (and home-screen apps ask for the mic again after being killed). While you talk, a
  level wave moves with your voice.
- No streaming: the whole recording goes to Whisper once, on **Stop**, and the text lands in the message
  box for you to fix and send. One pass over the full audio is more accurate than re-transcribing a
  half-finished recording, and the GPU only works for that one pass.

Without it the mic uses the browser's own speech recognition (Safari / Chrome), right away.

If Whisper is installed but can't start (a broken venv, a model that fails to load), Stop no longer waits it out. The
dashboard notices the service failed and stops it, and the recording stays in the bar with **Try again**, **Say it
again** (browser speech) and **Discard**. For the next 5 minutes the mic uses the browser; **Try again** always tries
Whisper. The unit doesn't restart itself, the dashboard starts it when it is needed.
