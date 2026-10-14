# Installing RiftAtlas Replay

Chrome or any Chromium browser (Edge, Brave, Arc).

## Install

Get it from the
**[Chrome Web Store](https://chromewebstore.google.com/detail/riftatlas-replay/cbngbmmoeoonnklncjdlccggpkmicdho)**
and press **Add to Chrome**. Chrome keeps it up to date from then on.

The RiftAtlas Replay icon appears in your toolbar. Pin it — you'll use it.

> Updating the extension while a match is running **stops that recording**: the
> page's connection to the extension is torn down and only a page reload
> restores it. Chrome usually updates on restart, so this is rare — but if a
> match stops recording partway, that is the likely reason.

> Recordings live in the extension's own storage. **Removing the extension
> deletes them.** If you have a recording you care about, hit **Export** first.

### Testing a build that isn't in the store yet

If you were sent a zip of an unreleased version:

1. Unzip it somewhere you can leave it — Chrome loads the extension from this
   folder every time it starts, so don't delete or move it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**, top right.
4. Click **Load unpacked** and pick the unzipped folder (the one with
   `manifest.json` in it).

To update, **unzip the new version over the old folder**, then press the reload
arrow on the extension's card in `chrome://extensions`. Your recordings are
kept. The version currently loaded is shown on the card — if a fix does not seem
to have taken effect, check that first.

Chrome shows *"Disable developer mode extensions"* warnings on startup for
anything installed this way. That is expected and safe to dismiss.

> A zip build and the store version are **separate extensions** to Chrome, each
> with its own recordings. Export anything you want to keep before switching
> from one to the other, and disable whichever you're not using — with both on,
> each records every match.

Want to read or build the source instead? See
[`CONTRIBUTING.md`](CONTRIBUTING.md) — there is no build step, so the code you
can read is exactly the code that runs.

## Recording a match

Nothing to do. Play on `play.riftatlas.com` as normal and it records in the
background. Open the popup afterwards and your match is listed.

Each recording shows the scoreline — you on the left, your opponent on the
right, each with their legend beneath — and one button, **Watch replay**, which
plays it back in RiftAtlas' own board with card art and their match log.

A green edge means you won, a red one that you lost, and a ✓ marks the winner.
The score itself is left plain, because the winner is not always the higher
number.

RiftAtlas records leaving a room as a concession, and winners usually leave as
soon as they have won — so its log credits the win to whoever stayed. When a
finished match has exactly one player on the winning score (8, or 11 in 2v2),
that player is shown as the winner instead, with the reason `score`.

Reaching the winning score never *ends* a recording. Scores are manual and can
be set wrongly, so a match only closes when the room empties, a new one starts,
the log announces a result, or the connection drops — and the score is only read
once that has happened.

Under the player names are three small ones:

| | |
|---|---|
| ⤓ | **Export** — save as `.ratlas.json` to send to someone. Rebuilds first, so an export is always current. |
| ⟳ | **Rebuild** — re-assemble from the recording. Not normally needed; recording is continuous and Export rebuilds anyway. Use it if a replay looks short. |
| ✕ | **Delete** — asks first, and cannot be undone. |

**Copy** beside the room code copies it.

Once you have a few matches, a search box appears. It matches room codes,
either player, either legend, the format, and the date — so `zed`, `bertoc`,
`bo3` and `sep` all work, and several terms narrow rather than widen
(`zed bertoc` finds Zed games against BertoC). Escape clears it.

## If RiftAtlas says it can't reconnect to your game

Press **Back to lobby** in the popup. Replay mode borrows the client's "which
room am I in" state, and if that is left behind the client keeps trying to
rejoin a room that only ever existed as a replay.

## Watching a replay

**In RiftAtlas' board** — with `play.riftatlas.com` open in a tab, press **Watch
replay** on a match in the popup. The tab reloads and the match plays in the
real client with card art and the game's own log. A control bar sits at the
bottom.

**In the standalone player** — the **Player** button in the popup. Plainer, but works
offline with RiftAtlas closed, and opens a `.ratlas.json` someone sent you, or a
DevTools `.har` capture dropped straight onto the page.

### Moving the controls

The replay controls start under the board. Drag them anywhere by any part that
is not a button or the slider, or use the move button (or double-click) to swap
between bottom-centre and bottom-right. The bottom-right position uses a
narrower stacked layout, since a wide bar does not fit there. Wherever you leave
them is where they will be next time.

### Controls

| Key | Does |
|---|---|
| space | play / pause, and replay again once it ends |
| left, right | step |
| Home, End | jump to start or end |

Playback runs about a second a move, but skips quickly through repeated actions
— four rune exhausts in a row don't cost four seconds. Drag the slider to scrub.

### The library

Press **Library** in the popup for every game in one page: best-of-three games
grouped together with the series score, and for the game you pick:

- the result, the score, who went first, and the battlefield each of you picked
- your **mulligan** — your opening hand with what you sent back crossed out, and
  what you drew. For your opponent, only how many they sent back: their hand
  was hidden from you, so the recording never had it
- your **sideboarding** — what you brought in and took out since the previous
  game of the series, and compared with the deck you registered
- your **marks and notes**. Click one to watch the replay from that step (keep a
  `play.riftatlas.com` tab open), and edit or delete notes right there

Search finds games by opponent, legend, room code, or words in your notes. The
up and down arrows move through the list.

### Adding a replay file to your list

Press **Import** in the popup, then pick a `.ratlas.json` — one you exported, or
one someone sent you. It opens in the player and is added to your recordings
straight away, ready for **Watch replay**, with any marks it came with. Any
replay you open in the player can be added the same way with **Add to my
recordings**.

An imported replay is marked *imported* in the list. It has no recording behind
it, so it has no Rebuild button; Export, Delete and marking work as usual.
Importing the same file again replaces it. A match you recorded yourself is
never replaced by a file of it.

### Marking steps and writing notes

To come back to a moment — a decision you're unsure of, something to ask a
coach about — mark it.

| Key | Does |
|---|---|
| M | mark the step you're on (again to unmark it) |
| N | write a note on the step you're on |
| `,` `.` | jump to the previous / next mark |

The ☆ button on the bar does the same as M. The list button beside it opens
every mark in the match with its note: click one to go there, the pencil to
edit, the bin to delete (a mark with a note asks first). Ctrl+Enter saves a
note, Esc cancels. Marks show as gold ticks above the slider.

Marks are saved with the recording and survive Rebuild. **Export** includes
them, so someone you send the file to sees your marks and notes in the
standalone player under its **Marks** tab — they can't change them. The popup
shows ★ and a count on any recording with marks, and searching finds words in
your notes.

## What it does with your data

- Recordings stay in the browser. Nothing is uploaded anywhere, by anyone.
- Auth tokens are dropped before anything is written, so an exported replay
  carries no credentials. The test suite fails the build if one ever appears.
- A replay contains what you could see during the match: both players' names,
  the board, and your own decklist. Your opponent's hidden cards were masked by
  the server and stay masked.
- Exporting is the only way anything leaves your machine, and only you can do it.

## What it does not do

It never sends, changes, or delays a game action. It watches the connection and
writes down what the server says. There is no code path from it to RiftAtlas'
servers — the recorder has no way to send at all.

## Known rough edges

- **Replay mode breaks if RiftAtlas ships a UI change.** The standalone player
  keeps working regardless.
- **Multiplayer and sealed formats are untested.** Duel is what has been played;
  free-for-all, 2v2, and sealed have never been recorded, so if one of those
  misbehaves that's useful to hear about.
- **The last game of a best-of-three can end with no result recorded**, in one
  specific case: if you settle it with the winner prompt that appears when you
  press "Next game", rather than in the game itself. Earlier games in the series
  are fine — their result turns up in the next game's data — but the final game
  has no next game to carry it.

Duel is well covered now: matches ending on score, on a concession, and a full
best-of-three series have all been recorded and replayed end to end.

## If a replay says it could not build, or stops early

RiftAtlas adds things to its game protocol from time to time, and a version of
this extension that predates one will not know what to do with it. When that
happens the replay stops at that point and says so.

**The recording is not damaged** — only the replay built from it, and only from
that point on. Everything before it still plays.

The message says which of two situations you are in:

- *"press Rebuild to try again"* — an ordinary hiccup. It is retried
  automatically each time you open the popup, so it has usually cleared itself
  before you read this.
- *"RiftAtlas has added something this version does not know yet"* — nothing you
  can do will fix it, because the missing piece has to be written. Send a
  **Debug dump**. Your recording keeps waiting, and the replay rebuilds itself
  in full once a version arrives that understands it.

## If a replay is much shorter than the match

A break in the recording makes everything after it unreplayable, so a replay can
hold hundreds of actions and only play the first few. The player says so at the
top — *"Incomplete — plays 8 of 396 recorded actions"* — rather than passing it
off as a short game.

Most breaks are recovered: the replay resumes from the next usable snapshot
instead of giving up. If an older recording stops early, press **Rebuild** on it
to try again.

## Telling us something went wrong

Hit **Debug dump** in the popup. It writes `riftatlas-replay-debug.json` to your
Downloads with everything the recorder holds — raw commits included, so a
recording that will not even build can still be diagnosed. Send that.

It carries decklists and player names, and no credentials: the frames that carry
tokens are discarded before anything is stored.

Also useful: the room code, what you expected, and what happened instead.

Please don't send raw `.har` files — those *do* contain a live auth token. An
exported `.ratlas.json` or a debug dump is safe to share.
