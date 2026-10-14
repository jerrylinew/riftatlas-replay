/**
 * Marks: steps of a match someone wants to come back to.
 *
 * A mark sits on one sequence - the number replay mode's bar shows as
 * "85/257" - and may carry a note. One mark per step: marking a step that is
 * already marked edits it rather than stacking a second one.
 *
 * Marks are kept per recording in the `extras` store, beside its chat, not on
 * the built replay: every rebuild, and every export, replaces that row whole.
 * They join the replay only on the way out, in an export.
 */

/** Long enough for a paragraph of review, short enough to stay a note. */
export const MAX_TEXT = 4000;

/** A mark as stored and exported, or null when there is no step to put it on. */
export function normaliseMark(raw, now = Date.now()) {
  const sequence = Number(raw?.sequence);
  if (!Number.isInteger(sequence) || sequence < 0) return null;
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, MAX_TEXT) : '';
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  return {
    sequence,
    text,
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
    source: raw.source === 'live' ? 'live' : 'replay',
  };
}

/** In match order. */
export function sortMarks(marks) {
  return [...marks].sort((a, b) => a.sequence - b.sequence);
}

/**
 * Marks read from anywhere - storage, or a file someone sent - made safe to
 * show: malformed ones dropped, one per step, in match order.
 */
export function cleanMarks(list) {
  const bySequence = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const mark = normaliseMark(raw, 0);
    if (mark) bySequence.set(mark.sequence, mark);
  }
  return sortMarks(bySequence.values());
}

/** The replay as exported: with its marks, or exactly as built when it has none. */
export function withMarks(replay, marks) {
  const clean = cleanMarks(marks);
  return clean.length ? { ...replay, marks: clean } : replay;
}
