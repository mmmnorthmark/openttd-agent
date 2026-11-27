// Rail connectivity tracer (src/connectivity.js) on hand-made rail_tiles data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceRail, adjacencyTrace, mirrorStationTiles, trackExits, entryRefusal, findLoops } from '../src/connectivity.js';
import { TileMap } from '../src/world.js';

const X = 1, Y = 2, NW_NE = 4, SW_SE = 8, NW_SW = 16, NE_SE = 32;

/** Build a getter from tile specs: [x, y, kind, tracks, station, a, b, owner, signals]. */
function world(specs) {
  const m = new Map();
  for (const [x, y, kind, tracks, station = -1, a = -1, b = -1, owner = 0, signals = 0] of specs) {
    m.set(`${x},${y}`, { x, y, kind, tracks, station, a, b, owner, rail_type: 0, signals });
  }
  return (x, y) => m.get(`${x},${y}`) ?? null;
}
/** Straight x-axis track from x0 to x1 on row y. */
const row = (x0, x1, y, kind = 't', station = -1) => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y, kind, X, station]);

const goalStation = (id) => (t) => t.station === id;

test('track pieces: exits follow the piece, entry edges are checked', () => {
  assert.deepEqual(trackExits(X, 2), [0], 'enter from -x, leave to +x');
  assert.deepEqual(trackExits(X | NE_SE, 2).sort(), [0, 1], 'switch: straight on or right');
  assert.deepEqual(trackExits(Y, 0), [], 'x-side of a y track: no way through');
  assert.equal(entryRefusal({ kind: 't', tracks: Y, owner: 0, signals: 0 }, 0), 'track_not_joined');
  assert.equal(entryRefusal({ kind: 't', tracks: X, owner: 1, signals: 0 }, 0, 0), 'other_company_track');
  assert.equal(entryRefusal(null, 0), 'no_track');
});

test('traceRail: a straight line joins two stations', async () => {
  const getTile = world([...row(2, 4, 5, 's', 1), ...row(5, 20, 5), ...row(21, 23, 5, 's', 2)]);
  const r = await traceRail({ getTile, starts: [{ x: 3, y: 5 }], isGoal: goalStation(2), goal: { x: 22, y: 5 } });
  assert.equal(r.connected, true);
  assert.deepEqual(r.reached, { x: 21, y: 5 });
});

test('traceRail: a missing piece reports the last reachable tile and the gap', async () => {
  const getTile = world([...row(2, 4, 5, 's', 1), ...row(5, 11, 5), ...row(13, 20, 5), ...row(21, 23, 5, 's', 2)]);
  const r = await traceRail({ getTile, starts: [{ x: 3, y: 5 }], isGoal: goalStation(2), goal: { x: 22, y: 5 } });
  assert.equal(r.connected, false);
  assert.deepEqual(r.last_reachable, { x: 11, y: 5 });
  assert.deepEqual(r.first_gap, { x: 12, y: 5, from: { x: 11, y: 5 }, reason: 'no_track' });
});

test('traceRail: track that touches but does not join (crossing at right angles)', async () => {
  // The y-axis line crosses x=10 at (10,5) as a diamond: x and y pieces on one tile, so no turn there.
  const getTile = world([...row(2, 4, 5, 's', 1), ...row(5, 9, 5), [10, 5, 't', X | Y], ...row(11, 15, 5),
    [10, 6, 't', Y], [10, 7, 't', Y], [10, 8, 's', Y, 2]]);
  const r = await traceRail({ getTile, starts: [{ x: 3, y: 5 }], isGoal: goalStation(2), goal: { x: 10, y: 8 } });
  assert.equal(r.connected, false, 'no curve piece, so the train cannot turn onto the y line');
  const joined = world([...row(2, 4, 5, 's', 1), ...row(5, 9, 5), [10, 5, 't', X | Y | NE_SE], [10, 6, 't', Y], [10, 7, 't', Y], [10, 8, 's', Y, 2]]);
  assert.equal((await traceRail({ getTile: joined, starts: [{ x: 3, y: 5 }], isGoal: goalStation(2), goal: { x: 10, y: 8 } })).connected, true);
});

test('traceRail: a one-way path signal facing the wrong way blocks the line', async () => {
  // Signal on (10,5) facing trains from +x (bit 0, as GSRail.GetSignalType(tile, front = (11,5))): trains
  // heading -x pass it; trains heading +x come from behind.
  const specs = [...row(2, 4, 5, 's', 1), ...row(5, 9, 5), [10, 5, 't', X, -1, -1, -1, 0, 1 << 0], ...row(11, 20, 5), ...row(21, 23, 5, 's', 2)];
  const getTile = world(specs);
  const west = await traceRail({ getTile, starts: [{ x: 22, y: 5 }], isGoal: goalStation(1), goal: { x: 3, y: 5 } });
  assert.equal(west.connected, true);
  const east = await traceRail({ getTile, starts: [{ x: 3, y: 5 }], isGoal: goalStation(2), goal: { x: 22, y: 5 } });
  assert.equal(east.connected, false);
  assert.deepEqual(east.first_gap, { x: 10, y: 5, from: { x: 9, y: 5 }, reason: 'one_way_signal_against' });
});

test('traceRail: out of a depot, to a dead end, reverse, then on to the station', async () => {
  // Depot (7,4) faces (7,5); its join piece only leads +x (NW_SW), toward a dead end at (10,5).
  const getTile = world([...row(2, 4, 5, 's', 1), ...row(5, 6, 5), [7, 5, 't', X | NW_SW], ...row(8, 10, 5), [7, 4, 'd', 0, -1, 7, 5]]);
  const r = await traceRail({ getTile, starts: [{ x: 7, y: 4 }], isGoal: goalStation(1), goal: { x: 3, y: 5 } });
  assert.equal(r.connected, true);
  const facesAway = world([...row(5, 10, 5), [7, 4, 'd', 0, -1, 7, 3]]);
  const r2 = await traceRail({ getTile: facesAway, starts: [{ x: 6, y: 5 }], isGoal: (t) => t.kind === 'd', goal: { x: 7, y: 4 } });
  assert.equal(r2.connected, false);
});

test('traceRail: a bridge carries the line over a gap; entering it from the side does not', async () => {
  const getTile = world([...row(2, 4, 5, 's', 1), ...row(5, 8, 5), [9, 5, 'b', 0, -1, 14, 5], [14, 5, 'b', 0, -1, 9, 5],
    ...row(15, 20, 5), ...row(21, 23, 5, 's', 2)]);
  const r = await traceRail({ getTile, starts: [{ x: 3, y: 5 }], isGoal: goalStation(2), goal: { x: 22, y: 5 } });
  assert.equal(r.connected, true);
  assert.equal(entryRefusal({ x: 9, y: 5, kind: 'b', a: 14, b: 5, owner: 0 }, 1), 'bridge_side');
});

test('adjacencyTrace: coarse flood over rail and station tiles, guessing bridges', () => {
  const m = new TileMap(32, 32);
  for (let y = 0; y < 32; y++) {
    let r = `${y},0,`;
    for (let x = 0; x < 32; x++) {
      let c = 'b';
      if (y === 5 && x >= 2 && x <= 4) c = 's';
      else if (y === 5 && x >= 5 && x <= 20) c = 'r';
      else if (y === 5 && (x === 21 || x === 25)) c = 'o'; // bridge heads
      else if (y === 5 && x >= 26 && x <= 28) c = 's';
      r += '010' + c;
    }
    m.applyRow(r);
  }
  const goal = mirrorStationTiles(m, 26, 5);
  assert.equal(goal.length, 3);
  assert.equal(adjacencyTrace(m, [{ x: 3, y: 5 }], goal, { x: 27, y: 5 }).connected, true);
  m.cls[m.idx(12, 5)] = m.cls[m.idx(0, 0)];
  const r = adjacencyTrace(m, [{ x: 3, y: 5 }], goal, { x: 27, y: 5 });
  assert.equal(r.connected, false);
  assert.deepEqual(r.last_reachable, { x: 11, y: 5 });
  assert.equal(r.first_gap.x, 12);
});

test('road gap reasons: one-way, depot and stop entrances, missing road', async () => {
  const { roadGapReason, traceRoad } = await import('../src/connectivity.js');
  const road = (x, y, links, extra = {}) => ({ x, y, kind: 'r', links, station: -1, a: -1, b: -1, owner: 0, ...extra });
  assert.equal(roadGapReason(road(0, 0, 0), 0, null), 'no_road');
  assert.equal(roadGapReason(road(0, 0, 0), 0, road(1, 0, 4)), 'one_way_road');
  assert.equal(roadGapReason(road(0, 0, 0), 0, road(1, 0, 0, { kind: 's', a: 1, b: 1 })), 'stop_entrance_faces_away');
  assert.equal(roadGapReason(road(0, 0, 0), 0, road(1, 0, 0, { kind: 'd', a: 0, b: 0 })), 'depot_not_joined');
  assert.equal(roadGapReason(road(0, 0, 0, { kind: 'd', a: 1, b: 0 }), 0, road(1, 0, 0)), 'depot_not_joined');
  // Another company's stop is not driven through.
  const tiles = new Map([[`0,0`, road(0, 0, 1)], [`1,0`, road(1, 0, 5, { kind: 't', station: 9, owner: 3 })], [`2,0`, road(2, 0, 4, { kind: 's', station: 8, a: 1, b: 0 })]]);
  const r = await traceRoad({ getTile: (x, y) => tiles.get(`${x},${y}`) ?? null, starts: [{ x: 0, y: 0 }], isGoal: (t) => t.station === 8, goal: { x: 2, y: 0 }, company: 0 });
  assert.deepEqual([r.connected, r.first_gap.reason], [false, 'other_owner_road']);
});

/** A line station 1 (2..4,5) - track (5..30,5) - station 2 (31..33,5) with a build-passing-loop loop: points (9,5) and (16,5), lane (9..16,6). */
function loopLine({ signals = true, lane = true } = {}) {
  const specs = [...row(2, 4, 5, 's', 1), ...row(5, 30, 5), ...row(31, 33, 5, 's', 2)];
  const set = (x, y, tracks, signal = 0) => { const i = specs.findIndex((q) => q[0] === x && q[1] === y); const t = [x, y, 't', tracks, -1, -1, -1, 0, signal]; if (i >= 0) specs[i] = t; else specs.push(t); };
  if (lane) {
    set(9, 5, X | NE_SE); set(16, 5, X | SW_SE);
    set(9, 6, NW_SW); for (let x = 10; x <= 15; x++) set(x, 6, X, signals && x === 11 ? 0x11 : 0); set(16, 6, NW_NE);
    if (signals) set(15, 5, X, 0x44);
  }
  return specs;
}

test('findLoops: a real passing loop, its clear tiles and signals; throats and spurs are not loops', async () => {
  const trace = async (specs) => {
    const getTile = world(specs);
    const r = await traceRail({ getTile, starts: [{ x: 3, y: 5 }], isGoal: goalStation(2), goal: { x: 32, y: 5 } });
    assert.equal(r.connected, true);
    return findLoops({ path: r.path, getTile });
  };
  const [loop, ...rest] = await trace(loopLine());
  assert.equal(rest.length, 0);
  assert.deepEqual([loop.at, loop.end, loop.line_tiles, loop.branch_tiles, loop.clear_tiles, loop.signals_ok], [{ x: 9, y: 5 }, { x: 16, y: 5 }, 6, 8, 5, true]);
  const bare = await trace(loopLine({ signals: false }));
  assert.deepEqual([bare.length, bare[0].signals_ok, bare[0].line_signal], [1, false, false]);
  // A spur to a dead end (or a depot) and a second platform of a terminus never rejoin the line.
  const spur = loopLine({ lane: false });
  spur.splice(spur.findIndex((q) => q[0] === 20 && q[1] === 5), 1, [20, 5, 't', X | NE_SE]);
  spur.push([20, 6, 't', Y], [20, 7, 'd', 0, -1, 20, 6]);
  assert.deepEqual(await trace(spur), []);
});
