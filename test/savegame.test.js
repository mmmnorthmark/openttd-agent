// savegame.js on small synthetic uncompressed ('OTTN') saves: RIFF and table chunks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSavegame, spliceChunks, patchTableFields } from '../src/savegame.js';

const header = (tag = 'OTTN') => Buffer.concat([Buffer.from(tag, 'latin1'), Buffer.from([0x01, 0x5e, 0x00, 0x00])]);
const end = Buffer.alloc(4);

/** RIFF chunk: id, mode byte 0 (+ high length nibble), 24-bit length, payload. */
function riff(id, payload) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'latin1');
  head[4] = ((payload.length >> 24) & 0x0f) << 4;
  head[5] = (payload.length >> 16) & 0xff;
  head.writeUInt16BE(payload.length & 0xffff, 6);
  return Buffer.concat([head, payload]);
}

function gamma(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x4000) return Buffer.from([0x80 | (n >> 8), n & 0xff]);
  throw new Error('test gamma: too large');
}

/** Table chunk (type 3): each element is gamma(len + 1) + bytes; a zero gamma ends it. */
function table(id, elements) {
  const parts = [Buffer.from(id, 'latin1'), Buffer.from([3])];
  for (const e of elements) parts.push(gamma(e.length + 1), e);
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

const save = (...chunks) => Buffer.concat([header(), ...chunks, end]);
const ids = (buf) => parseSavegame(buf).chunks.map((c) => c.id);

const MAPS = riff('MAPS', Buffer.from([0, 64, 0, 64]));
const BIG = table('TOWN', [Buffer.from('header'), Buffer.alloc(300, 7), Buffer.from('x')]); // 300 bytes: two-byte gamma
const GS_SCENARIO = table('GSDT', [Buffer.from('hdr'), Buffer.from('SomeGoalScript')]);
const GS_BRIDGE = table('GSDT', [Buffer.from('hdr'), Buffer.from('AgentBridge,settings,version 6')]);

test('parseSavegame finds every chunk with exact byte ranges', () => {
  const buf = save(MAPS, BIG, GS_SCENARIO);
  const p = parseSavegame(buf);
  assert.deepEqual(p.chunks.map((c) => c.id), ['MAPS', 'TOWN', 'GSDT']);
  assert.equal(p.chunks[0].start, 8);
  assert.equal(p.chunks[0].end, 8 + MAPS.length);
  assert.equal(p.chunks[2].end, buf.length - 4);
  assert.equal(p.endMarker, buf.length - 4);
  assert.ok(buf.subarray(p.chunks[1].start, p.chunks[1].end).equals(BIG));
});

test('spliceChunks replaces a chunk in place and leaves the rest byte-identical', () => {
  const target = save(MAPS, GS_SCENARIO, BIG);
  const donor = save(riff('MAPS', Buffer.from([9, 9])), GS_BRIDGE);
  const out = spliceChunks(target, donor, ['GSDT']);
  assert.ok(out.equals(save(MAPS, GS_BRIDGE, BIG)), 'GSDT from the donor, same position, map untouched');
  assert.deepEqual(ids(out), ['MAPS', 'GSDT', 'TOWN']);
});

test('spliceChunks appends a chunk the target does not have', () => {
  const out = spliceChunks(save(MAPS, BIG), save(GS_BRIDGE), ['GSDT']);
  assert.ok(out.equals(save(MAPS, BIG, GS_BRIDGE)));
});

test('bad tags and missing chunks give readable errors', () => {
  const target = save(MAPS, GS_SCENARIO);
  assert.throws(() => spliceChunks(target, save(MAPS), ['GSDT']), /donor has no GSDT chunk/);
  assert.throws(() => spliceChunks(save(MAPS), save(MAPS), ['XXXX']), /neither save has a XXXX chunk/);
  const xz = Buffer.concat([header('OTTX'), MAPS, end]);
  assert.throws(() => parseSavegame(xz), /expected uncompressed 'OTTN' save, got 'OTTX'.*savegame_format = none/);
});

test('truncated or padded files are rejected (a save still being written must not parse)', () => {
  const buf = save(MAPS, BIG, GS_SCENARIO);
  assert.throws(() => parseSavegame(buf.subarray(0, buf.length - 4)), /truncated|past end/);
  assert.throws(() => parseSavegame(buf.subarray(0, buf.length - 200)), /truncated|past end/);
  assert.throws(() => parseSavegame(Buffer.concat([buf, Buffer.from([1])])), /after end marker/);
  assert.throws(() => parseSavegame(save(Buffer.concat([Buffer.from('BADC', 'latin1'), Buffer.from([9])]))), /unknown type 9/);
});

/** Settings-style table: header element (type byte + gamma-length name per field, then 0) and one record. */
function settingsTable(id, fields) {
  const head = [];
  const rec = [];
  for (const [type, name, bytes] of fields) {
    head.push(Buffer.from([type]), gamma(name.length), Buffer.from(name));
    rec.push(bytes);
  }
  head.push(Buffer.from([0]));
  return table(id, [Buffer.concat(head), Buffer.concat(rec)]);
}
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
const PATS = (pause, opcodes) => settingsTable('PATS', [
  [0x02, 'difficulty.max_no_competitors', Buffer.from([7])],
  [0x1a, 'game_creation.name', Buffer.concat([gamma(5), Buffer.from('hello')])],   // string: length field
  [0x14, 'some.list', Buffer.concat([gamma(2), Buffer.from([0, 1, 0, 2])])],       // list of two uint16
  [0x02, 'construction.command_pause_level', Buffer.from([pause])],
  [0x06, 'script.script_max_opcode_till_suspend', u32(opcodes)],
  [0x08, 'economy.big', Buffer.alloc(8, 1)],
]);

test('patchTableFields sets integer settings in place and reports the old values', () => {
  const buf = save(MAPS, PATS(1, 10000), GS_SCENARIO);
  const { buf: out, previous } = patchTableFields(buf, 'PATS', { 'construction.command_pause_level': 3, 'script.script_max_opcode_till_suspend': 100000 });
  assert.deepEqual(previous, { 'construction.command_pause_level': 1, 'script.script_max_opcode_till_suspend': 10000 });
  assert.ok(out.equals(save(MAPS, PATS(3, 100000), GS_SCENARIO)), 'only the two values differ');
  assert.ok(buf.equals(save(MAPS, PATS(1, 10000), GS_SCENARIO)), 'input untouched');
});

test('patchTableFields refuses unknown fields, non-integers, bad values and non-tables', () => {
  const buf = save(MAPS, PATS(1, 10000));
  assert.throws(() => patchTableFields(buf, 'PATS', { 'no.such': 1 }), /no field no\.such/);
  assert.throws(() => patchTableFields(buf, 'PATS', { 'game_creation.name': 1 }), /not a plain/);
  assert.throws(() => patchTableFields(buf, 'PATS', { 'economy.big': 1 }), /not a plain/);
  assert.throws(() => patchTableFields(buf, 'PATS', { 'construction.command_pause_level': 256 }), /does not fit/);
  assert.throws(() => patchTableFields(buf, 'MAPS', {}), /not a table/);
  assert.throws(() => patchTableFields(buf, 'GSDT', {}), /no GSDT chunk/);
  const nested = save(settingsTable('PATS', [[0x1b, 'sub', Buffer.from([0])]]));
  assert.throws(() => patchTableFields(nested, 'PATS', {}), /nested structs/);
});
