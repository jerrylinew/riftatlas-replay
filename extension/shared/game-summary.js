/**
 * What the library says about one game: who played what, how it ended, the
 * mulligans, the sideboarding, and where each mark falls.
 *
 * Everything comes from the replay itself. The recording seat sees its own
 * cards, so its opening hand and what it sent back are exact; the opponent's
 * mulligan is only ever a count, read from the game's own log, because their
 * hand was hidden and a replay never pretends otherwise.
 *
 * Pure, so it runs in the service worker and in tests alike.
 */
import { timelineFromReplay, buildIndex } from './timeline-index.js';
import { cleanMarks } from './marks.js';

/**
 * A decklist as RiftAtlas writes it: sections headed "MainDeck:", "Runes:"
 * and so on, each line "3 Pit Rookie [OGN-136]". Returns section -> cards.
 */
export function parseDecklist(raw) {
  const sections = new Map();
  let current = null;
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const heading = /^([A-Za-z ]+):$/.exec(text);
    if (heading) {
      current = heading[1].replace(/\s+/g, '');
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    const card = /^(\d+)\s+(.+?)(?:\s+\[([^\]]+)\])?$/.exec(text);
    if (card && current) sections.get(current).push({ count: Number(card[1]), name: card[2], cardCode: card[3] ?? null });
  }
  return sections;
}

/** The sections whose contents change between games; the legend and champion do not. */
const PLAYED = ['MainDeck', 'Battlefields', 'Runes'];

/**
 * What went in and what came out, comparing the deck played with the deck
 * registered for the event. Each change is { name, cardCode, count, section }.
 */
export function deckChanges(registeredRaw, submittedRaw) {
  const registered = parseDecklist(registeredRaw);
  const submitted = parseDecklist(submittedRaw);
  const tally = (deck) => {
    const by = new Map();
    for (const section of PLAYED) {
      for (const c of deck.get(section) ?? []) {
        const key = `${section}|${c.cardCode ?? c.name}`;
        const was = by.get(key);
        by.set(key, { ...c, section, count: (was?.count ?? 0) + c.count });
      }
    }
    return by;
  };
  const before = tally(registered);
  const after = tally(submitted);
  const ins = [];
  const outs = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(key)?.count ?? 0) - (before.get(key)?.count ?? 0);
    const card = after.get(key) ?? before.get(key);
    if (delta > 0) ins.push({ ...card, count: delta });
    if (delta < 0) outs.push({ ...card, count: -delta });
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return { in: ins.sort(byName), out: outs.sort(byName) };
}

const FINALIZED = /^(.+?) finalized mulligan \((\d+) recycled, (\d+) redrawn\)/;
const cardOf = (c) => ({ name: c.name || 'Unknown card', cardCode: c.cardCode ?? null });

/** The cards in `a` that are not in `b`, by card id. */
const without = (a, b) => {
  const ids = new Set(b.map((c) => c.id));
  return a.filter((c) => !ids.has(c.id));
};

/**
 * Summarise one replay. `marks` are the stored marks for it; each comes back
 * with where it falls - the turn or phase, and what had just happened.
 */
export function summarise(replay, marks = []) {
  const timeline = timelineFromReplay(replay);
  const index = buildIndex(timeline);
  const stateAt = (seq) => timeline.states.get(seq)?.[0] ?? null;
  const viewerId = replay.viewer?.playerId ?? null;
  const shell = replay.shell ?? {};

  // Who went first: the game says so once the choice is made.
  let firstPlayerId = null;
  for (const seq of index.sequences) {
    const id = stateAt(seq)?.firstPlayerId;
    if (id) { firstPlayerId = id; break; }
  }

  // The battlefield each player picked. Both picks are public, written onto
  // each player as they lock in; the last one seen is the one that stood.
  const battlefields = new Map();
  for (const seq of index.sequences) {
    for (const p of stateAt(seq)?.players ?? []) {
      if (p.selectedBattlefield) {
        battlefields.set(p.id, { name: p.selectedBattlefield, cardCode: p.selectedBattlefieldCardCode ?? null });
      }
    }
  }

  // Mulligans: everyone's count from the log, and the recording seat's cards
  // from the board either side of the mulligan.
  const players = replay.players ?? [];
  const byName = new Map(players.map((p) => [p.name, p]));
  const mulligans = [];
  for (const event of index.events) {
    const m = FINALIZED.exec(event.text ?? '');
    if (!m) continue;
    const who = byName.get(m[1]);
    if (!who || mulligans.some((x) => x.playerId === who.id)) continue;
    mulligans.push({ playerId: who.id, name: who.name, recycled: Number(m[2]), redrawn: Number(m[3]) });
  }

  // The last mulligan to finish also starts the game, so the hand after it
  // already holds the first player's opening draw. The game's own playback
  // record tells the two apart: `refill` draws replace what was sent back,
  // `opening` draws start the game.
  let myMulligan = null;
  const mulliganCommits = replay.commits.filter((c) => c.action?.type === 'submit_mulligan');
  if (viewerId && mulliganCommits.length) {
    const lastSeq = mulliganCommits.at(-1).sequence;
    const handAt = (seq) => stateAt(seq)?.players?.find((p) => p.id === viewerId)?.board?.hand ?? null;
    const opening = handAt(mulliganCommits[0].baseSequence);
    const after = handAt(lastSeq);
    const visible = (hand) => hand && hand.every((c) => !c.isPlaceholder);
    if (visible(opening) && visible(after)) {
      const playback = stateAt(lastSeq)?.mulliganPlaybackByPlayerId?.[viewerId] ?? null;
      const drawn = (kind) => new Set((playback?.draws ?? []).filter((d) => d.kind === kind).map((d) => d.cardId));
      const startIds = drawn('opening');
      const refillIds = drawn('refill');
      const newCards = without(after, opening);
      const drew = playback ? newCards.filter((c) => refillIds.has(c.id)) : newCards;
      const startDraw = playback ? newCards.filter((c) => startIds.has(c.id)) : [];
      const kept = after.filter((c) => !startIds.has(c.id));
      myMulligan = {
        opening: opening.map(cardOf),
        kept: kept.map(cardOf),
        sentBack: without(opening, after).map(cardOf),
        drew: drew.map(cardOf),
        startDraw: startDraw.map(cardOf),
      };
    }
  }

  // Sideboarding. Of a player's three decklists, `deck` is the one being
  // played: sideboarding writes it as the player locks in. `submittedDeck`
  // trails a game behind - in game two it still holds game one's deck - so
  // it is only useful as exactly that, the previous game's deck. Only the
  // recording seat's lists are ever sent to it.
  const meAt = (seq) => stateAt(seq)?.players?.find((p) => p.id === viewerId) ?? null;
  const playing = index.sequences.find((q) => stateAt(q)?.phase === 'in_game') ?? index.last;
  const mineNow = meAt(playing);
  const mineAtStart = replay.origin?.snapshot?.players?.find((p) => p.id === viewerId);
  const registered = mineNow?.registeredDeck?.raw ?? mineAtStart?.registeredDeck?.raw
    ?? shell.selfPlayer?.registeredDeck?.raw ?? null;
  const played = mineNow?.deck?.raw ?? mineNow?.decklistRaw ?? mineAtStart?.deck?.raw ?? null;
  let sideboard = null;
  if (registered && played) {
    sideboard = deckChanges(registered, played);
    // The previous game's deck is known only if the recording began before
    // this game's sideboarding, while `submittedDeck` still held it.
    const previous = replay.origin?.snapshot?.phase === 'sideboarding'
      ? mineAtStart?.submittedDeck?.raw ?? null : null;
    if (previous && (shell.gameNumber ?? 1) > 1) sideboard.sincePrevious = deckChanges(previous, played);
  }

  // Marks, placed: the first state at or after each, its turn, and the move.
  const latestEventAt = (seq) => {
    let found = null;
    for (const e of index.events) { if (e.sequence <= seq) found = e; else break; }
    return found;
  };
  const placed = cleanMarks(marks).map((mark) => {
    const target = index.sequences.find((q) => q >= mark.sequence) ?? index.last;
    const chapter = index.chapterBySequence.get(target);
    return {
      ...mark,
      target,
      turn: chapter?.kind === 'turn' ? chapter.turnNumber ?? null : null,
      phase: chapter?.kind === 'phase' ? chapter.label : null,
      text: mark.text,
      context: latestEventAt(target)?.text ?? null,
    };
  });

  return {
    recordingId: replay.recordingId ?? null,
    room: replay.match?.roomCode ?? null,
    startedAt: replay.match?.capturedAt ?? null,
    durationMs: replay.match?.durationMs ?? null,
    matchFormat: replay.match?.matchFormat ?? null,
    playMode: replay.match?.playMode ?? null,
    series: shell.seriesId ? { id: shell.seriesId, game: shell.gameNumber ?? null } : null,
    viewerId,
    players: players.map((p) => ({ ...p, isViewer: p.id === viewerId, battlefield: battlefields.get(p.id) ?? null })),
    winnerPlayerId: replay.match?.outcome?.winnerPlayerId ?? null,
    reason: replay.match?.outcome?.reason ?? null,
    firstPlayerId,
    turns: index.chapters.filter((c) => c.kind === 'turn').length,
    last: index.last,
    partial: replay.partial === true,
    mulligans,
    myMulligan,
    sideboard,
    marks: placed,
  };
}
