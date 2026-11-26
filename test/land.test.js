// Pure owned-land helpers (src/land.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseRect, checkLandRect, boughtRects, mergeTiles, ownedLandCandidates, MAX_LAND_TILES } from '../src/land.js';
import { TileMap } from '../src/world.js';

test('normaliseRect accepts any two opposite corners', () => {
  const want = { x0: 3, y0: 5, x1: 7, y1: 6, width: 5, height: 2, tiles: 10 };
  assert.deepEqual(normaliseRect({ x0: 3, y0: 5, x1: 7, y1: 6 }), want);
  assert.deepEqual(normaliseRect({ x0: 7, y0: 6, x1: 3, y1: 5 }), want);
  assert.deepEqual(normaliseRect({ x0: 7, y0: 5, x1: 3, y1: 6 }), want);
  assert.deepEqual(normaliseRect({ x0: 3, y0: 6, x1: 7, y1: 5 }), want);
  assert.equal(normaliseRect({ x0: 4, y0: 4, x1: 4, y1: 4 }).tiles, 1);
});

test('checkLandRect caps the area and refuses off-map rectangles', () => {
  assert.equal(MAX_LAND_TILES, 400);
  assert.doesNotThrow(() => checkLandRect(normaliseRect({ x0: 0, y0: 0, x1: 19, y1: 19 }), { sizeX: 64, sizeY: 64 }));
  assert.throws(() => checkLandRect(normaliseRect({ x0: 0, y0: 0, x1: 20, y1: 19 })), /area too large: 21x20 = 420 tiles; purchase-land buys at most 400 tiles per call/);
  assert.throws(() => checkLandRect(normaliseRect({ x0: 60, y0: 0, x1: 64, y1: 2 }), { sizeX: 64, sizeY: 64 }), /outside the map \(64x64\)/);
  assert.throws(() => checkLandRect(normaliseRect({ x0: -1, y0: 0, x1: 2, y1: 2 })), /outside the map/);
});

test('boughtRects: row-by-row purchases as rectangles plus the failed tile', () => {
  const r = normaliseRect({ x0: 10, y0: 20, x1: 13, y1: 22 }); // 4 wide, 12 tiles
  assert.deepEqual(boughtRects(r, 0), { bought: [], next: { x: 10, y: 20 } });
  assert.deepEqual(boughtRects(r, 3), { bought: [[10, 20, 12, 20]], next: { x: 13, y: 20 } });
  assert.deepEqual(boughtRects(r, 4), { bought: [[10, 20, 13, 20]], next: { x: 10, y: 21 } });
  assert.deepEqual(boughtRects(r, 6), { bought: [[10, 20, 13, 20], [10, 21, 11, 21]], next: { x: 12, y: 21 } });
  assert.deepEqual(boughtRects(r, 12), { bought: [[10, 20, 13, 22]], next: null });
});

test('mergeTiles joins runs into rectangles', () => {
  assert.deepEqual(mergeTiles([]), []);
  const block = [];
  for (let y = 5; y <= 7; y++) for (let x = 2; x <= 4; x++) block.push([x, y]);
  assert.deepEqual(mergeTiles(block.reverse()), [[2, 5, 4, 7]]);
  // an L shape, a lone tile, and a gap row
  const tiles = [[0, 0], [1, 0], [0, 1], [9, 9], [0, 3], [1, 3]];
  assert.deepEqual(mergeTiles(tiles), [[0, 0, 1, 0], [0, 1, 0, 1], [0, 3, 1, 3], [9, 9, 9, 9]]);
  const count = (rs) => rs.reduce((n, [a, b, c, d]) => n + (c - a + 1) * (d - b + 1), 0);
  assert.equal(count(mergeTiles(tiles)), tiles.length);
});

test('ownedLandCandidates lists mirror object tiles inside the rectangle', () => {
  const map = new TileMap(4, 2);
  map.applyRow('0,0,020b020o020b020o');
  map.applyRow('1,0,020w020o020b020b');
  assert.deepEqual(ownedLandCandidates(map, { x0: 0, y0: 0, x1: 2, y1: 5 }), [[1, 0], [1, 1]]);
});
