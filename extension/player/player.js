/**
 * Standalone replay player.
 *
 * Renders board state at a sequence and navigates in three tiers (sequence,
 * narrated event, chapter) per docs/replay-navigation.md. Every position comes
 * from the materialised timeline, so stepping backwards restores fog exactly
 * rather than trying to undo a reveal.
 *
 * Works offline with no RiftAtlas account: the CSP in player.html forbids
 * outbound connections.
 */
import { timelineFromReplay, buildIndex, Cursor } from '../shared/timeline-index.js';
import { harToReplay, looksLikeHar } from '../shared/har-import.js';
import { cleanMarks } from '../shared/marks.js';

const $ = (sel) => document.querySelector(sel);

/** Zones shown in each player's own area, in reading order. */
const SEAT_ZONES = [
  ['legend', 'Legend'], ['champion', 'Champion'],
  ['hand', 'Hand'], ['deck', 'Deck'], ['runeDeck', 'Rune deck'], ['runeArea', 'Runes'],
  ['base', 'Base'], ['trash', 'Trash'], ['banished', 'Banished'],
];
/** Contested zones, drawn between the seats with both sides visible. */
const FIELD_ZONES = [
  ['battlefieldA', 'Battlefield A'], ['battlefieldB', 'Battlefield B'],
  ['battlefieldC', 'Battlefield C'], ['battlefieldToken', 'Token'],
];

let state = null;   // { replay, timeline, index, cursor }
let playing = null;

/**
 * Opened from the popup's Import button: whatever file is picked next goes
 * straight into the recordings list. Read before the first render, which
 * rewrites the hash.
 */
const importing = location.hash === '#import';
/** Only as the extension's own page is there a list to add a file to. */
const canSave = !!globalThis.chrome?.runtime?.id;
let opened = null;   // the file as read, for adding to the list

// ---------------------------------------------------------------- rendering

function cardEl(card) {
  const el = document.createElement('span');
  el.className = 'card';
  if (card.isPlaceholder) {
    el.classList.add('hidden');
    el.textContent = 'face down';
    return el;
  }
  if (card.exhausted) el.classList.add('exhausted');
  el.append(card.name || '(unnamed)');
  if (card.cardCode) {
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = card.cardCode;
    el.append(code);
  }
  if (card.whiteCounter) {
    const ctr = document.createElement('span');
    ctr.className = 'ctr';
    ctr.textContent = `+${card.whiteCounter}`;
    el.append(ctr);
  }
  const notes = [
    card.exhausted ? 'exhausted' : null,
    card.attachedToCardId ? 'attached' : null,
    ...(card.keywords ?? []),
  ].filter(Boolean);
  if (notes.length) el.title = notes.join(' - ');
  return el;
}

/**
 * Render a run of cards, collapsing consecutive face-down ones into a single
 * tile. A 21-card hidden deck is one fact, not twenty-one, and drawing it as
 * twenty-one tiles pushes the rest of the board off screen.
 */
function cardsInto(list, cards) {
  let hidden = 0;
  const flush = () => {
    if (!hidden) return;
    const el = document.createElement('span');
    el.className = 'card hidden stack';
    el.textContent = `${hidden} face down`;
    list.append(el);
    hidden = 0;
  };
  for (const card of cards) {
    if (card.isPlaceholder) { hidden++; continue; }
    flush();
    list.append(cardEl(card));
  }
  flush();
}

function zoneEl(label, cards) {
  const wrap = document.createElement('div');
  wrap.className = 'zone';
  if (!cards.length) wrap.classList.add('empty');
  const head = document.createElement('div');
  head.className = 'label';
  const name = document.createElement('span');
  name.textContent = label;
  const count = document.createElement('span');
  count.textContent = String(cards.length);
  head.append(name, count);
  wrap.append(head);
  const list = document.createElement('div');
  list.className = 'cards';
  cardsInto(list, cards);
  wrap.append(list);
  return wrap;
}

function seatEl(player, isViewer, think) {
  const el = document.createElement('div');
  const board = player.board ?? {};
  const head = document.createElement('h2');

  const score = document.createElement('span');
  score.className = 'score';
  score.textContent = String(board.score ?? 0);
  const name = document.createElement('span');
  name.textContent = player.name ?? player.id;
  head.append(score, name);

  if (isViewer) {
    const you = document.createElement('span');
    you.className = 'you';
    you.textContent = 'recording seat';
    head.append(you);
  }

  const stat = document.createElement('span');
  stat.className = 'stat';
  stat.textContent = [
    `energy ${board.floatingEnergy ?? 0}`,
    `power ${board.floatingPower ?? 0}`,
    `xp ${board.legendXp ?? 0}`,
    think != null ? `thought ${fmtDuration(think)}` : null,
  ].filter(Boolean).join(' - ');
  head.append(stat);
  el.append(head);

  const zones = document.createElement('div');
  zones.className = 'zones';
  for (const [key, label] of SEAT_ZONES) zones.append(zoneEl(label, board[key] ?? []));
  el.append(zones);
  return el;
}

function renderBoard(replayState) {
  const { replay } = state;
  const viewerId = replay.viewer.playerId;
  const players = replayState.players;
  // Viewer at the bottom, as in the live client.
  const bottom = players.find((p) => p.id === viewerId) ?? players[0];
  const top = players.find((p) => p !== bottom) ?? players[1];
  const think = Object.fromEntries(replay.players.map((p) => [p.id, p.thinkTimeMs]));

  for (const [el, player] of [[$('#seat-top'), top], [$('#seat-bottom'), bottom]]) {
    el.replaceChildren();
    if (player) el.append(seatEl(player, player.id === viewerId, think[player.id]));
  }

  const field = $('#field');
  field.replaceChildren();
  for (const [key, label] of FIELD_ZONES) {
    const sides = [top, bottom].map((p) => p?.board?.[key] ?? []);
    if (!sides.some((c) => c.length)) continue;
    const bf = document.createElement('div');
    bf.className = 'bf';
    const title = document.createElement('div');
    title.className = 'label';
    title.textContent = label;
    bf.append(title);
    for (const [i, player] of [top, bottom].entries()) {
      if (!player) continue;
      const half = document.createElement('div');
      half.className = 'half';
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = player.name ?? player.id;
      half.append(who);
      const list = document.createElement('div');
      list.className = 'cards';
      cardsInto(list, sides[i]);
      half.append(list);
      bf.append(half);
    }
    field.append(bf);
  }
  if (!field.children.length) {
    const empty = document.createElement('div');
    empty.className = 'bf';
    empty.textContent = 'No units on any battlefield.';
    field.append(empty);
  }
}

function fmtDuration(ms) {
  if (ms == null) return '-';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// ---------------------------------------------------------------- chrome

function renderRail() {
  const rail = $('#rail');
  rail.replaceChildren();
  for (const chapter of state.index.chapters) {
    const b = document.createElement('button');
    b.textContent = chapter.kind === 'phase' ? chapter.label.replace(/_/g, ' ') : chapter.label;
    b.dataset.sequence = String(chapter.sequence);
    b.onclick = () => go(chapter.sequence);
    rail.append(b);
  }
}

function renderEvents() {
  const list = $('#events');
  list.replaceChildren();
  state.index.events.forEach((event, i) => {
    const li = document.createElement('li');
    li.dataset.index = String(i);
    li.dataset.sequence = String(event.sequence);
    const turn = document.createElement('span');
    turn.className = 'turn';
    turn.textContent = event.turnNumber != null ? `T${event.turnNumber}` : '-';
    li.append(turn, event.text ?? '');
    li.onclick = () => go(event.sequence);
    list.append(li);
  });
}

/** The step a mark takes the player to: its own, or the first one after it. */
function markTarget(mark) {
  return state.index.sequences.find((q) => q >= mark.sequence) ?? state.index.last;
}

/**
 * The marks someone made while reviewing this match in replay mode, with
 * their notes. Read-only: this page opens a file it was given and keeps
 * nothing, so there is nowhere for a change to go.
 */
function renderMarks() {
  const list = $('#marks');
  list.replaceChildren();
  const { marks, index } = state;
  $('#marks-tab').textContent = marks.length ? `Marks (${marks.length})` : 'Marks';
  if (!marks.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No marks in this replay. Marks made in replay mode come with it when it is exported.';
    list.append(li);
  }
  for (const mark of marks) {
    const target = markTarget(mark);
    const li = document.createElement('li');
    li.className = 'mark';
    li.dataset.sequence = String(target);
    li.title = 'Go to this step';

    const top = document.createElement('span');
    top.className = 'top';
    const star = document.createElement('span');
    star.className = 'star';
    star.textContent = '★';
    const seq = document.createElement('span');
    seq.className = 'seq';
    seq.textContent = `${mark.sequence}/${index.last}`;
    top.append(star, seq);
    const chapter = index.chapterBySequence.get(target);
    if (chapter) {
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = chapter.kind === 'phase' ? chapter.label.replace(/_/g, ' ') : chapter.label;
      top.append(when);
    }
    if (mark.source === 'live') {
      const live = document.createElement('span');
      live.className = 'live';
      live.textContent = 'live';
      live.title = 'Marked during the match';
      top.append(live);
    }
    li.append(top);

    const event = index.events[currentEventIndex(target)];
    if (event?.text) {
      const ctx = document.createElement('span');
      ctx.className = 'ctx';
      ctx.textContent = event.text;
      li.append(ctx);
    }
    if (mark.text) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = mark.text;
      li.append(note);
    }
    li.onclick = () => go(target);
    list.append(li);
  }

  const span = index.last - index.first + 1;
  const ticks = $('#mark-ticks');
  ticks.replaceChildren();
  for (const mark of marks) {
    const i = document.createElement('i');
    i.style.left = `${(markTarget(mark) - index.first) / span * 100}%`;
    ticks.append(i);
  }
}

/** The next or previous mark from where the player is. */
function stepMark(direction) {
  const seq = state.cursor.sequence;
  const targets = state.marks.map(markTarget);
  const to = direction > 0 ? targets.find((q) => q > seq) : targets.findLast((q) => q < seq);
  if (to != null) go(to);
}

function selectTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const pane of document.querySelectorAll('.pane')) pane.classList.toggle('on', pane.id === name);
}

function renderTrack() {
  const { index } = state;
  const span = index.last - index.first + 1;

  const bands = $('#bands');
  bands.replaceChildren();
  for (const chapter of index.chapters) {
    const width = (chapter.endSequence - chapter.sequence + 1) / span * 100;
    const b = document.createElement('div');
    b.className = `band ${chapter.kind}`;
    b.style.flex = `0 0 ${width}%`;
    b.title = `${chapter.label} - sequences ${chapter.sequence}-${chapter.endSequence}`;
    b.textContent = chapter.kind === 'turn' ? chapter.label.replace('Turn ', 'T') : chapter.label.slice(0, 9);
    b.onclick = (e) => { e.stopPropagation(); go(chapter.sequence); };
    bands.append(b);
  }

  const ticks = $('#ticks');
  ticks.replaceChildren();
  for (const event of index.events) {
    const i = document.createElement('i');
    i.style.left = `${(event.sequence - index.first) / span * 100}%`;
    ticks.append(i);
  }
  for (const gap of index.gaps) {
    const i = document.createElement('i');
    i.className = 'gap';
    i.style.left = `${(gap.to - index.first) / span * 100}%`;
    i.title = `Server resynced here - ${gap.missing} action(s) never captured`;
    ticks.append(i);
  }
}

function renderChain(replayState) {
  const chain = $('#chain');
  chain.replaceChildren();
  const entries = replayState.chainEntries ?? [];
  if (!entries.length) {
    chain.textContent = 'Chain is empty at this point.';
    return;
  }
  for (const entry of entries) {
    const d = document.createElement('div');
    d.className = 'card';
    d.textContent = entry.card?.name ?? entry.id;
    chain.append(d);
  }
}

// ---------------------------------------------------------------- navigation

function go(sequence) {
  state.cursor.sequence = sequence;
  render();
}

/** Index of the latest event at or before `seq`, or -1. */
function currentEventIndex(seq) {
  const events = state.index.events;
  let found = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].sequence <= seq) found = i; else break;
  }
  return found;
}

function render() {
  const { index, timeline, cursor, replay } = state;
  const seq = cursor.sequence;
  const [replayState] = timeline.states.get(seq);

  renderBoard(replayState);
  renderChain(replayState);

  const span = index.last - index.first + 1;
  $('#head').style.left = `${(seq - index.first) / span * 100}%`;

  const chapter = index.chapterBySequence.get(seq);
  for (const b of $('#rail').children) {
    b.classList.toggle('on', Number(b.dataset.sequence) === chapter?.sequence);
  }

  const ei = currentEventIndex(seq);
  const current = ei >= 0 ? index.events[ei] : null;
  for (const li of $('#events').children) li.classList.remove('on');
  if (ei >= 0) {
    const li = $('#events').children[ei];
    li.classList.add('on');
    li.scrollIntoView({ block: 'nearest' });
  }

  for (const li of $('#marks').children) {
    li.classList.toggle('on', li.dataset.sequence === String(seq));
  }

  $('#pos').textContent = `seq ${seq} / ${index.last} - ${chapter?.label ?? ''}`;
  $('#now').textContent = current?.text ?? '';
  location.hash = `seq=${seq}`;

  const gap = index.gaps.find((g) => g.to === seq);
  const fog = $('#fog');
  if (state.truncated && !gap) return;   // the truncation warning outranks the fog note
  fog.hidden = !(replay.viewer.fogOfWar || gap);
  fog.textContent = gap
    ? `Server resynced - ${gap.missing} action not captured`
    : fogText(replay);
}

function fogText(replay) {
  const seat = replay.players.find((p) => p.id === replay.viewer.playerId);
  return `Recorded from ${seat?.name ?? 'one seat'} - hidden zones were masked`;
}

/**
 * Playback pacing, matching replay mode.
 *
 * One player action often lands as several narrated events - exhausting four
 * runes is four of them - so a flat beat per event reads badly. A step that
 * repeats the previous event's action type flicks past; anything new gets the
 * full beat.
 */
const BASE_MS = 1000;
const RUN_MS = 180;

function delayForEvent(index) {
  const events = state.index.events;
  const here = events[index];
  const previous = index > 0 ? events[index - 1] : null;
  if (!here) return BASE_MS;
  const continuesRun = !!previous && !!here.actionType && here.actionType === previous.actionType;
  return continuesRun ? RUN_MS : BASE_MS;
}

function setPlaying(on) {
  if (playing) { clearTimeout(playing); playing = null; }
  $('#b-play').textContent = on ? 'II' : '>';
  if (!on) return;
  const step = () => {
    const before = state.cursor.sequence;
    const after = state.cursor.stepEvent(1);
    render();
    if (after === before) { setPlaying(false); return; }
    const next = currentEventIndex(state.cursor.sequence) + 1;
    playing = setTimeout(step, delayForEvent(next));
  };
  playing = setTimeout(step, delayForEvent(currentEventIndex(state.cursor.sequence) + 1));
}

// ---------------------------------------------------------------- loading

function load(replay) {
  const timeline = timelineFromReplay(replay);
  const index = buildIndex(timeline);
  state = { replay, timeline, index, cursor: new Cursor(index), marks: cleanMarks(replay.marks) };

  $('#room').textContent = replay.match.roomCode ?? 'Replay';
  const winner = replay.players.find((p) => p.id === replay.match.outcome?.winnerPlayerId);
  $('#meta').textContent = [
    replay.match.playMode, replay.match.matchFormat,
    `${index.events.length} moves`,
    `${index.chapters.filter((c) => c.kind === 'turn').length} turns`,
    winner ? `${winner.name} won by ${replay.match.outcome.reason}` : null,
  ].filter(Boolean).join('  -  ');

  const hint = $('#hint');
  if (hint) hint.hidden = true;
  // A replay can hold more commits than it can walk: one hole in the chain
  // makes everything after it unreachable. Say so rather than presenting a
  // truncated match as a short one.
  const applied = index.sequences.length - 1;
  const recorded = replay.coverage?.recordedCommits ?? replay.commits.length;
  if (recorded > applied) {
    const lost = replay.gaps?.reduce((n, g) => n + (g.missingCommits ?? 0), 0) ?? 0;
    const warn = $('#fog');
    warn.hidden = false;
    warn.textContent = `Incomplete — plays ${applied} of ${recorded} recorded actions`
      + (lost ? `; ${lost} were never captured` : '');
    warn.title = 'A break in the recording makes everything after it unreplayable.';
    state.truncated = true;
  }

  renderRail();
  renderEvents();
  renderTrack();
  renderMarks();
  // A replay sent with marks was sent to be looked at through them.
  selectTab(state.marks.length ? 'marks' : 'events');

  const fromHash = Number(new URLSearchParams(location.hash.slice(1)).get('seq'));
  state.cursor.sequence = Number.isFinite(fromHash) && index.sequences.includes(fromHash)
    ? fromHash : index.first;
  render();

  const chat = $('#chat');
  chat.replaceChildren();
  if (!replay.chat?.length) chat.textContent = 'No chat in this match.';
  for (const entry of replay.chat ?? []) {
    const d = document.createElement('div');
    d.textContent = `${entry.author ?? entry.authorPlayerId}: ${entry.text}`;
    chat.append(d);
  }
}

/** Accept either a .ratlas.json replay or a raw DevTools .har capture. */
async function openFile(file) {
  $('#meta').textContent = `reading ${file.name}…`;
  const text = await file.text();
  try {
    const parsed = JSON.parse(text);
    const replay = looksLikeHar(text) ? harToReplay(parsed) : parsed;
    // Kept as read: showing it builds a timeline, and the list gets the file.
    opened = structuredClone(replay);
    load(replay);
  } catch (err) {
    $('#room').textContent = 'Could not open';
    $('#meta').textContent = err.message;
    opened = null;
  }
  showSave();
  if (opened && importing) saveToRecordings();
}

function showSave(status, kind) {
  const save = $('#save');
  save.hidden = !canSave || !opened;
  save.disabled = false;
  save.textContent = 'Add to my recordings';
  const saved = $('#saved');
  saved.hidden = !status;
  saved.textContent = status ?? '';
  saved.className = kind ?? '';
}

/**
 * Put the open file in the extension's list, where it can be watched in
 * RiftAtlas' board and marked up like a match recorded here.
 */
async function saveToRecordings() {
  if (!opened || !canSave) return;
  const save = $('#save');
  save.disabled = true;
  save.textContent = 'Adding…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'importReplay', replay: opened });
    if (!res?.ok) { showSave(res?.error ?? 'Could not add it.', 'bad'); return; }
    showSave(`${res.replaced ? 'Updated' : 'Added'} ${res.room}`
      + (res.marks ? ` with ${res.marks} mark${res.marks === 1 ? '' : 's'}` : '')
      + ' — find it in the extension popup.', 'ok');
    $('#save').hidden = true;
  } catch (err) {
    showSave(`Could not add it: ${err.message}`, 'bad');
  }
}

$('#save').onclick = () => saveToRecordings();
if (importing && canSave) {
  const hint = $('#hint');
  if (hint) {
    hint.textContent = 'Pick a .ratlas.json replay with “Open replay or HAR”, or drop one here. '
      + 'It is added to your recordings as soon as it opens, ready to watch in RiftAtlas’ board.';
  }
  document.title = 'Import a replay — RiftAtlas Replay';
}

$('#file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) openFile(file);
});

// Dropping a capture anywhere on the page opens it.
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
addEventListener('dragleave', () => document.body.classList.remove('dropping'));
addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  const file = e.dataTransfer?.files?.[0];
  if (file) openFile(file);
});

$('#track').addEventListener('click', (e) => {
  if (!state) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  const { index } = state;
  const want = Math.round(index.first + ratio * (index.last - index.first));
  const nearest = index.sequences.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
  go(nearest);
});

for (const [id, fn] of [
  ['b-start', (c) => c.toStart()], ['b-end', (c) => c.toEnd()],
  ['b-prev', (c) => c.stepSequence(-1)], ['b-next', (c) => c.stepSequence(1)],
  ['b-event-prev', (c) => c.stepEvent(-1)], ['b-event-next', (c) => c.stepEvent(1)],
  ['b-chapter-prev', (c) => c.stepChapter(-1)], ['b-chapter-next', (c) => c.stepChapter(1)],
]) {
  $(`#${id}`).onclick = () => { if (state) { fn(state.cursor); render(); } };
}
$('#b-play').onclick = () => setPlaying(!playing);

for (const b of document.querySelectorAll('.tabs button')) {
  b.onclick = () => selectTab(b.dataset.tab);
}

// Arrows are the primary control and must not be swallowed by a focused panel.
addEventListener('keydown', (e) => {
  if (!state || e.metaKey || e.ctrlKey || e.altKey) return;
  const c = state.cursor;
  const keys = {
    ArrowRight: () => c.stepSequence(1), ArrowLeft: () => c.stepSequence(-1),
    ArrowDown: () => c.stepEvent(1), ArrowUp: () => c.stepEvent(-1),
    ']': () => c.stepChapter(1), '[': () => c.stepChapter(-1),
    Home: () => c.toStart(), End: () => c.toEnd(),
  };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); render(); return; }
  if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); return; }
  if (e.key === ',' || e.key === '.') { e.preventDefault(); stepMark(e.key === '.' ? 1 : -1); return; }
  if (/^[1-9]$/.test(e.key)) {
    const chapter = state.index.chapters.find((ch) => ch.turnNumber === Number(e.key));
    if (chapter) { e.preventDefault(); go(chapter.sequence); }
  }
});

// A pasted #seq= link must navigate an already-open player, not just a fresh load.
addEventListener('hashchange', () => {
  if (!state) return;
  const want = Number(new URLSearchParams(location.hash.slice(1)).get('seq'));
  if (Number.isFinite(want) && want !== state.cursor.sequence
      && state.index.sequences.includes(want)) go(want);
});

// There is deliberately no way to load a replay from a URL. A file arrives
// through the picker or a drop, which keeps the extension free of any outbound
// request at all - a simpler thing to state, and to verify, than a fetch that
// happens to be same-origin.
