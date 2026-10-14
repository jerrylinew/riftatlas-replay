# Changelog

What changed in each released version, in the words a player would use. The
Chrome Web Store has no changelog field, so this is the record, and the source
for the "What's new" block in the listing description.

## Unreleased

- **Replays of games that started recording in the lobby now play.** If the
  extension began recording while you were waiting for your opponent, Watch
  replay showed an empty lobby instead of the board. That is fixed for new
  recordings and for ones you already have, and exports of those games now
  include your decklist.

## 0.7.0

- **In-game overlay.** Switch on *Enable In-Game Overlay* in the popup and a
  small control appears in the corner of the board during a match. Its eye
  button lists each time your opponent revealed their hand or the top of their
  deck and then hid it again, with every card that was shown — including ones
  played or drawn before it was hidden — and each card's picture, cost and
  colour. Hover a card to see it larger. The same cards shown several times in
  a row are one entry, marked ×2, ×3 and so on. It folds down to a single icon
  you can drag anywhere. Off by default.
- **Reveals in replays.** The replay control bar has the same eye button. It
  lists what had been revealed and hidden again up to the point you are
  watching, and *Show on board* jumps to the moment the cards were showing.
- The arrow keys in a replay move one step again. Each press was being handled
  twice, so it skipped every other step.

## 0.6.2

- Removed the `tabs` permission. Nothing needed it, and it read as access to
  every tab you have open. The extension asks for three permissions now instead
  of four, and only ever touches the RiftAtlas tab its host permission covers.

## 0.6.1

- **Matches are no longer cut in half.** RiftAtlas keeps several connections
  open at once, and any of them closing — the lobby, not your game — ended
  whatever match was being recorded. The half that followed had nothing to
  anchor on, so it built into a replay stuck on its final position. Only the
  connection carrying your match can end its recording now.
- A replay holding nothing but the final position says so, instead of offering
  a Rebuild that cannot help.
- **The dice roll is no longer read as a win.** "EagleV wins initiative (15 vs
  1)" was being taken as the result, so a match that ended with nothing recorded
  was credited to whoever won the roll. A match with no ending now honestly
  shows none.

## 0.6.0

- **Best-of-three results are recorded properly.** A game settled by the winner
  prompt that appears when you press "Next game" ends with nothing in its own
  log — no victory line, no concession, no winning score. The result is read
  from the series instead. The last game of a series still has to end in the
  game.
- A match's final action arriving just after the next game's room opens now
  lands in the match it belongs to, rather than being dropped.

## 0.5.0 and earlier

Development before the first store submission: the recorder, the standalone
player, replay mode inside RiftAtlas' own board, the popup, and the packaging
and publishing tooling.
