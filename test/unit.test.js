import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PacketSplitter, encodePacket, cstr, Reader } from '../src/admin-client.js';
import { assembleParts } from '../src/gs-rpc.js';
import { TileMap, routeEffort, findFlatSites, townGaps, townsFromRows } from '../src/world.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchIni, resolveSavePath } from '../src/setup.js';

test('packet splitter handles split and merged packets', () => {
  const a = encodePacket(5, cstr('hello'));
  const b = encodePacket(6, cstr('world'));
  const s = new PacketSplitter();
  const all = Buffer.concat([a, b]);
  assert.deepEqual(s.push(all.subarray(0, 4)), []);
  const out = s.push(all.subarray(4));
  assert.equal(out.length, 2);
  assert.equal(out[0][0], 5);
  assert.equal(new Reader(out[1][1]).str(), 'world');
});

test('assembleParts concatenates arrays in part order and passes scalars through', () => {
  assert.deepEqual(assembleParts(new Map([[1, [3, 4]], [0, [1, 2]]])), [1, 2, 3, 4]);
  assert.deepEqual(assembleParts(new Map([[0, { a: 1 }]])), { a: 1 });
  assert.deepEqual(assembleParts(new Map([[0, []]])), []);
});

function flatMap(n, mutate = () => {}) {
  const m = new TileMap(n, n);
  for (let y = 0; y < n; y++) {
    let s = `${y},0,`;
    for (let x = 0; x < n; x++) s += '02' + '0' + mutate(x, y);
    m.applyRow(s);
  }
  return m;
}

test('TileMap decodes rows and tracks completeness', () => {
  const m = flatMap(8, (x) => (x === 3 ? 'w' : 'b'));
  assert.ok(m.isComplete());
  assert.equal(m.classAt(3, 5), 'w');
  assert.equal(m.heightAt(0, 0), 2);
});

test('routeEffort prefers going around water when a land gap exists', () => {
  const m = flatMap(64, (x, y) => (x === 30 && !(y >= 50 && y <= 52) ? 'w' : 'b'));
  const near = routeEffort(m, { x: 10, y: 50 }, { x: 50, y: 50 });
  assert.equal(near.reachable, true);
  assert.equal(near.obstacles.water ?? 0, 0);
  const far = routeEffort(m, { x: 10, y: 5 }, { x: 50, y: 5 }, { margin: 4 });
  assert.ok(far.obstacles.water >= 1, 'must bridge water when the gap is outside the search box');
  assert.ok(far.effort > near.effort);
});

test('findFlatSites returns distinct buildable rectangles nearest first', () => {
  const m = flatMap(32, (x, y) => (x < 10 ? 'o' : 'b'));
  const sites = findFlatSites(m, { cx: 12, cy: 12, width: 4, height: 3, radius: 10, limit: 3 });
  assert.equal(sites.length, 3);
  assert.ok(sites.every((s) => s.x >= 10));
  assert.ok(sites[0].distance <= sites[1].distance);
});

test('townGaps ranks by unserved passengers', () => {
  const towns = townsFromRows([[1, 'A', 0, 0, 1000, false, 100, 90, 0, 0, 1], [2, 'B', 0, 0, 1000, false, 80, 0, 0, 0, 1]]);
  assert.deepEqual(townGaps(towns, { minPopulation: 0 }).map((t) => t.name), ['B', 'A']);
});

test('patchIni updates existing keys, adds missing keys and sections, keeps the rest', () => {
  const src = '[network]\nserver_port = 1\nother = keep\n[gui]\nfoo = bar\n';
  const out = patchIni(src, { network: { server_port: 3979, allow_insecure_admin_login: 'true' }, game_scripts: { AgentBridge: 'a=1' } });
  assert.match(out, /server_port = 3979/);
  assert.match(out, /other = keep/);
  assert.match(out, /\[network\][\s\S]*allow_insecure_admin_login = true[\s\S]*\[gui\]/);
  assert.match(out, /\[game_scripts\]\nAgentBridge = a=1/);
  assert.match(out, /foo = bar/);
});

test('resolveSavePath: bare save names come from the profile save folder, paths are kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-profile-'));
  fs.mkdirSync(path.join(dir, 'save'));
  fs.writeFileSync(path.join(dir, 'save', 'mini_agent.sav'), 'x');
  fs.writeFileSync(path.join(dir, 'elsewhere.sav'), 'x');
  assert.equal(resolveSavePath('mini_agent', dir), path.join(dir, 'save', 'mini_agent.sav'));
  assert.equal(resolveSavePath('mini_agent.sav', dir), path.join(dir, 'save', 'mini_agent.sav'));
  assert.equal(resolveSavePath(path.join(dir, 'elsewhere.sav'), dir), path.join(dir, 'elsewhere.sav'));
  assert.throws(() => resolveSavePath('save', dir), /not found/, 'a directory is not a save');
  assert.throws(() => resolveSavePath('nope', dir), /savegame 'nope' not found/);
});

test('patchIni edits an existing [misc] key instead of adding a second section', () => {
  const out = patchIni('[misc]\nsavegame_format = \nfoo = 1\n\n[gui]\nx = 1\n', { misc: { savegame_format: 'none' } });
  assert.equal(out.match(/\[misc\]/g).length, 1);
  assert.match(out, /\[misc\]\nsavegame_format = none\nfoo = 1/);
});
