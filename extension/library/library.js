/**
 * The library: every game recorded or imported, grouped by best-of-three, and
 * for the one picked - how it ended, the mulligans, the sideboarding, and the
 * marks and notes, which can be edited here too.
 *
 * Everything comes from the service worker, which reads it from the
 * recordings; nothing here keeps a copy. The mulligan and sideboard reading is
 * shared/game-summary.js. Marks are drawn by the same panel replay mode uses.
 */
const send = (msg) => chrome.runtime.sendMessage(msg);
const $ = (sel) => document.querySelector(sel);

/** How it was settled, after "Won" or "Lost". A win on the board needs no words. */
const HOW = {
  victory: '',
  concession: 'by concession',
  score: 'on score',
  series: '· agreed between games',
};

let rows = [];          // the list, as the popup gets it
let selected = null;    // recording id
let summary = null;     // the selected game's summary
let panel = null;       // the marks panel, made once
let asked = 0;          // so a slow answer for a game no longer selected is dropped

// ---------------------------------------------------------------- helpers

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function when(ms, withTime = true) {
  if (!ms) return '';
  const d = new Date(ms);
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return withTime ? `${day} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : day;
}

function minutes(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** You and them, from a list row or a summary. */
function sides(players, viewerId) {
  const list = players ?? [];
  const you = list.find((p) => p.id === viewerId) ?? list[0] ?? null;
  const them = list.find((p) => p !== you) ?? null;
  return { you, them };
}

function resultOf(winnerId, viewerId) {
  if (!winnerId || !viewerId) return null;
  return winnerId === viewerId ? 'won' : 'lost';
}

function haystack(row) {
  return [
    row.room, row.match?.matchFormat, row.markText,
    ...(row.players ?? []).flatMap((p) => [p.name, p.legend?.name]),
    when(row.startedAt),
  ].filter(Boolean).join(' ').toLowerCase();
}

// ---------------------------------------------------------------- the list

function groups(list) {
  const bySeries = new Map();
  const out = [];
  for (const row of list) {
    const id = row.series?.id;
    if (!id) { out.push({ rows: [row], newest: row.startedAt ?? 0 }); continue; }
    if (!bySeries.has(id)) {
      const group = { series: id, rows: [], newest: 0 };
      bySeries.set(id, group);
      out.push(group);
    }
    bySeries.get(id).rows.push(row);
  }
  for (const g of out) {
    g.rows.sort((a, b) => (a.series?.game ?? 0) - (b.series?.game ?? 0) || a.startedAt - b.startedAt);
    g.newest = Math.max(...g.rows.map((r) => r.startedAt ?? 0));
  }
  return out.sort((a, b) => b.newest - a.newest);
}

function visibleRows() {
  const terms = $('#search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => r.hasReplay && terms.every((t) => haystack(r).includes(t)));
}

function renderList() {
  const nav = $('#games');
  nav.replaceChildren();
  const shown = visibleRows();
  const playable = rows.filter((r) => r.hasReplay);
  $('#totals').textContent = playable.length
    ? `${playable.length} game${playable.length === 1 ? '' : 's'}`
      + (shown.length !== playable.length ? ` · ${shown.length} shown` : '')
    : '';

  if (!playable.length) {
    nav.append(el('p', 'empty', 'No games yet. Play a match on RiftAtlas with the extension on, '
      + 'or use Import in the popup to add a replay file.'));
    return;
  }
  if (!shown.length) {
    nav.append(el('p', 'empty', `Nothing matches “${$('#search').value.trim()}”.`));
    return;
  }

  for (const group of groups(shown)) {
    const box = el('div', 'group');
    if (group.series) {
      const first = group.rows[0];
      const { them } = sides(first.players, first.viewerPlayerId);
      const won = group.rows.filter((r) => resultOf(r.match?.outcome?.winnerPlayerId, r.viewerPlayerId) === 'won').length;
      const lost = group.rows.filter((r) => resultOf(r.match?.outcome?.winnerPlayerId, r.viewerPlayerId) === 'lost').length;
      const h = el('h3', null, `Best of three${them ? ` vs ${them.name}` : ''}`);
      h.append(el('span', 'tally', `${won}–${lost}`));
      h.title = when(first.startedAt, false);
      box.append(h);
    }
    for (const row of group.rows) box.append(gameButton(row, !!group.series));
    nav.append(box);
  }
}

function gameButton(row, inSeries) {
  const { you, them } = sides(row.players, row.viewerPlayerId);
  const result = resultOf(row.match?.outcome?.winnerPlayerId, row.viewerPlayerId);
  const b = el('button', `game${result ? ` ${result}` : ''}${row.roomCode === selected ? ' on' : ''}`);
  b.type = 'button';
  b.dataset.id = row.roomCode;
  b.append(
    el('span', 'which', inSeries && row.series?.game ? `G${row.series.game}` : row.room),
    el('span', 'vs', them ? `vs ${them.name}${them.legend?.name ? ` · ${them.legend.name}` : ''}` : ''),
    el('span', 'score', you && them && you.finalScore != null
      ? `${you.finalScore}–${them.finalScore ?? '?'}` : ''),
  );
  const sub = el('span', 'sub');
  sub.append(el('span', null, inSeries ? `${row.room} · ${when(row.startedAt)}` : when(row.startedAt)));
  if (you?.legend?.name) sub.append(el('span', null, you.legend.name));
  if (row.markCount) sub.append(el('span', 'marks', `★ ${row.markCount}`));
  b.append(sub);
  b.title = result === 'won' ? 'Won' : result === 'lost' ? 'Lost' : 'No result recorded';
  b.onclick = () => select(row.roomCode);
  return b;
}

// ---------------------------------------------------------------- one game

async function select(id) {
  selected = id;
  history.replaceState(null, '', `#game=${encodeURIComponent(id)}`);
  for (const b of document.querySelectorAll('.game')) b.classList.toggle('on', b.dataset.id === id);
  document.querySelector('.game.on')?.scrollIntoView({ block: 'nearest' });
  const ticket = ++asked;
  const res = await send({ type: 'summary', recordingId: id });
  if (ticket !== asked) return;   // another game was picked meanwhile
  if (!res?.ok) {
    summary = null;
    $('#detail').replaceChildren(el('p', 'empty', res?.error ?? 'Could not read this game.'));
    return;
  }
  const same = summary?.recordingId === id;
  summary = res.summary;
  renderDetail(same);
}

function renderDetail(keepScroll) {
  const detail = $('#detail');
  const scroll = keepScroll ? detail.scrollTop : 0;
  const row = rows.find((r) => r.roomCode === selected);
  const s = summary;
  const { you, them } = sides(s.players, s.viewerId);
  const result = resultOf(s.winnerPlayerId, s.viewerId);

  const head = el('div', 'head');
  head.append(el('h1', null, s.room ?? 'Game'));
  const facts = [
    s.series?.game ? `Best of three, game ${s.series.game}` : s.matchFormat,
    when(s.startedAt),
    minutes(s.durationMs),
    s.turns ? `${s.turns} turns` : null,
  ].filter(Boolean).join(' · ');
  head.append(el('span', 'facts', facts));
  if (row?.imported) head.append(el('span', 'tag', 'imported'));
  if (s.partial) {
    const t = el('span', 'tag warn', 'joined partway');
    t.title = 'Recording started after the match had begun, so the start is missing.';
    head.append(t);
  }

  const line = el('div', 'scoreline');
  line.append(seat(you, 'left', s), centre(you, them, result, s), seat(them, 'right', s));

  const actions = el('div', 'actions');
  const status = el('span', 'status');
  const watch = el('button', 'primary', 'Watch replay');
  watch.title = 'Play it in RiftAtlas’ own board. Needs a play.riftatlas.com tab open.';
  watch.onclick = () => watchFrom(null);
  const exp = el('button', null, 'Export');
  exp.title = 'Save it as a .ratlas.json, with its marks and notes';
  exp.onclick = async () => {
    status.className = 'status';
    status.textContent = 'Exporting…';
    const res = await send({ type: 'export', roomCode: selected });
    status.textContent = res?.ok ? 'Saved.' : (res?.error ?? 'Export failed.');
    if (!res?.ok) status.className = 'status bad';
  };
  actions.append(watch, exp, status);

  detail.replaceChildren(head, line, actions, mulliganPart(s, you, them), sideboardPart(s), marksPart(s));
  detail.scrollTop = scroll;
}

function seat(player, side, s) {
  const box = el('div', `seat ${side}`);
  if (!player) return box;
  const name = el('div', 'name', player.name);
  if (player.isViewer) name.append(el('span', 'you', 'you'));
  if (player.id === s.winnerPlayerId) name.append(el('span', 'won', '✓ won'));
  box.append(name, el('div', 'legend', player.legend?.name ?? ''));
  if (player.battlefield) {
    const bf = el('div', 'battlefield');
    bf.append(el('span', 'label', 'Battlefield'), ` ${player.battlefield.name}`);
    if (player.battlefield.cardCode) bf.title = player.battlefield.cardCode;
    box.append(bf);
  }
  return box;
}

function centre(you, them, result, s) {
  const box = el('div');
  const big = el('div', 'big');
  big.append(String(you?.finalScore ?? '–'), el('span', 'dash', '—'), String(them?.finalScore ?? '–'));
  const res = el('div', `result${result ? ` ${result}` : ''}`);
  if (result) res.append(el('strong', null, result === 'won' ? 'Won' : 'Lost'), ` ${HOW[s.reason] ?? ''}`);
  else res.textContent = 'No result recorded';
  const first = s.players.find((p) => p.id === s.firstPlayerId);
  if (first) res.append(el('div', null, first.isViewer ? 'You went first' : `${first.name} went first`));
  box.append(big, res);
  return box;
}

function part(title) {
  const section = el('section', 'part');
  section.append(el('h2', null, title));
  return section;
}

function chips(cards, cls = '') {
  const box = el('span', 'cards');
  for (const c of cards) {
    const chip = el('span', `chip ${cls}`.trim());
    if (c.count > 1) chip.append(el('span', 'n', `${c.count}×`));
    chip.append(c.name);
    if (c.cardCode) chip.title = c.cardCode;
    box.append(chip);
  }
  return box;
}

function row(label, ...content) {
  const r = el('div', 'row');
  r.append(el('span', 'label', label));
  const body = el('span');
  body.append(...content);
  r.append(body);
  return r;
}

function mulliganPart(s, you, them) {
  const section = part('Mulligan');
  const lines = el('div', 'rows');
  const mine = s.myMulligan;
  const count = (p) => s.mulligans.find((m) => m.playerId === p?.id);
  if (mine) {
    lines.append(row('Your opening hand', openingChips(mine)));
    if (mine.sentBack.length) {
      lines.append(row('Sent back', chips(mine.sentBack, 'out')));
      lines.append(row('Drew', chips(mine.drew, 'in')));
    } else {
      lines.append(row('', el('span', 'muted', 'Kept all of it.')));
    }
    if (mine.startDraw?.length) {
      // Not part of the mulligan: the card drawn as the game began.
      lines.append(row('Drew to start', chips(mine.startDraw)));
    }
  } else if (count(you)) {
    lines.append(row('You', el('span', null, describeCount(count(you)))));
  }
  if (them) {
    const theirs = count(them);
    lines.append(row(them.name, el('span', null, theirs ? describeCount(theirs) : 'Not recorded'),
      el('span', 'muted', theirs ? ' — their cards were hidden from you' : '')));
  }
  if (!lines.childNodes.length) lines.append(el('p', 'muted', 'The mulligan was not recorded.'));
  section.append(lines);
  return section;
}

/** Your opening four, with the ones you sent back struck through. */
function openingChips(mine) {
  const box = el('span', 'cards');
  const back = [...mine.sentBack];
  for (const c of mine.opening) {
    const i = back.findIndex((b) => b.name === c.name);
    const sent = i >= 0;
    if (sent) back.splice(i, 1);
    const chip = el('span', sent ? 'chip back' : 'chip', c.name);
    chip.title = sent ? `${c.name} — sent back` : c.name;
    box.append(chip);
  }
  return box;
}

function describeCount(m) {
  return m.recycled ? `Sent back ${m.recycled}, drew ${m.redrawn}` : 'Kept their hand';
}

/**
 * Two comparisons, because they answer different questions. Against the
 * registered deck: where the deck stands overall. Against the previous game:
 * what was decided between these two games, which is usually the one being
 * reviewed. Game one, or a recording that began after sideboarding, has only
 * the first.
 */
function sideboardPart(s) {
  const section = part('Sideboard');
  const sb = s.sideboard;
  if (!sb) {
    section.append(el('p', 'muted', 'This recording has no decklist to compare.'));
    return section;
  }
  const changed = (c) => c && (c.in.length || c.out.length);
  const same = (a, b) => JSON.stringify([a.in, a.out]) === JSON.stringify([b.in, b.out]);
  const block = (title, c, none) => {
    const lines = el('div', 'rows');
    lines.append(el('h3', null, title));
    if (!changed(c)) lines.append(row('', el('span', 'muted', none)));
    if (c.in.length) lines.append(row('Brought in', chips(c.in, 'in')));
    if (c.out.length) lines.append(row('Took out', chips(c.out, 'out')));
    return lines;
  };
  const game = s.series?.game;
  if (sb.sincePrevious && !same(sb.sincePrevious, sb)) {
    section.append(block(`Since game ${game - 1}`, sb.sincePrevious, `Same deck as game ${game - 1}.`));
    section.append(block('Against your registered deck', sb, 'Back to your registered deck.'));
  } else if (sb.sincePrevious) {
    // Game one was played with the registered deck, so the two comparisons agree.
    section.append(block(`Since game ${game - 1} (your registered deck)`, sb, `Same deck as game ${game - 1}.`));
  } else {
    section.append(block('Against your registered deck', sb, 'Played your registered deck, unchanged.'));
  }
  return section;
}

function marksPart(s) {
  const section = part(s.marks.length ? `Marks and notes · ${s.marks.length}` : 'Marks and notes');
  if (!panel) {
    panel = globalThis.riftatlasMarksPanel.create({
      wide: true, addButton: false, keysHint: false, closeButton: false, title: '',
      jumpTitle: 'Watch from this step',
      emptyText: 'No marks in this game. Watch it, and press M at a step to mark it or N to write a note.',
      onJump: (sequence) => watchFrom(sequence),
      onSave: (sequence, text) => changeMark({ type: 'saveMark', recordingId: selected, sequence, text }),
      onDelete: (sequence) => changeMark({ type: 'deleteMark', recordingId: selected, sequence }),
    });
  }
  panel.update({
    marks: s.marks,
    current: null,
    last: s.last,
    labels: Object.fromEntries(s.marks.map((m) => [m.sequence, { turn: m.turn, phase: m.phase, text: m.context }])),
  });
  section.append(panel.element);
  section.append(el('p', 'muted', 'Click a mark to watch from it. Click a note, or the pencil, to edit it.'));
  return section;
}

async function changeMark(message) {
  const res = await send(message);
  if (!res?.ok) { say(res?.error ?? 'Could not save.', true); return; }
  await refresh();
}

/**
 * The line beside Watch and Export. Looked up each time rather than kept: the
 * game's details are redrawn after every change, and the marks panel, made
 * once, would otherwise be talking to a line no longer on the page.
 */
function say(text, bad = false) {
  const status = document.querySelector('#detail .actions .status');
  if (!status) return;
  status.className = bad ? 'status bad' : 'status';
  status.textContent = text;
}

async function watchFrom(sequence) {
  say('Opening in RiftAtlas…');
  const res = await send({ type: 'replayMode', roomCode: selected, startSequence: sequence ?? undefined });
  if (res?.ok) {
    say(sequence != null ? `Opened at step ${sequence} in your RiftAtlas tab.` : 'Opened in your RiftAtlas tab.');
  } else {
    say(res?.error === 'open play.riftatlas.com first'
      ? 'Open play.riftatlas.com in a tab first, then try again.'
      : (res?.error ?? 'Could not open the replay.'), true);
  }
}

// ---------------------------------------------------------------- wiring

async function refresh() {
  rows = (await send({ type: 'list' })) ?? [];
  renderList();
  const wanted = selected ?? decodeURIComponent(new URLSearchParams(location.hash.slice(1)).get('game') ?? '');
  const pick = rows.find((r) => r.roomCode === wanted && r.hasReplay)
    ?? (selected ? null : visibleRows()[0] ?? null);
  if (pick) await select(pick.roomCode);
  else if (selected) {
    selected = null;
    summary = null;
    $('#detail').replaceChildren(el('p', 'empty', 'That game is no longer here.'));
  }
}

$('#export-all').onclick = async () => {
  const button = $('#export-all');
  const status = $('#export-status');
  button.disabled = true;
  status.className = '';
  status.textContent = 'Zipping every game…';
  const res = await send({ type: 'exportAll' });
  button.disabled = false;
  if (res?.ok) {
    status.textContent = `Saved ${res.count} game${res.count === 1 ? '' : 's'}`
      + (res.skipped ? ` — ${res.skipped} could not be built and were left out` : '') + '.';
  } else if (/cancel/i.test(res?.error ?? '')) {
    status.textContent = '';
  } else {
    status.className = 'bad';
    status.textContent = res?.error ?? 'Export failed.';
  }
};

$('#search').addEventListener('input', renderList);
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#search').value) { $('#search').value = ''; renderList(); }
});

// Up and down move through the list, unless someone is typing.
addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.closest?.('#detail')) return;
  const buttons = [...document.querySelectorAll('.game')];
  if (!buttons.length) return;
  const at = buttons.findIndex((b) => b.dataset.id === selected);
  const next = buttons[Math.min(buttons.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
  e.preventDefault();
  select(next.dataset.id);
});

// Marks made in a replay while this page sat in another tab show up on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

refresh();
