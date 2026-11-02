# Back / Forward walk through pages and chats

## Goal

The browser's Back and Forward buttons (Android back gesture, mouse side buttons, Alt+←/→) move through the pages and
chats you visited, the way they do on any website, instead of leaving the dashboard.

Before: only overlays (drawer, chat panel, dialog, palette, phone Code steps) pushed a history entry. Switching pages
(Home / Projects / Code / Tasks) or chats added nothing, so Back from Tasks left the dashboard, and Back from the third
chat closed the whole panel, with the next Back leaving. Forward never restored anything.

## Model

- **Location** = the page (`UI.view`) plus the chat on screen (`TERM.active`; `''` = the phone's session list; `null` =
  panel closed). Every history entry stores the location it shows: `{ bd, depth, id, loc }`.
- **Navigation** (`navTo()`): a page from the nav / tab bar / palette / search / Esc, a chat (`openTerm`), the phone's
  Sessions tab, Code opened from elsewhere. It pushes one entry when the location changed. Opening the chat you are
  already on adds nothing.
- **Overlays** stay as before: drawer, dialog (`#modal`), palette and the phone Code steps push an entry. Back closes
  them, and closing them from the UI pops that entry.
- **Back / Forward** (`popstate` from the user): Back first closes overlays that were above the entry it landed on,
  then the location stored on that entry is applied (page, chat or panel closed). Forward applies the stored location.
  Direction comes from the entry's `depth` against ours, so several steps at once (long-press on Back) also work.
- **Closing the chat panel** (✕, Esc, the back arrow, the terminal's "dashboard" key): go back to the entry you opened
  the chats from, so Back from there continues with the pages before, and Forward brings the chats back.
- **Stale entries**: an overlay entry whose overlay is gone (closed from the UI, then Forward), or a chat that has
  ended, is skipped in the direction of travel when the browser can (Navigation API `canGoForward`; Back never steps
  below the first entry). Otherwise it shows the page it was on.
- `LAYERS.hist` mirrors our entries (index = depth), so closing the panel and the Code view know what is on top
  without reading other entries.

Kept: the in-flight queue (a push while our own `history.back()` is on its way), the dialog handover
(`close(); openTerm(x)` in one tick reuses the dialog's entry), and Chrome's history intervention workaround (after the
user's Back, a push without a new gesture steps forward onto an existing entry instead of `pushState`).

## Steps

1. `app.js`: location helpers, `navTo()`, `applyLoc()`, entry mirror, new `popstate`, `closeTermPanel` → back to
   the page before the chats; `openTerm`, nav, tab bar, `#btn-shell`, palette actions, search, Esc call `navTo()`.
2. `f-code.js`: `history.go(-n)` through the shared helper; `leave()` only steps back over Code entries that are on
   top; desktop `open()` is a navigation (Back returns to the chat or page you came from).
3. Headless Chromium test (desktop + phone): pages, chats, phone session list, overlays, Code steps, Forward, leaving
   only from the first entry.
4. `node --test test/*.test.js`, `bin/gate.sh <port>`.

## Out of scope

- Reopening dialogs/drawers on Forward (their content is gone once closed).
- URLs per page (`?view=` / `?term=` in the address bar).
