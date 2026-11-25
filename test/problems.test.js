// vehicle-problems checks (src/problems.js): progress history and the problem rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordProgress, vehicleProblems } from '../src/problems.js';

const train = (over = {}) => ({ id: 31, unit_number: 4, type: 'rail', state: 'running', x: 22, y: 7, order_count: 2, current_order: 0,
  dest: { x: 10, y: 10 }, dest_station: 4, dest_name: 'North', dist: 15, speed: 50, age_days: 400, age_pct: 20,
  reliability_pct: 80, profit_last_year: 500, ...over });

test('recordProgress: same order and no closer for N days = no progress; a new order or a new best resets', () => {
  const h = new Map();
  recordProgress(h, 'v', { date: 100, order: 0, dist: 20 });
  assert.equal(recordProgress(h, 'v', { date: 110, order: 0, dist: 25 }).since, 100, 'further away: no progress');
  assert.equal(recordProgress(h, 'v', { date: 120, order: 0, dist: 18 }).since, 120, 'closer than ever: progress');
  assert.equal(recordProgress(h, 'v', { date: 130, order: 0, dist: 19 }).since, 120);
  assert.equal(recordProgress(h, 'v', { date: 140, order: 1, dist: 40 }).since, 140, 'next order: progress');
  assert.equal(recordProgress(h, 'v', { date: 150, order: 1, dist: 40, atStation: true }).since, 150, 'loading at a station is not lost');
  const e = h.get('v');
  assert.equal(e.first, 100);
  assert.equal(e.samples, 6);
});

test('vehicleProblems: a healthy train has none', () => {
  assert.deepEqual(vehicleProblems(train(), { today: 200, progress: { since: 190, best: 15 } }), []);
});

test('vehicleProblems: lost train on another line, without income', () => {
  const v = train({ profit_last_year: -863, age_days: 1000 });
  const reach = { connected: false, method: 'rail_tracks', last_reachable: { x: 22, y: 10 }, first_gap: { x: 21, y: 10, reason: 'depot_entrance_faces_away' } };
  const out = vehicleProblems(v, { today: 300, stuckDays: 30, progress: { since: 250, best: 12 }, reach, line: { connected: true } });
  assert.deepEqual(out.map((p) => p.problem), ['wrong_network', 'stuck_or_lost', 'no_income']);
  assert.match(out[0].evidence, /North \(10,10\).*ends at \(22,10\).*\(21,10\) \(depot_entrance_faces_away\)/);
  assert.match(out[0].suggested_fix, /vehicle-depot --vehicles 31/);
  assert.match(out[1].evidence, /50 days without getting closer than 12 tiles/);
  assert.match(out[2].suggested_fix, /fix the problems above first/);
});

test('vehicleProblems: broken line, idle and old vehicles', () => {
  const broken = vehicleProblems(train(), { today: 10, reach: { connected: false, method: 'mirror_adjacency' }, line: { connected: false } });
  assert.deepEqual(broken.map((p) => p.problem), ['unreachable_destination']);
  assert.match(broken[0].evidence, /coarse/);
  assert.deepEqual(vehicleProblems(train({ order_count: 0, state: 'in_depot' }), { today: 10 }).map((p) => p.problem), ['no_orders', 'stopped_in_depot']);
  assert.deepEqual(vehicleProblems(train({ age_pct: 104, reliability_pct: 30 }), { today: 10 }).map((p) => p.problem), ['old', 'low_reliability']);
  assert.deepEqual(vehicleProblems(train({ state: 'broken' }), { today: 10 }).map((p) => p.problem), ['broken_down']);
  const waiting = vehicleProblems(train({ speed: 0 }), { today: 100, stuckDays: 30, progress: { since: 40, best: 3 } });
  assert.match(waiting[0].suggested_fix, /red signal/);
});
