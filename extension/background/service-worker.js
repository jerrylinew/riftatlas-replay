/**
 * Service worker: routes observed frames into the recorder and serves the popup.
 *
 * Holds no match state. MV3 will terminate this worker repeatedly during a
 * match; everything it learns is already in IndexedDB by the time the message
 * handler returns, so a restart is invisible.
 */
import { onFrame, looksFinished, everyoneLeft, endsWithSocket } from './recorder.js';
import { buildReplay } from './finalise.js';
import { SESSIONS, COMMITS, EXTRAS, REPLAYS, all, get, put, del, dropRecording, commitsFor, extrasFor, roomOf, isEmptyRecording, activeRecordingFor } from './store.js';
import { extractReveals, revealsFromReplay } from '../shared/reveals.js';
import { normaliseMark, cleanMarks, withMarks } from '../shared/marks.js';
import { prepareImport } from '../shared/replay-import.js';
import { summarise } from '../shared/game-summary.js';
import { zip } from '../shared/zip.js';

/**
 * Build a data: URL for a download. Chunked, because spreading a large array
 * into String.fromCharCode overflows the call stack - which is exactly how the
 * first export silently did nothing at all.
 */
function jsonDataUrl(value) {
  return bytesDataUrl(new TextEncoder().encode(JSON.stringify(value)), 'application/json');
}

function bytesDataUrl(bytes, type) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${type};base64,` + btoa(binary);
}

/**
 * Every replay as one .zip, each file exactly what Export would save for it -
 * marks included. A replay that has fallen behind its recording is rebuilt
 * first, as Export does; one that will not build is left out and counted.
 */
async function exportAll() {
  const sessions = (await all(SESSIONS)).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const counts = new Map();
  for (const c of await all(COMMITS)) counts.set(c.roomCode, (counts.get(c.roomCode) ?? 0) + 1);
  const files = [];
  let skipped = 0;
  for (const s of sessions) {
    const recorded = counts.get(s.roomCode) ?? 0;
    if (!s.imported && isEmptyRecording(s, recorded)) continue;
    let row = await get(REPLAYS, s.roomCode);
    const behind = !row || (row.replay.commits.length < recorded && !row.replay.coverage?.unanchored);
    if (behind && !s.imported) {
      await finalise(s.roomCode, { close: false });
      row = await get(REPLAYS, s.roomCode);
    }
    if (!row) { skipped++; continue; }
    const replay = withMarks(row.replay, await marksFor(s.roomCode));
    files.push({
      // Recording ids are a room code and a time; keep them safe as file names anyway.
      name: `${s.roomCode.replace(/[\\/:*?"<>|]/g, '_')}.ratlas.json`,
      data: JSON.stringify(replay),
      date: new Date(replay.match?.capturedAt ?? s.startedAt ?? Date.now()),
    });
  }
  return { files, skipped };
}

/**
 * Which recording a mark is for. Replay mode and the library name it; the
 * in-game overlay knows only the room it is playing in, which is resolved
 * the way the recorder resolves a frame - so a mark lands in the same
 * recording as the moves around it.
 */
async function markTarget(msg) {
  if (msg.recordingId) return msg.recordingId;
  if (msg.room) return (await activeRecordingFor(msg.room))?.roomCode ?? null;
  return null;
}

/** One recording's marks, in match order, as exported. */
async function marksFor(recordingId) {
  if (!recordingId) return [];
  return cleanMarks(await extrasFor(recordingId, 'mark'));
}

/** Rooms whose socket closed or whose log announced a result, awaiting finalise. */
const pendingFinalise = new Set();

const ARMING_SCRIPTS = [
  {
    id: 'riftatlas-replay-arm',
    matches: ['https://play.riftatlas.com/*'],
    js: ['replay-mode/arm.js'],
    runAt: 'document_start',
    world: 'ISOLATED',
  },
  {
    id: 'riftatlas-replay-inject',
    matches: ['https://play.riftatlas.com/*'],
    js: ['replay-mode/inject.js'],
    runAt: 'document_start',
    world: 'MAIN',
  },
];

async function registerArmingScripts() {
  await unregisterArmingScripts();
  // Session storage is closed to content scripts by default, so arm.js would
  // read nothing. Widen it for the pending replay handover.
  await chrome.storage.session.setAccessLevel({
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
  }).catch(() => {});
  await chrome.scripting.registerContentScripts(ARMING_SCRIPTS);
}

async function unregisterArmingScripts() {
  const ids = ARMING_SCRIPTS.map((s) => s.id);
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
    }
  } catch { /* nothing registered */ }
}

// The shortcuts for marking during a match. They are the browser's own, so a
// keystroke never reaches RiftAtlas' page; the tab's overlay knows the room
// and the step, and does the marking.
chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== 'mark-step' && command !== 'note-step') return;
  if (!tab?.id || !/^https:\/\/play\.riftatlas\.com\//.test(tab.url ?? '')) return;
  chrome.tabs.sendMessage(tab.id, { type: 'liveMark', note: command === 'note-step' }).catch(() => {});
});

// Never carry an arming registration across a browser restart.
chrome.runtime.onStartup.addListener(() => {
  unregisterArmingScripts();
  chrome.storage.session.remove(['pendingReplay', 'pendingReveals', 'pendingRecordingId',
    'pendingStartSequence']).catch(() => {});
});

/**
 * Does this failure need a newer version, or is it worth trying again now?
 *
 * A patch verb the reducer has never seen can only be handled by code that
 * knows it, so retrying changes nothing until a new version arrives. Every
 * other failure - a storage hiccup, a worker stopped mid-build - may well
 * succeed on a second attempt, and there is no reason to make anyone wait for a
 * release for those.
 */
function needsNewVersion(problem) {
  return /unknown patch operation/i.test(String(problem));
}

/**
 * Rebuild whatever failed to build, whenever the extension changes.
 *
 * A build fails when the reducer meets something RiftAtlas has added since -
 * and the fix for that arrives as a new version. Asking someone to press
 * Rebuild would be asking them to run the same code twice; retrying on update
 * is the moment it can actually succeed. The recordings were never damaged, so
 * this repairs replays that have been broken for as long as the gap lasted.
 */
async function rebuildFailed(why, { onlyRetryable = false } = {}) {
  const sessions = await all(SESSIONS);
  const broken = sessions.filter((s) => {
    const problem = s.buildError || s.coverageStoppedEarly;
    if (!problem) return false;
    return onlyRetryable ? !needsNewVersion(problem) : true;
  });
  if (!broken.length) return;
  console.info(`[riftatlas-replay] ${why}: rebuilding ${broken.length} replay(s) that failed before`);
  for (const session of broken) await finalise(session.roomCode, { close: false });
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'update' || reason === 'install') {
    rebuildFailed(`extension ${reason}`).catch(() => {});
  }
});

// A browser restart is another free moment to retry, and covers an update that
// happened while the browser was closed.
chrome.runtime.onStartup.addListener(() => { rebuildFailed('browser start').catch(() => {}); });

/**
 * Close a recording: mark it done, then build its replay.
 *
 * Closing and building are separate on purpose. Building can fail - a recording
 * that never caught an anchoring snapshot has nothing to build from - and an
 * earlier version left such a recording open forever, so the next match in the
 * same room code was appended to it and the two merged. A recording that has
 * ended is ended whether or not a replay came out of it.
 */
async function finalise(recordingId, { close = true } = {}) {
  // An imported replay has no frames behind it: the file is the replay, and
  // building from nothing would replace it with an error.
  try {
    if ((await get(SESSIONS, recordingId))?.imported) return;
  } catch { /* carry on; the build reports its own trouble */ }
  if (close) {
    try {
      const session = await get(SESSIONS, recordingId);
      if (session && !session.finished) {
        session.finished = true;
        await put(SESSIONS, session);
      }
    } catch (err) {
      console.warn('[riftatlas-replay] could not close', recordingId, err.message);
    }
  }
  try {
    const replay = await buildReplay(recordingId);
    await put(REPLAYS, { roomCode: recordingId, builtAt: Date.now(), replay });
    const session = await get(SESSIONS, recordingId);
    if (session) {
      const stopped = replay.coverage?.stoppedAt ?? null;
      const had = session.buildError || session.coverageStoppedEarly;
      delete session.buildError;
      // A replay that stopped early is still worth retrying later, for the same
      // reason a failed one is: the missing piece arrives with a new version.
      if (stopped) session.coverageStoppedEarly = stopped.reason;
      else delete session.coverageStoppedEarly;
      if (had || stopped) await put(SESSIONS, session);
    }
    pendingFinalise.delete(recordingId);
  } catch (err) {
    // Record why, and show it. A build can fail for a reason worth acting on -
    // a patch verb the reducer predates, say - and a console warning nobody
    // reads made that look like a button that simply does nothing.
    console.warn('[riftatlas-replay] could not build', recordingId, err.message);
    try {
      const session = await get(SESSIONS, recordingId);
      if (session) { session.buildError = String(err?.message ?? err); await put(SESSIONS, session); }
    } catch { /* the session is gone */ }
  }
}

/**
 * The room whose frames we saw last. A different one means the previous match
 * is over, whatever its log did or did not say.
 */
let currentRoom = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'observer') {
    if (msg.kind === 'frame') {
      // Acknowledge only once the frame is persisted, and keep the port open
      // until then by returning true.
      //
      // This is the frame-loss bug. Handling the frame without an
      // acknowledgement and returning false told Chrome the listener was done,
      // so sendMessage resolved before anything reached IndexedDB. The bridge
      // counted the frame delivered and moved on, and if the worker was then
      // stopped mid-write - which MV3 does freely - the frame was gone with
      // nothing to retry. One real match lost 28 commits that way and replayed
      // as nine moves out of 396.
      onFrame(msg).then(async (result) => {
        sendResponse({ ok: true });
        if (!result) return;
        const { id: roomCode, reopened } = result;

        // A frame arriving on a closed recording reopens it, and the room it
        // belongs to is not the room being played now - so leave `currentRoom`
        // alone. Whether it is over is decided below, on the evidence, rather
        // than assumed from the fact that it was closed once already: the
        // close may have been the mistake.
        if (!reopened) {
          // A new room started: whatever came before it is finished.
          if (currentRoom && currentRoom !== roomCode) {
            const previous = currentRoom;
            currentRoom = roomCode;
            await finalise(previous);
          } else {
            currentRoom = roomCode;
          }
        }

        // Everyone has left the room. Steadier than reading the log, and the
        // reason finalisation no longer hangs on spotting a victory line.
        const session = await get(SESSIONS, roomCode);
        if (everyoneLeft(session)) { await finalise(roomCode); return; }

        // Last and least: the log looks like an ending. Only a hint - it has
        // been wrong before, and a closing socket rebuilds regardless.
        try {
          if (looksFinished(JSON.parse(msg.data))) { await finalise(roomCode); return; }
        } catch { /* already filtered by onFrame */ }

        // Nothing says it has ended. If this frame reopened it, rebuild so the
        // arrival is not stranded in a replay built without it, and let it run.
        if (reopened) await finalise(roomCode, { close: false });
      }).catch((error) => {
        // Nothing was stored. Say so, so the bridge sends it again.
        sendResponse({ ok: false, error: String(error?.message ?? error) });
      });
      return true;
    }

    if (msg.kind === 'close') {
      // Only the recording this socket was feeding has ended.
      //
      // The observer watches every `/parties/` socket, and RiftAtlas keeps
      // several open at once - lobby, queue, the match itself. This used to
      // close *every* recording on any of them closing, which ended live
      // matches from across the room: two in one evening were cut in half
      // mid-play, and the half that followed had no snapshot to anchor on, so
      // it built into a replay that could not move off its final state.
      //
      // Everything else is still rebuilt, because an early finalise - the
      // initiative roll once read as a victory - must never be the last word,
      // or the replay stays frozen wherever the detector misfired. An unknown
      // socket closes nothing: the other end triggers will finish the match,
      // and leaving a recording open costs far less than ending a live one.
      all(SESSIONS).then((sessions) => {
        for (const s of sessions) {
          finalise(s.roomCode, { close: endsWithSocket(s, msg.socketId) });
        }
      });
    }
    return false;
  }

  if (msg?.type === 'list') {
    // Retry anything that could succeed without a new version, and finish
    // before listing, so a recording that just repaired itself is not still
    // shown as broken. Costs nothing when there is nothing to retry, which is
    // the usual case.
    rebuildFailed('popup opened', { onlyRetryable: true })
      .catch(() => {})
      .then(() => all(SESSIONS))
      .then(async (sessions) => {
      const replays = await all(REPLAYS);
      const built = new Map(replays.map((r) => [r.roomCode, r]));
      // One pass over the commits rather than a range query per recording:
      // with a long history that difference is the popup feeling instant or not.
      const counts = new Map();
      for (const c of await all(COMMITS)) {
        counts.set(c.roomCode, (counts.get(c.roomCode) ?? 0) + 1);
      }
      // A session that has caught nothing is not a recording, and is never
      // listed. Ending a match is the usual way one appears: finalise closes
      // the recording, then the trailing frames - a shell sync as the client
      // returns to the room - find no open recording and start an empty one,
      // which then sits above the real match wearing the same room code.
      //
      // They are hidden immediately and deleted once they cannot still be a
      // match in the act of starting: a shell sync does arrive a beat before
      // the opening snapshot, and in that beat the two look identical.
      const SETTLE_MS = 2 * 60 * 1000;
      const now = Date.now();
      const live = [];
      for (const s of sessions) {
        // An imported replay has no commits of its own and is never residue.
        if (s.imported || !isEmptyRecording(s, counts.get(s.roomCode))) { live.push(s); continue; }
        if (now - (s.lastAt ?? 0) > SETTLE_MS) dropRecording(s.roomCode).catch(() => {});
      }

      const rows = await Promise.all(live
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(async (s) => {
          const replay = built.get(s.roomCode)?.replay ?? null;
          const recorded = counts.get(s.roomCode) ?? 0;
          const marks = await marksFor(s.roomCode);
          return {
            roomCode: s.roomCode,               // the recording id, used by actions
            room: s.room ?? roomOf(s.roomCode),  // the code a person recognises
            startedAt: s.startedAt,
            lastAt: s.lastAt,
            finished: s.finished === true,
            partial: s.partial === true,
            imported: s.imported === true,
            hasReplay: !!replay,
            builtAt: built.get(s.roomCode)?.builtAt ?? null,
            recordedCommits: recorded,
            builtCommits: replay?.commits?.length ?? 0,
            // A built replay can fall behind its recording - an early finalise
            // once froze one at the dice roll while recording carried on. Say
            // so rather than letting a short replay look like a short match.
            stale: !s.imported && !!replay && replay.commits.length < recorded
              && !replay.coverage?.unanchored,
            unanchored: replay?.coverage?.unanchored ?? null,
            match: replay?.match ?? null,
            players: replay?.players ?? null,
            // Which best-of-three this game belongs to, so the library can group them.
            series: replay?.shell?.seriesId
              ? { id: replay.shell.seriesId, game: replay.shell.gameNumber ?? null } : null,
            viewerPlayerId: replay?.viewer?.playerId ?? null,
            buildError: s.buildError ?? null,
            stoppedEarly: replay?.coverage?.stoppedAt ?? null,
            needsNewVersion: needsNewVersion(s.buildError || s.coverageStoppedEarly || ''),
            // Counted for the row, and their words kept so search finds them.
            markCount: marks.length,
            markText: marks.map((m) => m.text).filter(Boolean).join(' '),
          };
        }));
      sendResponse(rows);
    });
    return true;
  }

  if (msg?.type === 'reveals') {
    // The in-game overlay asking what the opponent has shown and hidden again
    // in the match being played. Read from the recording rather than from the
    // page, so a reload mid-match forgets nothing. Reducing a whole match takes
    // a few milliseconds, which is cheap enough to do on every ask.
    (async () => {
      const session = msg.room ? await activeRecordingFor(msg.room) : null;
      if (!session?.origin) return sendResponse({ ok: true, events: [] });
      const viewer = session.viewer ?? session.shell?.viewer ?? {};
      const events = extractReveals({
        origin: session.origin,
        commits: await commitsFor(session.roomCode),
        snapshots: await extrasFor(session.roomCode, 'snapshot'),
        viewerPlayerId: viewer.playerId ?? null,
      });
      sendResponse({ ok: true, events });
    })().catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'marks') {
    markTarget(msg)
      .then(async (id) => sendResponse({ ok: true, recordingId: id, marks: await marksFor(id) }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'saveMark') {
    (async () => {
      const id = await markTarget(msg);
      if (!id || !(await get(SESSIONS, id))) {
        return sendResponse({ ok: false, error: msg.room
          ? 'This match is not being recorded yet.' : 'That recording is no longer here.' });
      }
      const key = String(msg.sequence);
      const before = await get(EXTRAS, [id, 'mark', key]);
      const mark = normaliseMark({
        sequence: msg.sequence,
        text: msg.text ?? before?.text ?? '',
        source: before?.source ?? msg.source,
        createdAt: before?.createdAt,
        updatedAt: Date.now(),
      });
      if (!mark) return sendResponse({ ok: false, error: 'not a step of this match' });
      await put(EXTRAS, { roomCode: id, kind: 'mark', id: key, ...mark });
      sendResponse({ ok: true, marks: await marksFor(id) });
    })().catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'deleteMark') {
    (async () => {
      const id = await markTarget(msg);
      await del(EXTRAS, [id, 'mark', String(msg.sequence)]);
      sendResponse({ ok: true, marks: await marksFor(id) });
    })().catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'export') {
    (async () => {
      // Rebuild first, always. A replay built earlier in the match can be
      // behind the recording, and exporting a stale one is how a complete
      // recording leaves as a short replay.
      await finalise(msg.roomCode, { close: false });
      const row = await get(REPLAYS, msg.roomCode);
      if (!row) return sendResponse({ ok: false, error: 'nothing recorded for this room' });
      // Marks live beside the recording, not in the built replay, so a rebuild
      // cannot lose them; this is where they join it.
      const replay = withMarks(row.replay, await marksFor(msg.roomCode));
      // A data: URL keeps the download entirely local; no blob URL, no fetch.
      const url = jsonDataUrl(replay);
      chrome.downloads.download({ url, filename: `${msg.roomCode}.ratlas.json`, saveAs: true },
        () => sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message }));
      return;
    })();
    return true;
  }

  if (msg?.type === 'exportAll') {
    (async () => {
      const { files, skipped } = await exportAll();
      if (!files.length) return sendResponse({ ok: false, error: 'No replays to export yet.' });
      const bytes = await zip(files);
      const day = new Date().toISOString().slice(0, 10);
      chrome.downloads.download({
        url: bytesDataUrl(bytes, 'application/zip'),
        filename: `riftatlas-replays-${day}.zip`,
        saveAs: true,
      }, () => sendResponse({
        ok: !chrome.runtime.lastError,
        error: chrome.runtime.lastError?.message,
        count: files.length,
        skipped,
      }));
    })().catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'finalise') {
    // Rebuilding is not the same as ending: a match still in progress must stay
    // open so its later frames keep landing in the same recording.
    finalise(msg.roomCode, { close: false }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg?.type === 'delete') {
    dropRecording(msg.roomCode).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg?.type === 'replayMode') {
    (async () => {
      const row = await get(REPLAYS, msg.roomCode);
      if (!row) return sendResponse({ ok: false, error: 'build the replay first' });

      const [tab] = await chrome.tabs.query({ url: 'https://play.riftatlas.com/*' });
      if (!tab) {
        return sendResponse({ ok: false, error: 'open play.riftatlas.com first' });
      }

      // Replay mode must install before the page opens its match socket, about
      // two seconds into load. So park the replay, register the arming scripts
      // at document_start, and reload the tab - arming after the fact loses the
      // race and replay mode rightly refuses to displace a real socket.
      // The reveals travel with it: inject.js runs in the page's world, where
      // the reducer's module cannot be loaded, so they are worked out here.
      let reveals = [];
      try { reveals = revealsFromReplay(row.replay); } catch { /* the replay still plays */ }
      // The recording id too, which is what its marks are kept under.
      // And where to start: the library opens a replay at a mark.
      await chrome.storage.session.set({
        pendingReplay: row.replay, pendingReveals: reveals, pendingRecordingId: msg.roomCode,
        pendingStartSequence: Number.isInteger(msg.startSequence) ? msg.startSequence : null,
      });
      await registerArmingScripts();
      await chrome.tabs.update(tab.id, { active: true, url: 'https://play.riftatlas.com/game' });
      sendResponse({ ok: true, roomCode: msg.roomCode });
    })().catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'replayModeArmed') {
    // Armed exactly once; take the scripts back out so replay mode is not
    // sitting on every future page load.
    unregisterArmingScripts();
    return false;
  }

  if (msg?.type === 'dump') {
    // Everything the recorder holds, for a bug report: raw commits and
    // snapshots included, so a recording that will not finalise can still be
    // diagnosed. Carries decklists and player names, but no credentials -
    // handshake frames are dropped before anything is stored.
    (async () => {
      try {
        const dump = {
          dumpedAt: new Date().toISOString(),
          extensionVersion: chrome.runtime.getManifest().version,
          sessions: await all(SESSIONS),
          commits: await all(COMMITS),
          extras: await all(EXTRAS),
          replays: await all(REPLAYS),
        };
        chrome.downloads.download(
          { url: jsonDataUrl(dump), filename: 'riftatlas-replay-debug.json', saveAs: false },
          () => sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message }));
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg?.type === 'clearRoomState') {
    // Forget whatever room the client thinks it is in. The way out of
    // "Couldn't reconnect to your game" when a replay left its room behind.
    (async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://play.riftatlas.com/*' });
      if (!tab) return sendResponse({ ok: false, error: 'open play.riftatlas.com first' });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          localStorage.removeItem('riftbound_simulator_last_room');
          sessionStorage.removeItem('riftbound_simulator_active_room');
        },
      });
      await chrome.tabs.update(tab.id, { active: true, url: 'https://play.riftatlas.com/' });
      sendResponse({ ok: true });
    })().catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'openPlayer') {
    // `import` opens it ready to add a file to the recordings. The popup cannot
    // do that itself: a file picker takes focus, and losing focus closes it.
    const url = chrome.runtime.getURL('player/player.html') + (msg.import ? '#import' : '');
    chrome.tabs.create({ url });
    return false;
  }

  if (msg?.type === 'openLibrary') {
    chrome.tabs.create({ url: chrome.runtime.getURL('library/library.html') });
    return false;
  }

  if (msg?.type === 'summary') {
    // One game, read for the library: mulligans, sideboarding, and where each
    // mark falls. Worked out on asking - a few hundred milliseconds a game -
    // rather than kept, so it can never disagree with the replay.
    (async () => {
      const row = await get(REPLAYS, msg.recordingId);
      if (!row) return sendResponse({ ok: false, error: 'This match has no replay yet.' });
      const summary = summarise(row.replay, await marksFor(msg.recordingId));
      sendResponse({ ok: true, summary: { ...summary, recordingId: msg.recordingId } });
    })().catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'importReplay') {
    (async () => {
      const { id, session, replay, marks } = prepareImport(msg.replay);
      const existing = await get(SESSIONS, id);
      // A match recorded here is the original; a file of it adds nothing and
      // must not replace what the recorder can still rebuild from.
      if (existing && !existing.imported) {
        return sendResponse({ ok: false, error: 'That match is already in your recordings.' });
      }
      if (existing) await dropRecording(id);   // importing the same file again replaces it
      await put(SESSIONS, session);
      await put(REPLAYS, { roomCode: id, builtAt: Date.now(), replay });
      for (const mark of marks) {
        await put(EXTRAS, { roomCode: id, kind: 'mark', id: String(mark.sequence), ...mark });
      }
      sendResponse({ ok: true, id, room: session.room, marks: marks.length, replaced: !!existing });
    })().catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  return false;
});

void pendingFinalise;
