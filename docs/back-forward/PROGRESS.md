# Progress — Back / Forward through pages and chats

## 2026-11-02

Done, on branch `feat/back-forward-pages` (on top of 3.6.0):

- `public/app.js`: history entries carry the place they show (`loc`: page + chat). `navTo()` pushes one entry per
  navigation (nav, tab bar, palette, search, Esc → Home, a chat, the phone's Sessions tab, `#btn-shell`); the user's
  Back / Forward apply the stored place (`applyLoc`), after Back has closed the overlays it left (`closeOverlays`).
  Closing the chat panel goes back to the page the chats were opened from (`leaveChats`). Overlays whose entry is stale,
  and ended chats, are passed over in the direction of travel. `LAYERS.hist` mirrors the entries. A reload restores the
  entry's page and chat. The dialog handover, in-flight queue and Chrome history-intervention workaround are kept.
- `public/f-code.js`: `leave()` and `open()` step back via `goBack()` and only over Code entries that are on top;
  opening Code is a page (the chat you came from stays below, a drawer's entry is taken over).
- `docs/back-forward/browser-check.js`: headless Chromium check, desktop + phone, with and without the Navigation API.

Checks:

- browser check: 91/91 (Navigation API), 91/91 (`NO_NAV_API=1`)
- `node --test test/*.test.js`: 176/176
- `bin/gate.sh 18931`: green

Known limits:

- Forward can't reopen a dialog / drawer / palette or redo a phone Code step; it passes over them when the browser
  can tell there is an entry after it, otherwise it shows the page under it.
- Entries from before this change (bd `term`/`layer`, no `loc`), seen after a reload onto the update, still close their
  layer on Back but restore no page.
