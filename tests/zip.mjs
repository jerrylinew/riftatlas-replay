#!/usr/bin/env node
/**
 * Export all writes its own .zip, so read one back the way an unzipper would:
 * through the central directory, then each entry's local header, inflating
 * and checking every CRC. Python's zipfile and Windows' Expand-Archive were
 * also checked by hand against an archive of four real replays.
 *
 *   node tests/zip.mjs
 */
import { zip, crc32 } from '../extension/shared/zip.js';

let failed = 0;
const check = (ok, label, got) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok && got !== undefined) console.log(`       got ${JSON.stringify(got)}`);
};

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Every entry, read from the central directory as an unzipper does. */
async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error('no end record');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error(`bad central entry ${i}`);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = bytes.subarray(start, start + size);
    const data = method === 8 ? await inflateRaw(body) : body;
    entries.push({ name, flags, method, crc, data });
    at += 46 + nameLength;
  }
  return entries;
}

check(crc32(new TextEncoder().encode('123456789')) === 0xcbf43926, 'CRC-32 of the standard check string');

const big = JSON.stringify({ commits: Array.from({ length: 2000 }, (_, i) => ({ sequence: i, op: 'zone_move' })) });
const files = [
  { name: 'CAZ6G@1791949697627.ratlas.json', data: big, date: new Date(2026, 9, 13, 20, 48, 16) },
  { name: 'notes ★ é.txt', data: 'Should have held the rune here' },
  { name: 'empty.json', data: '' },
];

for (const compress of [true, false]) {
  const label = compress ? 'deflated' : 'stored';
  const bytes = await zip(files, { compress });
  const entries = await unzip(bytes);
  check(entries.length === 3, `${label}: every file is in it`, entries.length);
  const text = (e) => new TextDecoder().decode(e.data);
  check(entries.every((e, i) => e.name === files[i].name), `${label}: names kept, UTF-8 included`,
    entries.map((e) => e.name));
  check(entries.every((e, i) => text(e) === files[i].data), `${label}: contents come back exactly`);
  check(entries.every((e) => e.crc === crc32(e.data)), `${label}: every CRC matches`);
  check(entries.every((e) => e.flags & 0x0800), `${label}: names flagged as UTF-8`);
  if (compress) check(bytes.length < big.length / 5, 'replays shrink when deflated', [bytes.length, big.length]);
}

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
