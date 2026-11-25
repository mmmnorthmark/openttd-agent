// Pure world analysis: cargo pairs with town destinations, acceptance decoding.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCargoPairs, acceptanceFromRows, industriesFromRows } from '../src/world.js';

const cargos = new Map([[0, { id: 0, label: 'PASS', name: 'Passengers' }], [5, { id: 5, label: 'GOOD', name: 'Goods' }], [7, { id: 7, label: 'WOOD', name: 'Wood' }]]);
const types = new Map([
  [3, { id: 3, name: 'Forest', produces: [7], accepts: [], raw: true, processing: false }],
  [4, { id: 4, name: 'Sawmill', produces: [5], accepts: [7], raw: false, processing: true }],
]);
const industries = industriesFromRows([[1, 3, 10, 10, [[7, 100, 0]], 0], [2, 4, 40, 10, [[5, 0, 0]], 0]], types, cargos);
const towns = [{ id: 0, name: 'Bigton', x: 40, y: 30, population: 3000 }, { id: 1, name: 'Smallham', x: 70, y: 10, population: 200 }];

test('industriesFromRows marks processing industries secondary', () => {
  assert.equal(industries[0].secondary, undefined);
  assert.equal(industries[1].secondary, true);
});

test('findCargoPairs: goods go to towns whose centre accepts them, with the acceptance value', () => {
  const townAcceptance = new Map([[0, { 5: 12, 0: 30 }], [1, { 5: 7 }]]);
  const res = findCargoPairs({ industries, types, towns, townAcceptance, cargo: 'goods', withEffort: false, minProduction: 10 });
  assert.equal(res.total_candidates, 1, 'Smallham (7 < 8) is left out; min_production does not drop the secondary source');
  const [p] = res.pairs;
  assert.deepEqual(p.dest, { kind: 'town', id: 0, name: 'Bigton', x: 40, y: 30, population: 3000, acceptance: 12 });
  assert.equal(p.source.secondary, true);
  assert.equal(p.distance, 20);
  assert.match(res.notes[0], /secondary/);
});

test('findCargoPairs: dest_kind filters, industry dests carry kind, no town for wood', () => {
  const townAcceptance = new Map([[0, { 5: 12 }], [1, {}]]);
  const wood = findCargoPairs({ industries, types, towns, townAcceptance, cargo: 'wood', withEffort: false });
  assert.equal(wood.total_candidates, 1);
  assert.equal(wood.pairs[0].dest.kind, 'industry');
  assert.equal(wood.pairs[0].dest.type, 'Sawmill');
  assert.equal(findCargoPairs({ industries, types, towns, townAcceptance, cargo: 'goods', destKind: 'industry', withEffort: false }).total_candidates, 0);
  assert.equal(findCargoPairs({ industries, types, towns, townAcceptance, cargo: 'goods', destType: 'smallham', withEffort: false }).total_candidates, 0);
});

test('findCargoPairs without acceptance data lists towns unchecked for town-effect cargos only', () => {
  const res = findCargoPairs({ industries, types, towns, townAcceptance: null, townCargoFallback: new Set([0, 5]), withEffort: false });
  const townDests = res.pairs.filter((p) => p.dest.kind === 'town');
  assert.equal(townDests.length, 2, 'goods to both towns, unchecked');
  assert.ok(townDests.every((p) => p.dest.acceptance === null && p.cargo === 'Goods'));
  assert.ok(res.notes.some((n) => /older than v7/.test(n)));
});

test('acceptanceFromRows groups rows per point, highest first, accepted at 8', () => {
  const out = acceptanceFromRows([[0, 5, 7], [0, 0, 20], [1, 7, 8]], cargos, 3);
  assert.deepEqual(out[0].map((c) => [c.label, c.acceptance, c.accepted]), [['PASS', 20, true], ['GOOD', 7, false]]);
  assert.deepEqual(out[1].map((c) => c.name), ['Wood']);
  assert.deepEqual(out[2], []);
});
