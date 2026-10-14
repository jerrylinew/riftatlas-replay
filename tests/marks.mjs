#!/usr/bin/env node
/**
 * Marks: steps of a replay someone marked, and their notes.
 *
 * They are stored beside the recording rather than on the built replay -
 * every rebuild and every export replaces that row - and join the replay
 * only when it is exported. A file can come from anyone, so whatever is read
 * back is cleaned before it is shown.
 *
 *   node tests/marks.mjs
 */
import { normaliseMark, cleanMarks, withMarks, MAX_TEXT } from '../extension/shared/marks.js';

let failed = 0;
const check = (ok, label, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok && detail !== undefined) console.log(`       got ${JSON.stringify(detail)}`);
};

const m = normaliseMark({ sequence: 85, text: '  held Rune here?  ' }, 1000);
check(m?.sequence === 85 && m.text === 'held Rune here?', 'a note is trimmed', m);
check(m?.createdAt === 1000 && m.updatedAt === 1000, 'a new mark is timestamped now', m);
check(m?.source === 'replay', 'marks default to replay mode', m);
check(normaliseMark({ sequence: 3, source: 'live' }).source === 'live', 'a live mark stays live');
check(normaliseMark({ sequence: 3, source: '<script>' }).source === 'replay', 'an unknown source is not kept');
check(normaliseMark({ sequence: 4 })?.text === '', 'a mark needs no note');
check(normaliseMark({ sequence: 4, text: 7 })?.text === '', 'a note that is not text is dropped');
check(normaliseMark({ sequence: 9, text: 'x'.repeat(MAX_TEXT + 50) }).text.length === MAX_TEXT,
  'a note is capped');
check(normaliseMark({ sequence: 9, createdAt: 5, updatedAt: 8 }).updatedAt === 8,
  'an edit keeps its own time');

for (const bad of [{}, { sequence: -1 }, { sequence: 2.5 }, { sequence: '12' }, null, { sequence: NaN }]) {
  // A numeric string is accepted: a key read back from storage is a string.
  const want = bad?.sequence === '12' ? 12 : null;
  const got = normaliseMark(bad)?.sequence ?? null;
  check(got === want, `sequence ${JSON.stringify(bad?.sequence)} → ${want ?? 'rejected'}`, got);
}

const clean = cleanMarks([
  { sequence: 201, text: 'Mulligan regret?' },
  { sequence: 42 },
  { sequence: 'nope' },
  { sequence: 85, text: 'first' },
  { sequence: 85, text: 'second' },
]);
check(JSON.stringify(clean.map((x) => x.sequence)) === '[42,85,201]',
  'in match order, one per step, malformed dropped', clean.map((x) => x.sequence));
check(clean.find((x) => x.sequence === 85)?.text === 'second', 'the later of two marks on a step wins');
check(cleanMarks(undefined).length === 0 && cleanMarks('x').length === 0, 'no marks at all');

const replay = { format: 'riftatlas-replay', version: 1, commits: [] };
check(withMarks(replay, []) === replay, 'a replay with no marks exports exactly as built');
const exported = withMarks(replay, [{ sequence: 7, text: 'here' }]);
check(exported.marks?.length === 1 && exported.version === 1 && !('marks' in replay),
  'marks join the export without touching the stored replay', exported);

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
