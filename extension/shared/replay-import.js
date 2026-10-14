/**
 * Adding a .ratlas.json file to the recordings list.
 *
 * An imported replay arrives finished: there are no frames behind it to
 * rebuild from, so it is stored as its built replay plus a session row that
 * says so (`imported: true`), and everything that would rebuild or tidy a
 * recording leaves it alone. Its marks go where marks made here go, beside it,
 * so they can be edited and are exported the same way.
 *
 * Pure, so the checks can be tested without a browser.
 */
import { cleanMarks } from './marks.js';

const FORMAT = 'riftatlas-replay';
const VERSION = 1;

/**
 * What to store for a replay file, or an Error saying why it cannot be added.
 *
 * Returns { id, session, replay, marks }: the recording id it is kept under,
 * the session row, the replay as stored (without its marks, which are kept
 * separately), and its marks.
 */
export function prepareImport(file, now = Date.now()) {
  if (!file || typeof file !== 'object') throw new Error('That file is not a replay.');
  if (file.format !== FORMAT) throw new Error('That file is not a RiftAtlas replay (.ratlas.json).');
  if (file.version !== VERSION) {
    throw new Error(`That replay is format version ${file.version}; this version of the extension reads ${VERSION}.`);
  }
  const room = file.match?.roomCode;
  if (typeof room !== 'string' || !room) throw new Error('That replay has no room code.');
  if (!file.origin?.snapshot || !Array.isArray(file.commits)) {
    throw new Error('That replay is incomplete: it has no starting position or no moves.');
  }

  const startedAt = Number.isFinite(file.match.capturedAt) ? file.match.capturedAt : now;
  // Keep the id it was recorded under, so importing a match you already have
  // is recognised as the same match rather than listed twice.
  const id = typeof file.recordingId === 'string' && /^[^@\s]{1,40}@\d{1,16}$/.test(file.recordingId)
    ? file.recordingId
    : `${room}@${startedAt}`;

  const { marks, ...rest } = file;
  return {
    id,
    replay: { ...rest, recordingId: id },
    marks: cleanMarks(marks),
    session: {
      roomCode: id,
      room,
      startedAt,
      lastAt: startedAt + (Number.isFinite(file.match.durationMs) ? file.match.durationMs : 0),
      finished: true,
      partial: file.partial === true,
      imported: true,
      importedAt: now,
      // Read across recordings to settle a best-of-three game (finalise.js).
      shell: file.shell ?? null,
      viewer: file.viewer ?? null,
    },
  };
}
