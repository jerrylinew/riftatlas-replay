# Replay mode

Renders a recorded match in **RiftAtlas' own board**, by answering the client's
match socket locally with recorded frames instead of connecting to a server.

Verified working against the live client on 2026-09-16: the reference match
renders with real card art, their match log, score tracks, battlefields and
turn indicator, and steps forward and backward.

## Why it works

RiftAtlas' client renders a game purely from frames it receives — that is what
spectating is. Feed it the frames, and it draws the board. No rules engine, no
scraping, no reimplementation.

## Why this is not a cheat, structurally

`inject.js` is the only file in the extension that originates frames, and it is
fenced off:

1. **Never in `content_scripts`.** It cannot run unless the user asks for it.
2. **Armed with exactly one room code** — the replay's — and intercepts only
   `/parties/match/<that room>`. Every other socket, live matches included, goes
   to the real `WebSocket` untouched.
3. **No transport exists.** A `FakeSocket` has no connection; `send()` is a
   sink. Nothing here can reach RiftAtlas' servers.
4. **Refuses to arm while a live match socket is open** in the page.

The recorder never sends; replay mode never connects. Separate files, no shared
code path, so neither can drift into the other.

## Three things the live client required

None of these were guessable from the capture — each came from watching the real
client refuse to proceed.

**It must be armed before the page loads.** The app opens its match socket about
two seconds in. Injecting after that, the real socket wins and replay mode
correctly refuses to displace it. Arming has to happen at `document_start`.

The popup therefore parks the replay in session storage, registers the arming
scripts at `document_start`, and reloads the tab.

**And the client has to be put into the room.** Intercepting the socket is not
enough: the app only opens one once it believes it is in a room, and a fresh
page sits in the lobby with nothing to intercept. Driving its Join control does
not work either — joining by code asks the server whether the room exists, and a
finished match's room is usually gone.

So replay mode restores the room the way the client restores its own after a
reload. It keeps the current room in `riftbound_simulator_active_room`
(sessionStorage, per tab) and a recovery copy in `riftbound_simulator_last_room`
(localStorage). Writing those before the app boots makes it open the socket by
itself, with no server lookup, and the intercept answers. Leaving replay mode
puts the viewer's own room state back.

This was the bug that made the feature look like it did nothing: earlier tests
passed only because the browser happened to remember the room already. From a
cold lobby it landed on the deck list every time. Two things that cost a debug
cycle each: session storage is closed to content scripts until
`setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS')` is called, so `arm.js` read
nothing at all; and both scripts run at `document_start` with no ordering
guarantee while `postMessage` does not buffer, so they now handshake rather than
hope. The registration is torn down as soon as it is used, and on browser
startup, so replay mode is never sitting armed on a future page load.

**The viewer has to be a spectator.** The replay's `shell` says the viewer is
whoever recorded it; the person watching is signed in as someone else. The
client waits at *"Still opening your game…"* forever when it cannot find itself.
Rewriting `viewer` to `{ role: 'spectator' }` and dropping `selfPlayer` makes it
render immediately — spectating is a role the client already knows, and it does
not require the viewer to be seated.

**Sequence numbers must only ever climb.** The client discards a snapshot that
is not newer than what it holds, so seeking backwards was silently ignored — the
control bar moved and the board did not. Replay mode now sends a monotonic wire
sequence and carries the state of whatever replay sequence the cursor is on. The
replay's real sequence stays in the control bar, where a viewer reads it.

## Where the controls sit

Two shapes, because one does not fit everywhere. **Bar** is wide and low, which
suits the strip under the board; in the bottom-right, where a replay leaves the
chat panel's space free, it would run off the screen. **Box** is a narrow stack
for there.

Two places to put it, swapped with the move button or a double-click:

| Place | Shape |
|---|---|
| Bottom centre | Bar |
| Bottom right | Box |

A middle-left position was tried and dropped: it sat over the board rather than
beside it.

Dragging moves it anywhere and keeps whichever shape it had. Anything that is
not a button or the slider is a handle — the label, the count, the padding
between controls — because aiming for one small word is fiddly, and every part
that does nothing else may as well move it.
The choice is remembered in `localStorage` per browser, and a custom position is
clamped back into view when the window is resized, so a smaller window cannot
strand the controls off-screen.

## The control bar's geometry

Fixed: 640x46 for the bar, 172px wide for the box, and neither moves as the
cursor does. Nothing in it resizes as
the cursor moves, because the board is what you are reading and a bar that
reflows under the pointer makes stepping feel unreliable.

That rules out a few things the first version did wrong:

- **No log text.** The client already narrates the match in its own panel, top
  right. Repeating it here meant the bar's width tracked the length of whatever
  just happened. The text is now a tooltip on the bar.
- **No room code in the badge.** A variable-length code is a variable-width
  badge. The client shows the room in its own header.
- **Single-glyph buttons at a fixed 30x30.** The old ASCII `|<` and `>|` wrapped
  onto two lines when the bar was squeezed.
- **Tabular figures on the counter**, with width reserved for the largest value,
  so `9/370` and `370/370` occupy the same space.

The freed width went to a scrub slider, so any position is one drag away rather
than a few hundred clicks.

## Playback

A full second per step, except where that reads badly.

One player action often lands as several commits: exhausting four runes is four
of them, and so is nudging a counter up four times. Measured on the reference
match, **21 runs of three or more identical actions cover 91 of its 369
commits** — `adjust_card_counter` and `rune_batch` account for most of them, and
the longest run is six.

So a step earns the full beat only when it is something new to look at. A step
that repeats the previous action, or that the game did not narrate in its own
log, flicks past at 180ms. Runes still visibly go down one at a time; they just
do not each cost a second.

| | |
|---|---|
| Flat one second per commit | 370s (6.2 min) |
| Run-aware | 249s (4.1 min) — 148 fast steps, 222 full beats |

Measured on the live client: a six-long `rune_batch` run plays in two seconds,
where a flat beat would have managed two of its six steps.

The standalone player paces the same way, over narrated events rather than
commits.

The middle button carries three states in one fixed 30x30 slot, so swapping
glyphs cannot move anything:

| Glyph | State |
|---|---|
| `▶` | stopped — play |
| `⏸` | playing — pause |
| `↻` | finished — replay from the start |

Any manual control stops playback: stepping, jumping, or scrubbing. Otherwise
the bar keeps advancing out from under someone who scrubbed somewhere
deliberately to look at it.

| Key | Action |
|---|---|
| space | play / pause / replay |
| left, right | step |
| Home, End | first, last |
| M | mark this step, or unmark it if it has no note |
| N | write a note on this step |
| `,` `.` | previous / next mark |

Keys are ignored while a text field has focus, so the client's chat and its own
shortcuts keep working.

## Marks

Marks and their notes are kept by the extension, in the `extras` store beside
the recording's chat - not on the built replay, which every rebuild replaces.
This world cannot reach the extension's storage, so the work is split the way
the reveals panel is:

- **Here** (inject.js): the ☆ and list buttons, the keys, the gold ticks above
  the slider, and where the replay is. It posts `riftatlas-replay-marks`
  messages: `load`, `add`, `remove`, `edit` (open a step's note, marking it
  first if need be) and `state` (open or not, the sequence showing, a turn and
  log line per mark, the bar's box).
- **content/overlay.js**: keeps the list, saves through the worker
  (`marks` / `saveMark` / `deleteMark`), and draws `shared/marks-panel.js`
  beside the bar. It answers on `riftatlas-replay-marks-panel` with the list,
  a jump, or a close.

M never deletes a note: on a mark with words in it, it opens the note instead.

The library opens a replay at a mark: `replayMode` takes a `startSequence`,
which travels with the replay (`pendingStartSequence`, then arm.js) and puts the
cursor on the first state at or after it before the client asks for one.

A note is typed inside a closed shadow root, where a keystroke looks to the
page like one on a plain element - so Space would play and the arrows would
step. The overlay stops those keys at the window before anyone else sees them
(content scripts register first), and also flags its host with
`data-riftatlas-typing`, which this file's key handler checks, so the guard
holds whichever listener runs first.

## Known limits

- **Their UI, their rules.** It breaks whenever RiftAtlas changes the client, and
  `setupOrderVersion: 2` says that happens. The standalone player is the one that
  keeps working offline and after the site is gone.
- **Requires being signed in and online**, on their site.
- **The reducer is mirrored inline.** Replay mode runs in the page world where
  module imports are unavailable, so `inject.js` carries its own copy of the
  patch semantics. `tools/reducer.py` stays normative; the two must be kept in
  step, and there is no test binding them together yet.
- **Seeking is a full snapshot push**, so it is a hard cut rather than an
  animated step. Playing forward one commit at a time would animate, but has not
  been built.
