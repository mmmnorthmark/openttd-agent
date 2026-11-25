// Path planner and templates on synthetic maps (no game needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TileMap } from '../src/world.js';
import { planPath, railSteps, roadSteps, terminusSteps, passingLoopSteps } from '../src/planner.js';

const B32 = '0123456789abcdefghijklmnopqrstuv';
/** n x n map; tile(x, y) -> { h, slope, cls } overrides (default flat clear land at height 2). */
function makeMap(n, tile = () => ({})) {
  const m = new TileMap(n, n);
  for (let y = 0; y < n; y++) {
    let s = `${y},0,`;
    for (let x = 0; x < n; x++) {
      const { h = 2, slope = 0, cls = 'b' } = tile(x, y) ?? {};
      s += h.toString(16).padStart(2, '0') + B32[slope] + cls;
    }
    m.applyRow(s);
  }
  return m;
}
const key = (t) => t.join(',');

test('rail on flat land: straight path becomes one rail step between the anchors', () => {
  const plan = planPath(makeMap(32), { x: 5, y: 5 }, { x: 15, y: 5 });
  assert.equal(plan.reachable, true);
  assert.equal(plan.tiles.length, 11);
  assert.equal(plan.stats.turns, 0);
  assert.deepEqual(railSteps(plan), [['rail', 5, 5, 6, 5, 15, 5]]);
});

test('rail goes round houses and never makes a 90 degree corner', () => {
  const map = makeMap(40, (x, y) => (x >= 18 && x <= 22 && y >= 8 && y <= 14 ? { cls: 'o' } : {}));
  const plan = planPath(map, { x: 12, y: 11 }, { x: 28, y: 11 });
  assert.equal(plan.reachable, true);
  for (const [x, y] of plan.tiles) assert.notEqual(map.classAt(x, y), 'o');
  // turn direction per tile: cross product of the step in and the step out
  const turns = [];
  for (let i = 1; i < plan.tiles.length - 1; i++) {
    const [ax, ay] = plan.tiles[i - 1], [bx, by] = plan.tiles[i], [cx, cy] = plan.tiles[i + 1];
    turns.push((bx - ax) * (cy - by) - (by - ay) * (cx - bx));
  }
  for (let i = 1; i < turns.length; i++) assert.ok(turns[i] === 0 || turns[i] !== turns[i - 1], `90 degree corner at ${key(plan.tiles[i + 1])}`);
  // every rail step is a single curve piece or a straight run
  for (const [, fx, fy, tx, ty, ex, ey] of railSteps(plan)) {
    assert.equal(Math.abs(fx - tx) + Math.abs(fy - ty), 1);
    assert.ok(Math.abs(ex - tx) + Math.abs(ey - ty) === 1 || fx === ex || fy === ey);
  }
});

test('rail bridges a river: bridge heads on dry land, rail steps stop at the heads', () => {
  const map = makeMap(40, (x) => (x === 20 || x === 21 ? { cls: 'w', h: 0 } : {}));
  const plan = planPath(map, { x: 14, y: 10 }, { x: 28, y: 10 }, { margin: 4 });
  assert.equal(plan.reachable, true);
  assert.equal(plan.stats.bridges, 1);
  assert.equal(plan.stats.bridge_tiles, 4);
  assert.deepEqual(railSteps(plan, { bridgeType: -2 }), [
    ['rail', 14, 10, 15, 10, 19, 10], ['bridge', 0, 19, 10, 22, 10, -2], ['rail', 22, 10, 23, 10, 28, 10],
  ]);
  assert.equal(planPath(map, { x: 14, y: 10 }, { x: 28, y: 10 }, { margin: 4, maxBridge: 3 }).reachable, false);
});

test('rail climbs an incline straight, and cannot pass a height step without one', () => {
  // x < 10 at height 2, x > 10 at height 3; column 10 is a slope raised on its +x side (W|S corners = 3)
  const hill = (x) => (x < 10 ? {} : x === 10 ? { h: 3, slope: 3 } : { h: 3 });
  const plan = planPath(makeMap(24, hill), { x: 5, y: 8 }, { x: 16, y: 8 });
  assert.equal(plan.reachable, true);
  assert.equal(plan.stats.turns, 0);
  const cliff = (x) => (x < 10 ? {} : { h: 3 });
  assert.equal(planPath(makeMap(24, cliff), { x: 5, y: 8 }, { x: 16, y: 8 }).reachable, false);
});

test('start_dir and end_dir are honoured', () => {
  const plan = planPath(makeMap(32), { x: 10, y: 10 }, { x: 20, y: 10 }, { startDir: 1, endDir: 3 });
  assert.deepEqual(plan.tiles[1], [10, 11]);
  assert.deepEqual(plan.tiles.at(-2), [20, 11]);
});

test('road reuses an existing road and builds straight segments including both ends', () => {
  const map = makeMap(32, (x, y) => (y === 12 && x >= 6 && x <= 20 ? { cls: 'd' } : {}));
  const plan = planPath(map, { x: 6, y: 10 }, { x: 20, y: 10 }, { mode: 'road' });
  assert.ok(plan.tiles.filter(([x, y]) => map.classAt(x, y) === 'd').length >= 10, 'most of the way on the old road');
  const steps = roadSteps(plan);
  assert.deepEqual(steps[0].slice(1, 3), [6, 10]);
  assert.deepEqual(steps.at(-1).slice(3, 5), [20, 10]);
  for (const [op, x1, y1, x2, y2] of steps) { assert.equal(op, 'road'); assert.ok(x1 === x2 || y1 === y2); }
  for (let i = 1; i < steps.length; i++) assert.deepEqual(steps[i].slice(1, 3), steps[i - 1].slice(3, 5));
});

test('terminus: station, one curve ladder per platform, a path signal per platform', () => {
  const t = terminusSteps({ x: 10, y: 10, platforms: 3, length: 4 });
  assert.deepEqual(t.steps[0], ['rail_station', 10, 10, false, 3, 4, -1]);
  assert.deepEqual(t.steps[1], ['rail', 13, 10, 14, 10, 18, 10]);
  assert.deepEqual(t.steps.filter((s) => s[0] === 'signal'), [['signal', 14, 10, 13, 10, 4], ['signal', 14, 11, 13, 11, 4], ['signal', 14, 12, 13, 12, 4]]);
  assert.deepEqual(t.connect_at, { x: 17, y: 10, dir: 'sw' });
  // the last piece of the outer platform joins the exit track
  assert.deepEqual(t.steps.filter((s) => s[0] === 'rail').at(-1), ['rail', 16, 11, 16, 10, 17, 10]);
  const low = terminusSteps({ x: 10, y: 10, axis: 'y', platforms: 2, length: 4, exitHigh: false });
  assert.deepEqual(low.connect_at, { x: 10, y: 7, dir: 'nw' });
});

test('passing loop: main track, loop track with four curve pieces, two one-way path signals', () => {
  const t = passingLoopSteps({ x: 20, y: 20, length: 4 });
  assert.deepEqual(t.steps[0], ['rail', 19, 20, 20, 20, 26, 20]);
  assert.equal(t.steps.filter((s) => s[0] === 'rail').length, 6);
  assert.deepEqual(t.steps.slice(-2), [['signal', 24, 20, 23, 20, 5], ['signal', 21, 21, 22, 21, 5]]);
  assert.deepEqual(t.ends, [{ x: 20, y: 20 }, { x: 25, y: 20 }]);
  assert.throws(() => passingLoopSteps({ x: 1, y: 1, length: 1 }), /at least 2/);
});
