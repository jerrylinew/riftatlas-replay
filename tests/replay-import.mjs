#!/usr/bin/env node
/**
 * Adding a .ratlas.json file to the recordings list.
 *
 * An imported replay has no frames behind it, so it is stored finished and
 * flagged, and keeps the id it was recorded under so the same match is not
 * listed twice. A file can come from anyone; what cannot be a replay is
 * refused with a reason a person can act on.
 *
 *   node tests/replay-import.mjs
 */
import { prepareImport } from '../extension/shared/replay-import.js';

let failed = 0;
const check = (ok, label, got) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok && got !== undefined) console.log(`       got ${JSON.stringify(got)}`);
};
const refuses = (file, pattern, label) => {
  try { prepareImport(file); check(false, label, 'accepted'); }
  catch (e) { check(pattern.test(e.message), label, e.message); }
};

const base = {
  format: 'riftatlas-replay', version: 1,
  match: { roomCode: 'CAZ6G', capturedAt: 1791949697627, durationMs: 60000 },
  origin: { sequence: 0, snapshot: { phase: 'battlefield_pick' } },
  commits: [], partial: false, shell: { seriesId: 's1', gameNumber: 1 },
  recordingId: 'CAZ6G@1791949697627',
};

const a = prepareImport({ ...base, marks: [{ sequence: 9, text: 'hm' }, { sequence: 'x' }] }, 5);
check(a.id === 'CAZ6G@1791949697627', 'keeps the id it was recorded under', a.id);
check(a.session.imported === true && a.session.finished === true, 'stored finished, and flagged as imported');
check(a.session.room === 'CAZ6G' && a.session.startedAt === 1791949697627
  && a.session.lastAt === 1791949757627, 'room and times from the match', a.session);
check(a.session.shell?.seriesId === 's1', 'its shell kept, for settling a series');
check(a.marks.length === 1 && a.marks[0].text === 'hm', 'its marks cleaned and kept apart', a.marks);
check(!('marks' in a.replay) && a.replay.recordingId === a.id, 'the stored replay carries no marks');

const b = prepareImport({ ...base, recordingId: undefined }, 5);
check(b.id === 'CAZ6G@1791949697627', 'an id made from room and time when the file has none', b.id);
const c = prepareImport({ ...base, recordingId: '../../evil path' }, 5);
check(c.id === 'CAZ6G@1791949697627', 'an id that is not one is replaced', c.id);
const d = prepareImport({ ...base, recordingId: undefined, match: { roomCode: 'ABCDE' } }, 77);
check(d.id === 'ABCDE@77' && d.session.lastAt === 77, 'no capture time: now', d.id);

refuses(null, /not a replay/, 'nothing at all');
refuses({ log: {} }, /not a RiftAtlas replay/, 'a HAR or other JSON');
refuses({ ...base, version: 2 }, /version 2/, 'a newer format version');
refuses({ ...base, match: {} }, /room code/, 'no room code');
refuses({ ...base, commits: undefined }, /incomplete/, 'no moves');
refuses({ ...base, origin: {} }, /incomplete/, 'no starting position');

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
