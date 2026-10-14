#!/usr/bin/env node
/**
 * What the library says about a game: mulligans, sideboarding, who went
 * first, and where marks fall.
 *
 * The recording seat's own hand is visible, so its mulligan is read card by
 * card from the board either side of it; the opponent's hand never was, so
 * theirs is only ever the count the game's log announces.
 *
 *   node tests/game-summary.mjs
 */
import { parseDecklist, deckChanges, summarise } from '../extension/shared/game-summary.js';

let failed = 0;
const check = (ok, label, got) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok && got !== undefined) console.log(`       got ${JSON.stringify(got)}`);
};

// ── Decklists ────────────────────────────────────────────────────────────
const REGISTERED = `Legend:
1 Rengar, Pridestalker [UNL-183]

MainDeck:
3 Pit Rookie [OGN-136]
2 Thrill of the Hunt [UNL-184]
1 Brynhir Thundersong [OGN-026]

Runes:
8 Body Rune [OGN-126]
4 Fury Rune [OGN-007]

Sideboard:
1 Graves, Blasting Through [RAD-085]
1 Thrill of the Hunt [UNL-184]`;
const PLAYED = `Legend:
1 Rengar, Pridestalker [UNL-183]

MainDeck:
3 Pit Rookie [OGN-136]
1 Graves, Blasting Through [RAD-085]
2 Brynhir Thundersong [OGN-026]

Runes:
7 Body Rune [OGN-126]
5 Fury Rune [OGN-007]

Sideboard:
3 Thrill of the Hunt [UNL-184]`;

// Game two's deck: the registered one with a second Brynhir for a Thrill.
const PREVIOUS = REGISTERED
  .replace('2 Thrill of the Hunt [UNL-184]', '1 Thrill of the Hunt [UNL-184]')
  .replace('1 Brynhir Thundersong [OGN-026]', '2 Brynhir Thundersong [OGN-026]');

const deck = parseDecklist(REGISTERED);
check(deck.get('MainDeck')?.length === 3 && deck.get('MainDeck')[0].count === 3
  && deck.get('MainDeck')[0].cardCode === 'OGN-136', 'a decklist is read by section');
const changes = deckChanges(REGISTERED, PLAYED);
const show = (list) => list.map((c) => `${c.count} ${c.name}`).join(', ');
check(show(changes.in) === '1 Brynhir Thundersong, 1 Fury Rune, 1 Graves, Blasting Through',
  'brought in, runes included', show(changes.in));
check(show(changes.out) === '1 Body Rune, 2 Thrill of the Hunt', 'took out', show(changes.out));
const same = deckChanges(REGISTERED, REGISTERED);
check(!same.in.length && !same.out.length, 'the registered deck unchanged');

// ── A short match ────────────────────────────────────────────────────────
const ME = 'plr_me';
const THEM = 'plr_them';
const card = (id, name, code) => ({ id, name, cardCode: code });
const hidden = (n) => ({ id: `__hidden_zone__:${THEM}:hand:${n}`, isPlaceholder: true });
const log = (id, text, extra = {}) => ({ id, text, ...extra });
const player = (id, name, hand, extra = {}) => ({ id, name, seat: id === ME ? 1 : 2, board: { hand, score: 0 }, ...extra });

const replay = {
  format: 'riftatlas-replay', version: 1, recordingId: 'ABCDE@1',
  match: { roomCode: 'ABCDE', capturedAt: 1, durationMs: 600000, matchFormat: 'bo3',
    outcome: { winnerPlayerId: ME, reason: 'victory' } },
  viewer: { playerId: ME },
  shell: { seriesId: 'series_1', gameNumber: 3 },
  players: [{ id: ME, name: 'jerry', legend: { name: 'Rengar' } }, { id: THEM, name: 'opp', legend: { name: 'Riven' } }],
  origin: {
    sequence: 0,
    snapshot: {
      // Recorded from sideboarding, as games two and three are. `submittedDeck`
      // trails a game behind: here it is still game two's deck, and so is
      // `deck` until sideboarding writes this game's.
      phase: 'sideboarding',
      players: [
        player(ME, 'jerry', [card('a', 'Pit Rookie'), card('b', 'Pit Rookie'), card('c', 'Inferna')],
          { registeredDeck: { raw: REGISTERED }, submittedDeck: { raw: PREVIOUS }, deck: { raw: PREVIOUS } }),
        player(THEM, 'opp', [hidden(0), hidden(1), hidden(2)]),
      ],
    },
    gameplayLog: [],
  },
  commits: [
    { sequence: 1, baseSequence: 0, action: { type: 'submit_sideboard' }, operations: [
      { op: 'set_player_fields', playerId: ME, fields: { deck: { raw: PLAYED }, decklistRaw: PLAYED } },
    ] },
    { sequence: 2, baseSequence: 1, action: { type: 'submit_mulligan' }, operations: [
      { op: 'set_player_fields', playerId: ME, fields: { selectedBattlefield: 'Star Spring', selectedBattlefieldCardCode: 'UNL-215' } },
      { op: 'set_player_fields', playerId: THEM, fields: { selectedBattlefield: "Hunters' Circle", selectedBattlefieldCardCode: 'RAD-163' } },
      { op: 'zone_remove', playerId: ME, zone: 'hand', cardIds: ['b'] },
      { op: 'zone_insert', playerId: ME, zone: 'hand', index: 2, cards: [card('d', 'Sabotage')] },
      { op: 'log_insert', index: 0, entries: [log('l1', 'jerry finalized mulligan (1 recycled, 1 redrawn).')] },
    ] },
    { sequence: 3, baseSequence: 2, action: { type: 'submit_mulligan' }, operations: [
      // The last mulligan also starts the game: the first player draws, in the
      // same commit, and the game's playback record says which card is which.
      { op: 'set_room_fields', fields: { firstPlayerId: ME, phase: 'in_game', mulliganPlaybackByPlayerId: {
        [ME]: { draws: [{ cardId: 'd', kind: 'refill' }, { cardId: 'e', kind: 'opening' }] },
      } } },
      { op: 'zone_insert', playerId: ME, zone: 'hand', index: 3, cards: [card('e', 'Rampage')] },
      { op: 'log_insert', index: 0, entries: [log('l2', 'opp finalized mulligan (2 recycled, 2 redrawn).')] },
    ] },
    { sequence: 4, baseSequence: 3, action: { type: 'play' }, operations: [
      { op: 'log_insert', index: 0, entries: [log('l3', 'opp played a unit.', { turnNumber: 1, turnPlayerId: THEM })] },
    ] },
    { sequence: 5, baseSequence: 4, action: { type: 'play' }, operations: [
      { op: 'log_insert', index: 0, entries: [log('l4', 'jerry played Sabotage.', { turnNumber: 2, turnPlayerId: ME })] },
    ] },
  ],
  gaps: [],
};

const s = summarise(replay, [{ sequence: 5, text: 'why Sabotage here?' }, { sequence: 2 }]);
check(s.firstPlayerId === ME, 'who went first', s.firstPlayerId);
const bf = Object.fromEntries(s.players.map((p) => [p.id, p.battlefield?.name]));
check(bf[ME] === 'Star Spring' && bf[THEM] === "Hunters' Circle", 'the battlefield each player picked', bf);
check(s.series?.id === 'series_1' && s.series.game === 3, 'which game of which series', s.series);
check(s.myMulligan && s.myMulligan.opening.map((c) => c.name).join() === 'Pit Rookie,Pit Rookie,Inferna',
  'your opening hand', s.myMulligan?.opening);
check(s.myMulligan?.sentBack.map((c) => c.name).join() === 'Pit Rookie', 'the one you sent back',
  s.myMulligan?.sentBack);
check(s.myMulligan?.drew.map((c) => c.name).join() === 'Sabotage', 'and the one you drew', s.myMulligan?.drew);
check(s.myMulligan?.startDraw.map((c) => c.name).join() === 'Rampage'
  && s.myMulligan.kept.length === 3, 'the draw that started the game is not counted as a mulligan', s.myMulligan);
check(s.mulligans.find((m) => m.playerId === THEM)?.recycled === 2, "the opponent's count from the log",
  s.mulligans);
check(show(s.sideboard?.in ?? []) === '1 Brynhir Thundersong, 1 Fury Rune, 1 Graves, Blasting Through',
  'sideboarding: the deck played, not the one the game is still carrying from before', show(s.sideboard?.in ?? []));
check(show(s.sideboard?.sincePrevious?.in ?? []) === '1 Fury Rune, 1 Graves, Blasting Through'
  && show(s.sideboard?.sincePrevious?.out ?? []) === '1 Body Rune, 1 Thrill of the Hunt',
  'and what changed since the previous game', s.sideboard?.sincePrevious);
check(s.marks.map((m) => m.sequence).join() === '2,5', 'marks in match order');
const late = s.marks.find((m) => m.sequence === 5);
check(late?.turn === 2 && late.context === 'jerry played Sabotage.' && late.text === 'why Sabotage here?',
  'a mark knows its turn and the move', late);

const noHands = summarise({ ...replay, viewer: { playerId: THEM } });
check(noHands.myMulligan === null, 'a seat whose own hand was hidden gets counts, never invented cards');
check(noHands.sideboard === null, 'and no sideboard when its decklists were not sent to it');

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
