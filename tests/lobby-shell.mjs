#!/usr/bin/env node
/**
 * A recording that starts in the lobby must not replay as a lobby.
 *
 * Game one of a best-of-three began recording while the room waited for the
 * second player, and only the first room header was kept: `phase: "lobby"`,
 * `manualStartRequired`, no opponent, no decklist. Watch replay showed a lobby
 * waiting for a start that never came (issue #1).
 *
 *   node tests/lobby-shell.mjs
 */
import { keptShell } from '../extension/background/recorder.js';

const lobby = { phase: 'lobby', manualStartRequired: true };
const pick = { phase: 'battlefield_pick' };
const playing = { phase: 'in_game' };

const cases = [
  [pick, keptShell(null, pick), 'the first header is kept'],
  [pick, keptShell(lobby, pick), 'a lobby header gives way to the game'],
  [pick, keptShell(pick, playing), 'a game header is not replaced by a later one'],
  [lobby, keptShell(lobby, lobby), 'a second lobby header changes nothing'],
  [lobby, keptShell(lobby, undefined), 'a sync without a document changes nothing'],
  [null, keptShell(null, undefined), 'no header at all'],
];

let failed = 0;
for (const [want, got, label] of cases) {
  const ok = want === got;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
}
console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
