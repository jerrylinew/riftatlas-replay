const list = document.getElementById('list');
const search = document.getElementById('search');
const count = document.getElementById('count');
const send = (msg) => chrome.runtime.sendMessage(msg);

/** Everything the list last received, so filtering never needs a round trip. */
let allRows = [];

document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;

// The overlay reads this itself and follows changes live, so switching it on
// mid-match takes effect without a reload.
const overlayToggle = document.getElementById('overlay-toggle');
chrome.storage.local.get('overlayEnabled')
  .then((s) => { overlayToggle.checked = s.overlayEnabled === true; })
  .catch(() => {});
overlayToggle.onchange = () => {
  chrome.storage.local.set({ overlayEnabled: overlayToggle.checked }).catch(() => {});
};

document.getElementById('open-player').onclick = () => send({ type: 'openPlayer' });
document.getElementById('library').onclick = () => send({ type: 'openLibrary' });
document.getElementById('import').onclick = () => send({ type: 'openPlayer', import: true });

document.getElementById('unstick').onclick = async (e) => {
  const button = e.currentTarget;
  const was = button.textContent;
  button.textContent = 'Clearing…';
  const res = await send({ type: 'clearRoomState' });
  button.textContent = res?.ok ? 'Done' : (res?.error ?? 'failed');
  setTimeout(() => { button.textContent = was; }, 2500);
};

document.getElementById('dump').onclick = async (e) => {
  const button = e.currentTarget;
  const was = button.textContent;
  button.textContent = 'Dumping…';
  const res = await send({ type: 'dump' });
  button.textContent = res?.ok ? 'Saved' : (res?.error ?? 'failed');
  setTimeout(() => { button.textContent = was; }, 2500);
};

/**
 * How the match ended, in words. 'series' is the odd one: a best-of-three game
 * can be settled by both players naming the winner when the next game starts,
 * which is a result the game's own log never mentions.
 */
const HOW_IT_ENDED = {
  victory: 'victory',
  concession: 'concession',
  score: 'on score',
  series: 'agreed between games',
};

function when(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function tag(text, cls) {
  const el = document.createElement('span');
  el.className = `tag ${cls}`;
  el.textContent = text;
  return el;
}

/** One side of a scoreline: the player, with their legend beneath. */
function seatEl(player, side, won) {
  const el = document.createElement('div');
  el.className = `seat ${side}${won ? ' winner' : ''}`;
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = player.name ?? player.id;
  name.title = name.textContent;
  el.append(name);
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.textContent = player.legend?.name ?? '';
  legend.title = legend.textContent;
  el.append(legend);
  return el;
}

/**
 * The score between them, left untinted on purpose.
 *
 * The winner is not always the higher score: a concession can end a match at
 * 5-8 in the loser's favour on points, and highlighting the winning half made
 * the smaller number look like the bigger one. The result is carried by the
 * card's edge and the winner's name; the score is just the score.
 */
function scoreEl(left, right) {
  const el = document.createElement('div');
  el.className = 'tally';
  const a = document.createElement('span');
  a.textContent = left?.finalScore ?? '–';
  const dash = document.createElement('span');
  dash.className = 'dash';
  dash.textContent = '–';
  const b = document.createElement('span');
  b.textContent = right?.finalScore ?? '–';
  el.append(a, dash, b);
  return el;
}

/** A small secondary action. */
function small(label, title, onclick, cls = '') {
  const b = document.createElement('button');
  b.className = `small ${cls}`.trim();
  b.textContent = label;
  b.title = title;
  b.onclick = onclick;
  return b;
}

/**
 * The words a recording can be found by: room code, both players, both legends,
 * the format, and the date written a few ways so "sep", "16" and "2026" all
 * work.
 */
function haystack(row) {
  const started = row.startedAt ? new Date(row.startedAt) : null;
  return [
    row.room ?? row.roomCode,
    row.match?.matchFormat,
    ...(row.players ?? []).flatMap((p) => [p.name, p.legend?.name, p.legend?.cardCode]),
    started && when(row.startedAt),
    started && started.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    started && started.toISOString().slice(0, 10),
    row.markText,   // notes written on its marks
  ].filter(Boolean).join(' ').toLowerCase();
}

/** Every term must match, so "zed berto" narrows rather than widens. */
function matches(row, query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = haystack(row);
  return terms.every((t) => hay.includes(t));
}

async function refresh() {
  allRows = (await send({ type: 'list' })) ?? [];
  render();
}

function render() {
  const query = search.value;
  const rows = allRows.filter((r) => matches(r, query));

  search.hidden = allRows.length < 6;   // pointless chrome on a short list
  count.hidden = !query;
  count.textContent = `${rows.length} of ${allRows.length} recordings`;

  list.replaceChildren();
  if (!allRows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No recordings yet. Open a RiftAtlas match to start one.';
    list.append(li);
    return;
  }
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = `Nothing matches “${query.trim()}”.`;
    list.append(li);
    return;
  }

  for (const row of rows) {
    const id = row.roomCode;                       // recording id, for actions
    const code = row.room ?? row.roomCode;         // room code, for people
    const li = document.createElement('li');

    // Row 1: which match, and the thing most visits are for.
    const top = document.createElement('div');
    top.className = 'top';

    const head = document.createElement('div');
    head.className = 'head';
    const room = document.createElement('span');
    room.className = 'room';
    room.textContent = code;
    head.append(room, small('Copy', 'Copy the room code', async (e) => {
      const b = e.currentTarget;
      try { await navigator.clipboard.writeText(code); b.textContent = 'Copied'; }
      catch { b.textContent = 'failed'; }
      setTimeout(() => { b.textContent = 'Copy'; }, 1200);
    }));
    if (!row.finished) head.append(tag('recording', 'live'));
    if (row.imported) {
      const t = tag('imported', 'imported');
      t.title = 'Added from a .ratlas.json file rather than recorded here, so it cannot be rebuilt.';
      head.append(t);
    }
    if (row.markCount) {
      const t = tag(`★ ${row.markCount}`, 'marks');
      t.title = `${row.markCount} marked step${row.markCount === 1 ? '' : 's'}. `
        + 'Open them from the replay bar; Export includes them.';
      head.append(t);
    }
    if (row.partial) head.append(tag('partial', 'partial'));
    if (row.stale) {
      const t = tag(`rebuild — ${row.builtCommits}/${row.recordedCommits}`, 'partial');
      t.title = `The replay covers ${row.builtCommits} of ${row.recordedCommits} recorded actions. `
        + 'Press Rebuild to bring it up to date.';
      head.append(t);
    }
    top.append(head);

    const watch = document.createElement('button');
    watch.className = 'watch';
    watch.textContent = 'Watch replay';
    watch.title = 'Play this match back in RiftAtlas\u2019 own board, with card art '
      + 'and their match log.';
    top.append(watch);

    // Row 2: the scoreline. You on the left, opponent on the right, score
    // between them, with each legend under its player.
    const seats = [...(row.players ?? [])];
    const mine = seats.findIndex((p) => p.id === row.viewerPlayerId);
    if (mine > 0) seats.unshift(seats.splice(mine, 1)[0]);
    const [left, right] = seats;
    const winner = row.match?.outcome?.winnerPlayerId ?? null;

    const score = document.createElement('div');
    score.className = 'score';
    if (left) {
      const won = winner && left.id === winner;
      if (winner) li.classList.add(won ? 'won' : 'lost');
      score.append(
        seatEl(left, 'left', won),
        scoreEl(left, right),
        right ? seatEl(right, 'right', winner && right.id === winner) : document.createElement('div'),
      );
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [when(row.startedAt), row.match?.matchFormat,
      HOW_IT_ENDED[row.match?.outcome?.reason] ?? row.match?.outcome?.reason]
      .filter(Boolean).join('  ·  ');


    watch.onclick = async () => {
      watch.textContent = 'Opening…';
      const res = await send({ type: 'replayMode', roomCode: id });
      watch.textContent = 'Watch replay';
      if (!res?.ok) meta.textContent = res?.error ?? 'could not start the replay';
    };

    // Row 3: the rest.
    const actions = document.createElement('div');
    actions.className = 'actions';
    const rebuild = small('Rebuild', 'Re-assemble the replay from what was recorded. Not normally '
      + 'needed — recording is continuous, and Export rebuilds anyway.', async (e) => {
      e.currentTarget.textContent = 'Rebuilding…';
      await send({ type: 'finalise', roomCode: id });
      refresh();
    });
    actions.append(
      small('Export', 'Save this match as a .ratlas.json file. Rebuilds first, '
        + 'so an export is always up to date.', async (e) => {
        const b = e.currentTarget;
        b.textContent = 'Exporting…';
        const res = await send({ type: 'export', roomCode: id });
        b.textContent = res?.ok ? 'Saved' : 'failed';
        if (!res?.ok) meta.textContent = res?.error ?? 'export failed';
        setTimeout(() => { b.textContent = 'Export'; }, 1800);
      }),
      // An imported replay has no recording behind it to rebuild from.
      ...(row.imported ? [] : [rebuild]),
      small('Delete', 'Delete this recording', () => askDelete(li, code, id), 'danger'),
    );

    li.append(top);
    if (left) li.append(score);
    li.append(meta);
    const trouble = row.unanchored
      ? `Only the final position was captured — the ${row.unanchored.commits} actions `
        + 'recorded here all came before it, and cannot be replayed'
      : row.buildError
      ? `Could not build: ${row.buildError}`
      : row.stoppedEarly
        ? `Plays ${row.stoppedEarly.sequence ? `up to action ${row.stoppedEarly.sequence}` : 'partially'}`
          + ` — ${row.stoppedEarly.reason}`
        : null;
    if (trouble) {
      const problem = document.createElement('div');
      problem.className = 'problem';
      problem.textContent = row.unanchored
        ? `${trouble}. This happens when recording starts partway through a match. `
          + 'Rebuilding will not change it.'
        : row.needsNewVersion
        ? `${trouble}. RiftAtlas has added something this version does not know yet — `
          + 'send a Debug dump. Your recording is safe, and the replay will rebuild '
          + 'itself once that is fixed.'
        : `${trouble}. Your recording is safe; press Rebuild to try again.`;
      li.append(problem);
    }
    li.append(actions);
    list.append(li);
  }
}

/**
 * Deleting a recording destroys it, so it asks first — inline rather than with
 * confirm(), which can dismiss the whole popup on some platforms.
 */
function askDelete(li, code, id) {
  if (li.querySelector('.confirm')) return;
  const bar = document.createElement('div');
  bar.className = 'confirm';
  const text = document.createElement('span');
  text.textContent = `Delete the ${code} recording? This cannot be undone.`;
  const yes = document.createElement('button');
  yes.className = 'danger-solid';
  yes.textContent = 'Delete';
  yes.onclick = async () => { await send({ type: 'delete', roomCode: id }); refresh(); };
  const no = document.createElement('button');
  no.textContent = 'Cancel';
  no.onclick = () => bar.remove();
  bar.append(text, yes, no);
  li.append(bar);
  no.focus();
}

search.addEventListener('input', render);
search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; render(); }
});

refresh();
