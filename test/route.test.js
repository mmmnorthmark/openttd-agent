// Pure parts of build-cargo-route: planning overlays, train choice, orders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TileMap } from '../src/world.js';
import { planPath, terminusSteps, depotCandidates } from '../src/planner.js';
import { overlayMap, terminusCells, pathCells, defaultWagons, pickTrain, routeOrderFlags, oppositeDir } from '../src/route.js';

function flat(n) {
  const m = new TileMap(n, n);
  for (let y = 0; y < n; y++) m.applyRow(`${y},0,${'020b'.repeat(n)}`);
  return m;
}

test('terminusCells: station tiles s, throat r, outermost throat row and connect_at path stay usable', () => {
  const site = { x: 10, y: 10, axis: 'x', exit: 'high', platforms: 2, length: 4 };
  const cells = terminusCells(site);
  assert.equal(cells.get('10,10'), 's');
  assert.equal(cells.get('13,11'), 's');
  assert.equal(cells.get('14,10'), 'r', 'first throat row');
  assert.equal(cells.get('16,10'), 'r', 'connect_at (platforms+1 tiles beyond the platforms)');
  assert.equal(cells.has('17,10'), false, 'outermost row free for the line');
  assert.equal(cells.has('17,11'), false);
  const { connect_at } = terminusSteps({ ...site, exitHigh: true });
  assert.deepEqual([connect_at.x, connect_at.y, connect_at.dir], [16, 10, 'sw']);
});

test('overlayMap: planPath goes round a planned station it would otherwise cross', () => {
  const m = flat(40);
  const direct = planPath(m, { x: 5, y: 20 }, { x: 30, y: 20 });
  assert.ok(direct.tiles.some(([x, y]) => x === 15 && y === 20));
  const cells = terminusCells({ x: 14, y: 19, axis: 'y', exit: 'high', platforms: 2, length: 4 });
  const view = overlayMap(m, cells);
  assert.equal(view.classAt(14, 19), 's');
  assert.equal(view.heightAt(14, 19), 2, 'other reads go to the map');
  assert.equal(m.classAt(14, 19), 'b', 'the map itself is unchanged');
  const round = planPath(view, { x: 5, y: 20 }, { x: 30, y: 20 });
  assert.equal(round.reachable, true);
  assert.ok(round.tiles.every(([x, y]) => !cells.has(`${x},${y}`)));
});

test('pathCells + depotCandidates find a depot beside a line that is only planned', () => {
  const m = flat(40);
  const plan = planPath(m, { x: 5, y: 20 }, { x: 30, y: 20 });
  const cells = pathCells(plan);
  assert.equal(cells.has('5,20'), false, 'anchors get no track');
  assert.equal(cells.get('6,20'), 'r');
  assert.equal(depotCandidates(m, [10, 20]).length, 0);
  const c = depotCandidates(overlayMap(m, cells), [10, 20]);
  assert.ok(c.length > 0);
  assert.equal(c[0].front[1], 20);
});

test('pickTrain: cheapest-to-run powered locomotive, wagon with the cargo first, forced ids checked', () => {
  const engines = [
    { id: 1, name: 'Fast', is_wagon: false, power: 900, running_cost: 3000, price: 20000 },
    { id: 2, name: 'Cheap', is_wagon: false, power: 300, running_cost: 800, price: 9000 },
    { id: 3, name: 'Dead', is_wagon: false, power: 0, running_cost: 1, price: 1 },
    { id: 10, name: 'Refit box', is_wagon: true, cargo: 9, capacity: 40, price: 900 },
    { id: 11, name: 'Ore hopper', is_wagon: true, cargo: 4, capacity: 30, price: 1000 },
  ];
  const t = pickTrain(engines, { cargoId: 4 });
  assert.equal(t.loco.id, 2);
  assert.equal(t.wagon.id, 11);
  assert.equal(pickTrain(engines, { cargoId: 4, engine: 1, wagon: 10 }).loco.id, 1);
  assert.throws(() => pickTrain(engines, { engine: 3 }), /locomotive 3 is not buildable/);
  assert.throws(() => pickTrain(engines.filter((e) => !e.is_wagon), {}), /no buildable wagon/);
});

test('orders, wagons, directions', () => {
  assert.deepEqual(routeOrderFlags({ passengerOrMail: false, fromTown: false, toTown: true }), { source: 96, dest: 132, source_flags: 'full_load_any', dest_flags: 'unload,no_load' });
  assert.equal(routeOrderFlags({ passengerOrMail: true, fromTown: true, toTown: true }).source, 0);
  assert.equal(routeOrderFlags({ passengerOrMail: true, fromTown: false, toTown: true }).source, 96, 'oil rig passengers to a town: one way');
  assert.equal(defaultWagons(4), 7);
  assert.equal(defaultWagons(1), 1);
  assert.equal(oppositeDir('se'), 'nw');
});
