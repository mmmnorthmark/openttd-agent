// build-truck-route helpers on synthetic maps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TileMap } from '../src/world.js';
import { truckStopCandidates, townStopCandidates, roadDepotCandidates, pickTruck, stopConnect } from '../src/truck.js';

const B32 = '0123456789abcdefghijklmnopqrstuv';
function makeMap(n, cls = () => 'b') {
  const m = new TileMap(n, n);
  for (let y = 0; y < n; y++) {
    let s = `${y},0,`;
    for (let x = 0; x < n; x++) s += '02' + B32[0] + cls(x, y);
    m.applyRow(s);
  }
  return m;
}

test('truck stops near an industry face toward the other end', () => {
  const map = makeMap(32, (x, y) => (x >= 10 && x <= 12 && y >= 10 && y <= 12 ? 'i' : 'b'));
  const c = truckStopCandidates(map, { targets: [[10, 10], [12, 12]], catchment: 3, toward: [30, 11] });
  assert.ok(c.length > 0);
  assert.ok(c[0].front_x > c[0].x, JSON.stringify(c[0]));
  assert.ok(c.every((s) => map.classAt(s.x, s.y) === 'b'));
  assert.deepEqual(stopConnect(c[0]), { x: c[0].front_x, y: c[0].front_y });
});

test('town stops: straight road tiles only, nearest the centre first', () => {
  // Road along y=10 from x=5..15 with a junction at (10,10) (road going up from it).
  const map = makeMap(32, (x, y) => ((y === 10 && x >= 5 && x <= 15) || (x === 10 && y >= 6 && y <= 9) ? 'd' : 'b'));
  const c = townStopCandidates(map, { cx: 10, cy: 10, radius: 4 });
  assert.ok(c.length > 0);
  assert.ok(c.every((s) => !(s.x === 10 && s.y === 10)), 'not on the junction');
  assert.equal(c[0].drive_through, true);
  assert.deepEqual(stopConnect(c[0]), { x: c[0].x, y: c[0].y });
});

test('road depot spots beside the path; pickTruck prefers no refit, then capacity per running cost', () => {
  const map = makeMap(16);
  const path = [[2, 2], [3, 2], [4, 2]];
  const d = roadDepotCandidates(map, path, { x: 2, y: 2 });
  assert.ok(d.length > 0);
  assert.ok(!path.some(([x, y]) => x === d[0].x && y === d[0].y));
  assert.equal(Math.abs(d[0].x - d[0].front_x) + Math.abs(d[0].y - d[0].front_y), 1);
  const engines = [{ id: 1, name: 'A', cargo: 7, capacity: 20, running_cost: 400, price: 4000 }, { id: 2, name: 'B', cargo: 3, capacity: 30, running_cost: 300, price: 5000 }];
  assert.equal(pickTruck(engines, { cargoId: 7 }).id, 1);
  assert.equal(pickTruck(engines, { cargoId: 9 }).id, 2);
  assert.throws(() => pickTruck([], { cargoId: 7 }), /no buildable road vehicle/);
});
